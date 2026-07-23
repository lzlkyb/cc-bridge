use std::path::{Path, PathBuf};

use chrono::Local;
use rusqlite::{params, Connection};

pub fn backup_before_overwrite(
    file_path: &Path,
    backup_dir_name: &str,
    data_dir: &Path,
    db: &Connection,
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

    // 记录原始绝对路径，供还原时精确定位（非致命：备份文件本身已落盘成功，
    // 索引写入失败只影响后续 UI 还原/看改了什么按钮可用性，不影响数据安全）。
    if let Err(e) = db.execute(
        "INSERT OR REPLACE INTO backup_index (backup_path, original_path) VALUES (?1, ?2)",
        params![
            backup_path.to_string_lossy().into_owned(),
            file_path.to_string_lossy().into_owned()
        ],
    ) {
        log::warn!("记录备份索引失败（不影响备份本身）: {e}");
    }

    Ok(Some(backup_path))
}

/// M2 修复：严格校验一个备份文件名是否属于本文件——去掉 `{file_name}.` 前缀后，
/// 剩余部分必须恰好是 `YYYYMMDD_HHMMSS_mmm.bak` 时间戳格式。旧实现只用
/// starts_with(prefix)+ends_with(".bak")，会把「前缀包含」的他文件备份误纳入
/// （如 prune "config" 命中 "config.local.<ts>.bak"），导致跨文件误删。
/// 已知残留：同名不同目录的文件（a/x.rs 与 b/x.rs）在同一扁平备份目录内 basename
/// 相同，仍会共享同一集合——彻底区分需按 backup_index 表的 original_path 精确筛选（后续项）。
fn is_own_timestamped_backup(name: &str, prefix: &str) -> bool {
    let rest = match name.strip_prefix(prefix) {
        Some(r) => r,
        None => return false,
    };
    let ts = match rest.strip_suffix(".bak") {
        Some(t) => t,
        None => return false,
    };
    let parts: Vec<&str> = ts.split('_').collect();
    parts.len() == 3
        && parts[0].len() == 8
        && parts[1].len() == 6
        && parts[2].len() == 3
        && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
}

pub fn prune_backups(
    file_path: &Path,
    backup_dir_name: &str,
    data_dir: &Path,
    retention: u32,
    db: &Connection,
) -> Result<u32, String> {
    let backup_dir = data_dir.join(backup_dir_name);
    if !backup_dir.exists() {
        return Ok(0);
    }

    // retention=0 的语义与 audit_retention_days=0 对齐：视为“无限保留”、不裁剪，
    // 而不是把全部历史备份删光（旧实现 `len() > 0` 会删除所有备份）。
    if retention == 0 {
        return Ok(0);
    }

    // M2 修复：按 backup_index.original_path 精确筛选本文件的备份，避免同名不同目录
    // 文件（a/x.rs 与 b/x.rs）在扁平备份目录内 basename 相同而互相串扰（误删/误纳）。
    let original = file_path.to_string_lossy().into_owned();
    let candidates: Vec<PathBuf> = {
        let mut stmt = db
            .prepare(
                "SELECT backup_path FROM backup_index WHERE original_path = ?1 \
                 ORDER BY backup_path ASC",
            )
            .map_err(|e| format!("查询备份索引失败: {e}"))?;
        let rows = stmt
            .query_map(params![original], |row| row.get::<_, String>(0))
            .map_err(|e| format!("读取备份索引失败: {e}"))?;
        rows.filter_map(|r| r.ok()).map(PathBuf::from).collect()
    };

    // 兜底：索引表无记录（旧版备份或索引缺失）时退回文件名匹配，避免漏删。
    let mut backups = if candidates.is_empty() {
        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");

        let prefix = format!("{file_name}.");

        std::fs::read_dir(&backup_dir)
            .map_err(|e| format!("Failed to read backup directory: {e}"))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| is_own_timestamped_backup(n, &prefix))
                    .unwrap_or(false)
            })
            .collect()
    } else {
        candidates
    };

    // Sort by name (timestamp is embedded) — oldest first
    backups.sort();

    let mut removed = 0u32;
    while backups.len() > retention as usize {
        if let Some(oldest) = backups.first() {
            let _ = std::fs::remove_file(oldest);
            // 同步清理索引记录，避免孤儿索引行堆积
            let _ = db.execute(
                "DELETE FROM backup_index WHERE backup_path = ?1",
                params![oldest.to_string_lossy().into_owned()],
            );
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
