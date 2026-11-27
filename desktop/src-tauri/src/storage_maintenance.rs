//! Local housekeeping. A preview authorizes specific kinds and file snapshots, never paths from IPC.
mod files;
#[cfg(test)]
mod tests;
mod volume;

pub(crate) use files::{
    inspect, measure_backup, plain_directory, plan_cleanup, regular_file, Inventory, StoragePaths,
};
pub(crate) use volume::measure_volume;

use chrono::{DateTime, Days, Local, NaiveDateTime, NaiveTime};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, AtomicI64},
};
use uuid::Uuid;

pub(crate) const GIB: u64 = 1024 * 1024 * 1024;
pub(crate) const SCRATCH_FOLDER: &str = "maintenance-scratch";
const RECORD_LIMIT: usize = 30;
const DB_KEY: &str = "local_storage_maintenance";

pub struct StorageRuntime {
    pub(crate) gate: tokio::sync::Mutex<Option<files::Plan>>,
    pub(crate) generation: Uuid,
    pub(crate) last_reminder_probe: AtomicI64,
    pub pending_navigation: AtomicBool,
}

impl Default for StorageRuntime {
    fn default() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(None),
            generation: Uuid::new_v4(),
            last_reminder_probe: AtomicI64::new(0),
            pending_navigation: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StoragePolicy {
    pub auto_clean: bool,
    pub daily_time: String,
    pub disk_alert: bool,
    pub min_free_gb: u32,
    pub backup_alert: bool,
    pub backup_limit_gb: u32,
}

impl Default for StoragePolicy {
    fn default() -> Self {
        Self {
            auto_clean: true,
            daily_time: "09:00".into(),
            disk_alert: true,
            min_free_gb: 2,
            backup_alert: true,
            backup_limit_gb: 2,
        }
    }
}

impl StoragePolicy {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.daily_time.len() != 5
            || NaiveTime::parse_from_str(&self.daily_time, "%H:%M").is_err()
        {
            return Err("请输入有效的每日执行时间".into());
        }
        if !(1..=10_000).contains(&self.min_free_gb)
            || !(1..=10_000).contains(&self.backup_limit_gb)
        {
            return Err("空间提醒阈值须为 1 至 10000 GB".into());
        }
        Ok(())
    }

    pub(crate) fn scheduled_slot(&self, now: DateTime<Local>) -> Option<NaiveDateTime> {
        if !self.auto_clean {
            return None;
        }
        let time = NaiveTime::parse_from_str(&self.daily_time, "%H:%M").ok()?;
        let date = if now.time() >= time {
            now.date_naive()
        } else {
            now.date_naive().checked_sub_days(Days::new(1))?
        };
        Some(date.and_time(time))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupKind {
    Audit,
    Journal,
    Relay,
    Update,
    Temp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageGroup {
    Backup,
    Logs,
    Update,
    Temp,
    Data,
}

impl CleanupKind {
    pub(crate) fn group(self) -> StorageGroup {
        match self {
            Self::Audit | Self::Journal | Self::Relay => StorageGroup::Logs,
            Self::Update => StorageGroup::Update,
            Self::Temp => StorageGroup::Temp,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    pub kind: CleanupKind,
    pub bytes: u64,
    pub count: u64,
    pub retention_days: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupUsage {
    pub group: StorageGroup,
    pub used_bytes: u64,
    pub eligible_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeUsage {
    pub label: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupSource {
    Manual,
    Scheduled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupIssue {
    pub kind: CleanupKind,
    pub count: u64,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRun {
    pub at: String,
    pub source: CleanupSource,
    pub freed_bytes: u64,
    pub removed_count: u64,
    pub skipped: Vec<CleanupIssue>,
    pub recorded: bool,
}

impl CleanupRun {
    pub(crate) fn new(source: CleanupSource) -> Self {
        Self {
            at: Local::now().to_rfc3339(),
            source,
            freed_bytes: 0,
            removed_count: 0,
            skipped: Vec::new(),
            recorded: true,
        }
    }

    pub(crate) fn skip(&mut self, kind: CleanupKind, count: u64, reason: String) {
        if let Some(issue) = self
            .skipped
            .iter_mut()
            .find(|entry| entry.kind == kind && entry.reason == reason)
        {
            issue.count += count;
        } else {
            self.skipped.push(CleanupIssue {
                kind,
                count,
                reason,
            });
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct Persisted {
    pub policy: StoragePolicy,
    pub last_slot: Option<NaiveDateTime>,
    pub history: Vec<CleanupRun>,
    pub disk_alert_at: Option<i64>,
    pub backup_alert_at: Option<i64>,
}

impl Persisted {
    pub(crate) fn load(db: &Connection) -> Result<Self, String> {
        use rusqlite::OptionalExtension;
        let raw: Option<String> = db
            .query_row("SELECT value FROM config WHERE key = ?1", [DB_KEY], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|error| format!("读取维护设置失败：{error}"))?;
        raw.map_or(Ok(Self::default()), |raw| {
            serde_json::from_str(&raw).map_err(|error| format!("读取维护记录失败：{error}"))
        })
    }

    pub(crate) fn save(&self, db: &Connection) -> Result<(), String> {
        let data = serde_json::to_string(self).map_err(|error| error.to_string())?;
        crate::db::set_config_value(db, DB_KEY, &data)
    }

    pub(crate) fn record(&mut self, run: CleanupRun) {
        self.history.insert(0, run);
        self.history.truncate(RECORD_LIMIT);
    }
}

pub(crate) fn alert_due(last: Option<i64>, now: i64) -> bool {
    last.is_none_or(|last| now.saturating_sub(last) >= 86_400 || now < last)
}

pub(crate) fn scratch_name(generation: Uuid, extension: &str) -> String {
    format!(
        "clip_{}_{}.{}",
        generation.simple(),
        Uuid::new_v4().simple(),
        extension
    )
}

pub(crate) fn scratch_owner(path: &Path) -> Option<Uuid> {
    let (stem, extension) = path.file_name()?.to_str()?.split_once('.')?;
    if extension.is_empty() || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    let (owner, file) = stem.strip_prefix("clip_")?.split_once('_')?;
    if owner.len() != 32 || file.len() != 32 {
        return None;
    }
    Uuid::parse_str(file).ok()?;
    Uuid::parse_str(owner).ok()
}
