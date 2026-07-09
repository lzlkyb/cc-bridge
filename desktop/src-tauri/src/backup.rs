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

    std::fs::copy(file_path, &backup_path).map_err(|e| format!("Failed to create backup: {e}"))?;

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
