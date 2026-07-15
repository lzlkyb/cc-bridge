use std::path::{Path, PathBuf};

use chrono::Local;

pub fn backup_before_overwrite(
    file_path: &Path,
    backup_dir_name: &str,
    data_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    if !file_path.exists() {
        return Ok(None);
    }

    let backup_dir = data_dir.join(backup_dir_name);
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Failed to create backup directory: {e}"))?;

    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");

    let timestamp = Local::now().format("%Y%m%d_%H%M%S_%3f");
    let backup_name = format!("{file_name}.{timestamp}.bak");
    let backup_path = backup_dir.join(&backup_name);

    let t0 = std::time::Instant::now();
    std::fs::copy(file_path, &backup_path).map_err(|e| format!("Failed to create backup: {e}"))?;
    crate::timing::record_io(t0.elapsed());

    Ok(Some(backup_path))
}

pub fn prune_backups(
    file_path: &Path,
    backup_dir_name: &str,
    data_dir: &Path,
    retention: u32,
) -> Result<u32, String> {
    let backup_dir = data_dir.join(backup_dir_name);
    if !backup_dir.exists() {
        return Ok(0);
    }

    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");

    let prefix = format!("{file_name}.");
    let suffix = ".bak";

    let mut backups: Vec<PathBuf> = std::fs::read_dir(&backup_dir)
        .map_err(|e| format!("Failed to read backup directory: {e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(&prefix) && n.ends_with(suffix))
                .unwrap_or(false)
        })
        .collect();

    // Sort by name (timestamp is embedded) — oldest first
    backups.sort();

    let mut removed = 0u32;
    while backups.len() > retention as usize {
        if let Some(oldest) = backups.first() {
            let _ = std::fs::remove_file(oldest);
            backups.remove(0);
            removed += 1;
        }
    }

    Ok(removed)
}

/// 备份目录的绝对路径 = data_dir / backup_dir_name。
pub fn backup_dir_abs(data_dir: &Path, backup_dir_name: &str) -> PathBuf {
    data_dir.join(backup_dir_name)
}

/// 统计备份目录：返回 (` .bak 文件数`, `总字节数`)。目录不存在时返回 (0, 0)。
/// 用于设置页「共 N 个备份 · 占用 X MB」展示，避免前端再扫磁盘。
pub fn backup_stats(data_dir: &Path, backup_dir_name: &str) -> (u32, u64) {
    let dir = data_dir.join(backup_dir_name);
    let mut count = 0u32;
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) == Some("bak") {
                if let Ok(meta) = entry.metadata() {
                    count += 1;
                    total += meta.len();
                }
            }
        }
    }
    (count, total)
}
