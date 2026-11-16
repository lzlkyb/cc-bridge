//! Identity and protocol for the lease attached to a managed SSH forwarding connection.
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use uuid::Uuid;

pub(crate) const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
pub(crate) const GUARD_START_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const PROTOCOL_PREFIX: &str = "CCB_TUNNEL_";
const SCRIPT: &str = include_str!("stable_remote/tunnel_guard.py");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GuardReceipt {
    pub version: u8,
    pub owner: String,
    pub nonce: String,
    pub port: u16,
    pub boot_id: String,
    pub uid: u32,
    pub pid: u32,
    pub start_ticks: u64,
    pub guard_pid: u32,
    pub guard_start_ticks: u64,
}

impl GuardReceipt {
    fn valid(&self) -> bool {
        self.version == 1
            && self.port > 0
            && self.pid > 1
            && self.guard_pid > 1
            && self.pid != self.guard_pid
            && self.start_ticks > 0
            && self.guard_start_ticks > 0
            && [&self.owner, &self.nonce, &self.boot_id]
                .iter()
                .all(|value| Uuid::parse_str(value).is_ok())
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct GuardAttempt {
    pub owner: String,
    pub nonce: String,
    pub port: u16,
}

impl GuardAttempt {
    pub fn command(&self) -> String {
        remote_command("serve", &serde_json::to_value(self).unwrap())
    }

    pub fn accepts(&self, receipt: &GuardReceipt) -> bool {
        receipt.valid()
            && receipt.owner == self.owner
            && receipt.nonce == self.nonce
            && receipt.port == self.port
    }

    pub fn heartbeat(&self) -> Vec<u8> {
        let enter = if cfg!(windows) { '\r' } else { '\n' };
        format!("CCB_TUNNEL_PING {}{enter}", self.nonce).into_bytes()
    }
}

pub(crate) struct ManagedGuard {
    path: PathBuf,
    owner: String,
    port: u16,
    previous: Mutex<Option<GuardReceipt>>,
}

impl ManagedGuard {
    pub fn new(data_dir: &Path, server_scope: &[u8], port: u16) -> Self {
        let mut hash = Sha256::new();
        hash.update(server_scope);
        hash.update(port.to_le_bytes());
        let path = data_dir
            .join("ssh_tunnel_sessions")
            .join(format!("{:x}.json", hash.finalize()));
        let previous = read_receipt(&path).filter(|record| record.valid() && record.port == port);
        Self {
            path,
            owner: Uuid::new_v4().to_string(),
            port,
            previous: Mutex::new(previous),
        }
    }

    pub fn attempt(&self) -> GuardAttempt {
        GuardAttempt {
            owner: self.owner.clone(),
            nonce: Uuid::new_v4().to_string(),
            port: self.port,
        }
    }

    pub fn previous(&self) -> Option<GuardReceipt> {
        self.previous
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn remember(&self, attempt: &GuardAttempt, receipt: GuardReceipt) -> Result<(), String> {
        if !attempt.accepts(&receipt) || attempt.owner != self.owner {
            return Err("无法确认当前隧道的恢复身份，请重试。".into());
        }
        let mut previous = self.previous.lock().unwrap_or_else(|p| p.into_inner());
        let parent = self.path.parent().unwrap();
        fs::create_dir_all(parent).map_err(cache_error)?;
        reject_symlink(parent)?;
        reject_symlink(&self.path)?;
        let data = serde_json::to_vec(&receipt).map_err(|_| cache_error("invalid identity"))?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&self.path).map_err(cache_error)?;
        file.write_all(&data).map_err(cache_error)?;
        file.sync_data().map_err(cache_error)?;
        *previous = Some(receipt);
        Ok(())
    }

    pub fn forget(&self, receipt: &GuardReceipt) -> Result<(), String> {
        let mut previous = self.previous.lock().unwrap_or_else(|p| p.into_inner());
        // An old attempt must never remove the receipt already written by its replacement.
        if previous.as_ref() != Some(receipt) {
            return Ok(());
        }
        if read_receipt(&self.path).as_ref() == Some(receipt) {
            fs::remove_file(&self.path).map_err(cache_error)?;
        }
        *previous = None;
        Ok(())
    }
}

fn read_receipt(path: &Path) -> Option<GuardReceipt> {
    if fs::symlink_metadata(path.parent()?)
        .ok()?
        .file_type()
        .is_symlink()
        || !fs::symlink_metadata(path).ok()?.is_file()
    {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(4097)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(cache_error("unexpected symbolic link"));
    }
    Ok(())
}

fn cache_error(error: impl std::fmt::Display) -> String {
    format!("无法保存隧道恢复信息：{error}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ReclaimResult {
    Released,
    Gone,
    Unverified,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ReclaimReply {
    pub nonce: String,
    pub result: ReclaimResult,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GuardError {
    pub nonce: String,
    pub code: String,
}

pub(crate) enum GuardFrame {
    Ready(GuardReceipt),
    Reclaimed(ReclaimReply),
    Error(GuardError),
}

impl GuardFrame {
    pub fn parse(line: &str) -> Option<Result<Self, String>> {
        let line = line.trim();
        let parse = || -> Result<Self, serde_json::Error> {
            if let Some(data) = line.strip_prefix("CCB_TUNNEL_GUARD_READY ") {
                serde_json::from_str(data).map(Self::Ready)
            } else if let Some(data) = line.strip_prefix("CCB_TUNNEL_RECLAIM_RESULT ") {
                serde_json::from_str(data).map(Self::Reclaimed)
            } else if let Some(data) = line.strip_prefix("CCB_TUNNEL_GUARD_ERROR ") {
                serde_json::from_str(data).map(Self::Error)
            } else {
                unreachable!()
            }
        };
        if ![
            "CCB_TUNNEL_GUARD_READY ",
            "CCB_TUNNEL_RECLAIM_RESULT ",
            "CCB_TUNNEL_GUARD_ERROR ",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix))
        {
            return None;
        }
        if line.len() > 4096 {
            return Some(Err("隧道恢复程序返回了无效的身份，请重试。".into()));
        }
        Some(parse().map_err(|_| "无法读取隧道恢复程序返回的身份，请重试。".into()))
    }
}

pub(crate) fn reclaim_command(receipt: &GuardReceipt) -> (String, String) {
    let nonce = Uuid::new_v4().to_string();
    let payload = serde_json::json!({"nonce": nonce, "receipt": receipt});
    (remote_command("reclaim", &payload), nonce)
}

fn remote_command(mode: &str, payload: &serde_json::Value) -> String {
    let source = base64::engine::general_purpose::STANDARD.encode(SCRIPT);
    let payload = base64::engine::general_purpose::STANDARD.encode(payload.to_string());
    // Only base64 and fixed operation names enter shell syntax; no credentials are included.
    format!("python3 -u -c 'import base64;exec(base64.b64decode(\"{source}\"))' {mode} '{payload}'")
}

#[cfg(test)]
#[path = "ssh_tunnel_guard_tests.rs"]
mod tests;
