use super::{
    scratch_owner, CleanupItem, CleanupKind, CleanupRun, CleanupSource, GroupUsage, StorageGroup,
    VolumeUsage, SCRATCH_FOLDER,
};
use crate::{
    audit,
    commands::{update, update_cache},
    relay::log::DISK_RETENTION_DAYS as RELAY_DAYS,
};
use chrono::{Days, Local, NaiveDate};
use std::{
    fs::{self, Metadata},
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};
use uuid::Uuid;

const TEMP_DAYS: u32 = 7;
const PREVIEW_LIFETIME: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub(crate) struct StoragePaths {
    pub data: PathBuf,
    pub webview: Option<PathBuf>,
    pub backup: PathBuf,
    pub version: semver::Version,
    pub generation: Uuid,
    pub audit_days: u32,
    pub journal_days: u32,
}

pub(crate) struct Inventory {
    pub groups: Vec<GroupUsage>,
    pub volume: Option<VolumeUsage>,
    pub warnings: Vec<String>,
}

enum Candidates {
    Audit(chrono::DateTime<Local>, audit::AuditCleanup),
    Files(Vec<FileMark>),
}

struct Batch {
    item: CleanupItem,
    candidates: Candidates,
}

pub(crate) struct Plan {
    pub token: Uuid,
    created: Instant,
    batches: Vec<Batch>,
    unavailable: Vec<(CleanupKind, String)>,
}

#[derive(PartialEq, Eq, Hash)]
struct FileMark {
    path: PathBuf,
    bytes: u64,
    changed: SystemTime,
    created: Option<SystemTime>,
}

fn plain(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        } // FILE_ATTRIBUTE_REPARSE_POINT
    }
    !meta.file_type().is_symlink()
}

fn metadata(path: &Path) -> io::Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(plain(&meta).then_some(meta)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) fn regular_file(path: &Path) -> io::Result<Option<Metadata>> {
    Ok(metadata(path)?.filter(Metadata::is_file))
}

pub(crate) fn plain_directory(path: &Path) -> io::Result<bool> {
    Ok(metadata(path)?.is_some_and(|meta| meta.is_dir()))
}

impl FileMark {
    fn capture(path: PathBuf) -> io::Result<Option<Self>> {
        regular_file(&path)?
            .map(|meta| {
                Ok(Self {
                    path,
                    bytes: meta.len(),
                    changed: meta.modified()?,
                    created: meta.created().ok(),
                })
            })
            .transpose()
    }
}

fn visit(path: &Path, mut callback: impl FnMut(PathBuf) -> io::Result<()>) -> io::Result<()> {
    if !plain_directory(path)? {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        callback(entry?.path())?;
    }
    Ok(())
}

fn tree_bytes(root: &Path, skip: &[&Path], backup: Option<&Path>) -> (u64, bool) {
    let mut total = 0u64;
    let mut incomplete = false;
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let read = visit(&dir, |path| {
            if skip.contains(&path.as_path()) {
                return Ok(());
            }
            match metadata(&path) {
                Ok(Some(meta)) if meta.is_dir() => pending.push(path),
                Ok(Some(meta))
                    if meta.is_file()
                        && !backup
                            .is_some_and(|dir| path.parent() == Some(dir) && is_backup(&path)) =>
                {
                    total = total.saturating_add(meta.len());
                }
                Err(_) => incomplete = true,
                _ => {}
            }
            Ok(())
        });
        incomplete |= read.is_err();
    }
    (total, incomplete)
}

pub(crate) fn measure_backup(path: &Path) -> io::Result<u64> {
    let mut total = 0u64;
    // Users can point the backup directory at a junction or a mounted disk. This is
    // read-only accounting; links inside that directory still do not count as backups.
    let normalized = path.canonicalize().ok();
    visit(normalized.as_deref().unwrap_or(path), |file| {
        if is_backup(&file) {
            total = total.saturating_add(size(&file)?);
        }
        Ok(())
    })?;
    Ok(total)
}

fn is_backup(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "bak")
}

fn size(path: &Path) -> io::Result<u64> {
    Ok(regular_file(path)?.map_or(0, |meta| meta.len()))
}

fn dated_files(
    dir: &Path,
    prefix: &str,
    first: Option<NaiveDate>,
) -> io::Result<(u64, Vec<FileMark>)> {
    let mut bytes = 0u64;
    let mut candidates = Vec::new();
    visit(dir, |path| {
        let day = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(prefix))
            .and_then(|name| name.strip_suffix(".jsonl"))
            .filter(|name| name.len() == 8)
            .and_then(|day| NaiveDate::parse_from_str(day, "%Y%m%d").ok());
        if let (Some(day), Some(file)) = (day, FileMark::capture(path)?) {
            bytes = bytes.saturating_add(file.bytes);
            if first.is_some_and(|first| day < first) {
                candidates.push(file);
            }
        }
        Ok(())
    })?;
    Ok((bytes, candidates))
}

fn scratch_files(paths: &StoragePaths) -> io::Result<(u64, Vec<FileMark>)> {
    let mut total = 0u64;
    let mut candidates = Vec::new();
    let now = SystemTime::now();
    visit(&paths.data.join(SCRATCH_FOLDER), |path| {
        if let (Some(owner), Some(file)) = (scratch_owner(&path), FileMark::capture(path)?) {
            total = total.saturating_add(file.bytes);
            // Current-process images can be passed to an SSH upload at any time. Age alone
            // would race a paused operation or an unusually long upload.
            if owner != paths.generation
                && now
                    .duration_since(file.changed)
                    .is_ok_and(|age| age >= Duration::from_secs(86_400 * u64::from(TEMP_DAYS)))
            {
                candidates.push(file);
            }
        }
        Ok(())
    })?;
    Ok((total, candidates))
}

fn update_files(paths: &StoragePaths, allow_cleanup: bool) -> io::Result<(u64, Vec<FileMark>)> {
    let package = update_cache::package_path(&paths.data);
    let manifest = package.with_extension("manifest.json");
    let cache = [
        package.clone(),
        manifest.clone(),
        package.with_extension("part"),
        package.with_extension("tmp"),
        package.with_extension("manifest.tmp"),
        paths.data.join("update-policy.json"),
    ];
    let mut bytes = 0u64;
    let mut candidates = Vec::new();
    let obsolete = allow_cleanup
        && regular_file(&package)?.is_some()
        && regular_file(&manifest)?.is_some()
        && update_cache::obsolete_package(&package, &paths.version);
    for path in cache {
        if let Some(file) = FileMark::capture(path)? {
            bytes = bytes.saturating_add(file.bytes);
            let stale_sidecar = file.path.extension().is_some_and(|ext| ext == "tmp")
                && file
                    .changed
                    .elapsed()
                    .is_ok_and(|age| age >= Duration::from_secs(86_400));
            if allow_cleanup
                && (stale_sidecar || obsolete && (file.path == package || file.path == manifest))
            {
                candidates.push(file);
            }
        }
    }
    visit(&paths.data, |file| {
        if is_installer(&file) {
            bytes = bytes.saturating_add(size(&file)?);
        }
        Ok(())
    })?;
    Ok((bytes, candidates))
}

fn is_installer(file: &Path) -> bool {
    file.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("ccbridge-update-") && name.ends_with(".exe"))
}

impl Plan {
    pub(crate) fn items(&self) -> Vec<CleanupItem> {
        self.batches
            .iter()
            .map(|batch| batch.item.clone())
            .collect()
    }

    pub(crate) fn warnings(&self) -> Vec<String> {
        if self.unavailable.is_empty() {
            Vec::new()
        } else {
            vec!["部分清理项目无法扫描，暂不可清理。".into()]
        }
    }

    pub(crate) fn accepts(&self, token: Uuid, selected: &[CleanupKind]) -> bool {
        self.token == token
            && self.created.elapsed() < PREVIEW_LIFETIME
            && !selected.is_empty()
            && selected
                .iter()
                .all(|kind| self.batches.iter().any(|batch| batch.item.kind == *kind))
    }

    fn files(
        &mut self,
        kind: CleanupKind,
        days: Option<u32>,
        found: io::Result<(u64, Vec<FileMark>)>,
    ) -> u64 {
        match found {
            Ok((used, files)) => {
                if !files.is_empty() {
                    self.batches.push(Batch {
                        item: CleanupItem {
                            kind,
                            bytes: files.iter().map(|file| file.bytes).sum(),
                            count: files.len() as u64,
                            retention_days: days,
                        },
                        candidates: Candidates::Files(files),
                    });
                }
                used
            }
            Err(error) => {
                self.unavailable.push((kind, error.to_string()));
                0
            }
        }
    }

    pub(crate) fn execute(
        self,
        paths: &StoragePaths,
        source: CleanupSource,
        selected: &[CleanupKind],
    ) -> CleanupRun {
        let mut run = CleanupRun::new(source);
        if matches!(source, CleanupSource::Scheduled) {
            for (kind, error) in self.unavailable {
                run.skip(kind, 0, error);
            }
        }
        // Reclaim whole files first. Rewriting the audit log needs temporary disk space.
        let mut batches = self.batches;
        batches.sort_by_key(|batch| batch.item.kind == CleanupKind::Audit);
        for batch in batches {
            let kind = batch.item.kind;
            if !selected.contains(&kind) {
                continue;
            }
            match batch.candidates {
                Candidates::Audit(cutoff, approved) => {
                    let Some(current_cutoff) = audit::retention_cutoff(paths.audit_days) else {
                        run.skip(kind, batch.item.count, "审计保留策略已变化".into());
                        continue;
                    };
                    match audit::cleanup_before(
                        &paths.data,
                        cutoff.min(current_cutoff),
                        Some(&approved),
                    ) {
                        Ok(result) => {
                            run.freed_bytes += result.bytes;
                            run.removed_count += result.entries;
                        }
                        Err(error) => run.skip(kind, batch.item.count, error),
                    }
                }
                Candidates::Files(files) => execute_files(paths, kind, files, &mut run),
            }
        }
        run
    }
}

fn execute_files(
    paths: &StoragePaths,
    kind: CleanupKind,
    files: Vec<FileMark>,
    run: &mut CleanupRun,
) {
    let _update_guard = if kind == CleanupKind::Update {
        let Some(guard) = update::maintenance_guard() else {
            run.skip(kind, files.len() as u64, "更新任务正在使用缓存".into());
            return;
        };
        Some(guard)
    } else {
        None
    };
    // Re-evaluate eligibility while using the same updater lock as installation. A plan is
    // also invalidated for any file that was changed or replaced after the user saw it.
    let first = Local::now().date_naive();
    let fresh = match kind {
        CleanupKind::Journal => dated_files(
            &paths.data.join("journal"),
            "changes-",
            first.checked_sub_days(Days::new(u64::from(paths.journal_days.saturating_sub(1)))),
        ),
        CleanupKind::Relay => dated_files(
            &paths.data.join("relay"),
            "relay-",
            first.checked_sub_days(Days::new(u64::from(RELAY_DAYS))),
        ),
        CleanupKind::Update => update_files(paths, true),
        CleanupKind::Temp => scratch_files(paths),
        CleanupKind::Audit => unreachable!("audit cleanup writes records, not whole files"),
    };
    let fresh: std::collections::HashSet<_> = match fresh {
        Ok((_, fresh)) => fresh.into_iter().collect(),
        Err(error) => {
            run.skip(
                kind,
                files.len() as u64,
                format!("重新检查文件失败：{error}"),
            );
            return;
        }
    };
    let package = update_cache::package_path(&paths.data);
    for file in files {
        if !fresh.contains(&file)
            || file.path == package.with_extension("manifest.json") && package.exists()
            || !file
                .path
                .parent()
                .is_some_and(|parent| plain_directory(parent).unwrap_or(false))
            || FileMark::capture(file.path.clone()).ok().flatten().as_ref() != Some(&file)
        {
            run.skip(kind, 1, "文件或保留条件已变化，请重新预览".into());
            continue;
        }
        match fs::remove_file(&file.path) {
            Ok(()) => {
                run.freed_bytes += file.bytes;
                run.removed_count += 1;
            }
            Err(error) => run.skip(kind, 1, format!("无法清理文件：{error}")),
        }
    }
}

fn scan_managed(paths: &StoragePaths) -> (Plan, [u64; 4]) {
    let mut plan = Plan {
        token: Uuid::new_v4(),
        created: Instant::now(),
        batches: Vec::new(),
        unavailable: Vec::new(),
    };
    let cutoff = audit::retention_cutoff(paths.audit_days);
    if let Some(cutoff) = cutoff {
        match audit::preview_expired(&paths.data, cutoff) {
            Ok(result) if result.entries != 0 => plan.batches.push(Batch {
                item: CleanupItem {
                    kind: CleanupKind::Audit,
                    bytes: result.bytes,
                    count: result.entries,
                    retention_days: Some(paths.audit_days),
                },
                candidates: Candidates::Audit(cutoff, result),
            }),
            Ok(_) => {}
            Err(error) => plan
                .unavailable
                .push((CleanupKind::Audit, error.to_string())),
        }
    }
    let first = Local::now().date_naive();
    let journal = plan.files(
        CleanupKind::Journal,
        Some(paths.journal_days),
        dated_files(
            &paths.data.join("journal"),
            "changes-",
            first.checked_sub_days(Days::new(u64::from(paths.journal_days.saturating_sub(1)))),
        ),
    );
    let relay = plan.files(
        CleanupKind::Relay,
        Some(RELAY_DAYS),
        dated_files(
            &paths.data.join("relay"),
            "relay-",
            first.checked_sub_days(Days::new(u64::from(RELAY_DAYS))),
        ),
    );
    let update = plan.files(
        CleanupKind::Update,
        None,
        update_files(paths, update::can_preview_cache_cleanup()),
    );
    let temp = plan.files(CleanupKind::Temp, Some(TEMP_DAYS), scratch_files(paths));
    (plan, [journal, relay, update, temp])
}

pub(crate) fn plan_cleanup(paths: &StoragePaths) -> Plan {
    scan_managed(paths).0
}

pub(crate) fn inspect(paths: &StoragePaths) -> Inventory {
    let (plan, [journal, relay, update, temp]) = scan_managed(paths);
    let mut warnings = plan.warnings();
    let mut read = |value: io::Result<u64>| match value {
        Ok(bytes) => bytes,
        Err(_) => {
            if warnings.is_empty() {
                warnings.push("部分目录无法读取，占用统计可能不完整。".into());
            }
            0
        }
    };
    let backup = read(measure_backup(&paths.backup));
    let audit = read(size(&paths.data.join("audit.log")));
    // Deduplicate the counted .bak files even when the configured backup directory is
    // the app data root itself or uses an alternate spelling of an in-tree directory.
    let normalize = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let data_path = normalize(&paths.data);
    let backup_path = normalize(&paths.backup);
    let backup_location = Some(backup_path.as_path());
    let (edits, edits_incomplete) = tree_bytes(
        &std::env::temp_dir().join("cc-bridge-edit"),
        &[],
        backup_location,
    );
    let (all, all_incomplete) = tree_bytes(&data_path, &[], backup_location);
    let (extra_webview, webview_incomplete) = paths
        .webview
        .as_deref()
        .map(normalize)
        .filter(|path| !path.starts_with(&data_path))
        .map_or((0, false), |path| {
            tree_bytes(&path, &[&data_path], backup_location)
        });
    if warnings.is_empty() && (edits_incomplete || all_incomplete || webview_incomplete) {
        warnings.push("部分目录无法读取，占用统计可能不完整。".into());
    }
    let data = all
        .saturating_sub(
            audit
                .saturating_add(journal)
                .saturating_add(relay)
                .saturating_add(update)
                .saturating_add(temp),
        )
        .saturating_add(extra_webview);
    let groups = [
        (StorageGroup::Backup, backup),
        (StorageGroup::Logs, audit + journal + relay),
        (StorageGroup::Update, update),
        (StorageGroup::Temp, temp + edits),
        (StorageGroup::Data, data),
    ]
    .into_iter()
    .map(|(group, used_bytes)| GroupUsage {
        group,
        used_bytes,
        eligible_bytes: plan
            .batches
            .iter()
            .filter(|batch| batch.item.kind.group() == group)
            .map(|batch| batch.item.bytes)
            .sum(),
    })
    .collect();
    Inventory {
        groups,
        volume: super::measure_volume(&paths.data),
        warnings,
    }
}
