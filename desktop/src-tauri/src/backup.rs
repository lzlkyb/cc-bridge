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

// ===== 高级手动清理（按时间 / 按体积 / 全部）=====
//
// 设计依据：`design/备份与审计-高级清理-设计稿.html`。三条约束：
// 1. **预览与执行共用同一份筛选实现**：`plan_cleanup` 是纯函数，预览只统计、执行只删。
//    否则「预览说删 847、实际删了 900」这类偏差早晚出现，而在删除操作上不可接受。
// 2. **保留底线**（`keep_last_one`，默认开）：即使某文件全部备份都超期，也给它留最新一份。
//    这把「按天清理」从破坏性操作变成安全操作。
// 3. 预览必须能回答「有几个文件将不再有任何备份」——只报总数，用户意识不到丢了什么
//    （半年前改过一次的文件，唯一那份备份被清）。

/// 备份目录里的一份备份（清理决策的最小单位）。
#[derive(Debug, Clone)]
pub struct BackupItem {
    pub path: PathBuf,
    /// 归属的原文件路径（展示用）。索引缺失时退回按备份文件名推导。
    pub original: String,
    /// **分组键**：有索引 → `p:{完整原路径}`；无索引 → `n:{文件名}`。
    ///
    /// 两个命名空间必须分开：否则同一个真实文件会因为「部分备份有索引行、
    /// 部分没有」而裂成两组，导致底线为同一文件保护两份、并误报「将失去全部备份」。
    pub group_key: String,
    pub size: u64,
    /// **备份创建时间**（按时间清理 / 最旧优先 / 选最新一份 均用它）。
    /// 从文件名时间戳解析，解析不出才退回 mtime（原因见 `created_from_backup_name`）。
    pub created: std::time::SystemTime,
    /// 原文件名是否来自索引。false = 按文件名推导，**可能与其它目录的同名文件混组**，
    /// 预览里需要把这个不确定性写出来，不能假装它归属于某个确定路径。
    pub indexed: bool,
}

/// 清理方式。三者互斥，由前端选定。
pub enum CleanupMode {
    /// 删除修改时间早于 N 天的备份。
    OlderThanDays(u32),
    /// 清到总体积降到目标字节以下（最旧优先删）。
    ToTotalBytes(u64),
    /// 全部清空。
    All,
}

/// 一次清理的完整计划。预览直接展示它，执行按它删。
#[derive(Debug, Default)]
pub struct CleanupPlan {
    pub victims: Vec<PathBuf>,
    pub freed_bytes: u64,
    pub total_bytes_before: u64,
    pub total_count_before: u32,
    /// 执行后将不再有任何备份的原文件——预览里那行红字的数据来源。
    pub files_losing_all: Vec<String>,
}

/// 拆解备份文件名：`Foo.java.20260804_120000_123.bak` → (`Foo.java`, Some("20260804_120000_123"))。
/// 尾段必须形如三段下划线才当时间戳，否则整体视为原文件名、时间戳为 None。
fn split_backup_name(p: &Path) -> (String, Option<String>) {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("unknown");
    let stripped = name.strip_suffix(".bak").unwrap_or(name);
    match stripped.rsplit_once('.') {
        Some((head, ts)) if ts.split('_').count() == 3 => (head.to_string(), Some(ts.to_string())),
        _ => (stripped.to_string(), None),
    }
}

/// 索引缺失时的兜底：`Foo.java.20260804_120000_123.bak` → `Foo.java`。
/// 仅用于分组展示与「是否会失去全部备份」的判定；还原仍需精确索引。
///
/// 对外可见是因为 `list_backups`（版本历史）就是按这个口径分组的，
/// 删整组时需要拿同一口径反向匹配。
pub fn original_from_backup_name(p: &Path) -> String {
    split_backup_name(p).0
}

/// 从文件名内嵌的时间戳解出**备份创建时间**。
///
/// **为何不能用文件 mtime**：备份是 `std::fs::copy` 产生的，Windows 下底层是
/// `CopyFileExW`，它**保留源文件的最后写入时间**。于是今天刚为一个三年没动过的
/// 文件建的备份，其 mtime 是三年前——拿 mtime 做「删除早于 N 天」会把**刚建的备份删掉**，
/// 按体积的「最旧优先」也会变成「源文件最久没动的优先」，恰好优先销毁那些只有
/// 一两份、不可再生的历史。已在 Windows 上实测确认该行为。
///
/// `list_backups` 的 `parse_backup_timestamp` 早就是这个口径（mtime 仅作兜底），
/// 这里与它保持一致。
pub fn created_from_backup_name(p: &Path) -> Option<std::time::SystemTime> {
    let ts = split_backup_name(p).1?;
    let naive = chrono::NaiveDateTime::parse_from_str(&ts, "%Y%m%d_%H%M%S_%3f").ok()?;
    // 时间戳是 `Local::now()` 写下的，按本地时区还原
    let dt = naive.and_local_timezone(Local).earliest()?;
    let ms = dt.timestamp_millis();
    if ms < 0 {
        return None;
    }
    Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64))
}

/// 列出备份目录里全部 `.bak`，并解析出归属原文件 / 体积 / 创建时间。
///
/// 索引一次查完建 map，不对每个文件各发一条 SQL（备份可能成千上万）。
///
/// 返回 `None` 表示**备份目录本身读不了**（不存在 / 网络盘掉线 / 权限不足）。
/// 调用方必须区分「目录里确实没备份」与「读不到目录」——后者绝不能当成
/// 「没有任何备份」去清索引（否则一次掉线就能把整张索引表删光）。
pub fn list_backup_items(
    data_dir: &Path,
    backup_dir_name: &str,
    db: &Connection,
) -> Option<Vec<BackupItem>> {
    let dir = data_dir.join(backup_dir_name);
    let mut index: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(mut stmt) = db.prepare("SELECT backup_path, original_path FROM backup_index") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) {
            for (k, v) in rows.flatten() {
                index.insert(k, v);
            }
        }
    }

    let rd = std::fs::read_dir(&dir).ok()?;
    let mut out = Vec::new();
    for entry in rd.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("bak") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        // 名为 `*.bak` 的**目录**（或目录 junction）不是备份：计入会让预览永远报
        // 要删它、而 `remove_file` 对它必然失败，变成永久对不上的差额。
        if !meta.is_file() {
            continue;
        }
        let key = p.to_string_lossy().into_owned();
        let indexed_original = index.get(&key).cloned();
        let indexed = indexed_original.is_some();
        let original = indexed_original.unwrap_or_else(|| original_from_backup_name(&p));
        // 两个不同命名空间，详见 `BackupItem::group_key` 的注释
        let group_key = if indexed {
            format!("p:{original}")
        } else {
            format!("n:{original}")
        };
        out.push(BackupItem {
            path: p.clone(),
            original,
            group_key,
            size: meta.len(),
            created: created_from_backup_name(&p)
                .or_else(|| meta.modified().ok())
                .unwrap_or(std::time::UNIX_EPOCH),
            indexed,
        });
    }
    Some(out)
}

/// **纯函数**：算出该删哪些。预览与执行都走它，两边结果天然一致。
///
/// `keep_last_one`：每个原文件的**最新一份**受保护，不论多旧都不删。
pub fn plan_cleanup(items: &[BackupItem], mode: &CleanupMode, keep_last_one: bool) -> CleanupPlan {
    use std::collections::{HashMap, HashSet};

    let total_bytes_before: u64 = items.iter().map(|i| i.size).sum();
    let total_count_before = items.len() as u32;

    // 每个分组里最新那份的路径（底线开启时受保护）。
    //
    // 并列时拿路径做二级比较：同一毫秒内的两份备份（或时间戳解不出、都退到
    // 同一个 mtime 的情况）不能让结果依赖 read_dir 的枚举顺序，否则同一次预览与
    // 执行可能保护不同的那一份。
    let mut newest: HashMap<&str, (&Path, std::time::SystemTime)> = HashMap::new();
    for it in items {
        let cand = (it.path.as_path(), it.created);
        newest
            .entry(it.group_key.as_str())
            .and_modify(|cur| {
                if (it.created, it.path.as_path()) > (cur.1, cur.0) {
                    *cur = cand;
                }
            })
            .or_insert(cand);
    }
    let protected: HashSet<&Path> = if keep_last_one {
        newest.values().map(|(p, _)| *p).collect()
    } else {
        HashSet::new()
    };

    let mut victims: Vec<&BackupItem> = match mode {
        CleanupMode::All => items.iter().collect(),
        CleanupMode::OlderThanDays(days) => {
            let cutoff = std::time::SystemTime::now()
                .checked_sub(std::time::Duration::from_secs(*days as u64 * 86_400))
                .unwrap_or(std::time::UNIX_EPOCH);
            items.iter().filter(|i| i.created < cutoff).collect()
        }
        CleanupMode::ToTotalBytes(target) => {
            // 最旧优先删，直到总量降到目标以下。底线在这里就要生效，
            // 否则会把受保护的那份也计入“已释放”，导致实际降不到目标。
            let mut sorted: Vec<&BackupItem> = items.iter().collect();
            // 路径作二级 key：创建时间相同时也必须有确定顺序
            sorted.sort_by(|a, b| (a.created, &a.path).cmp(&(b.created, &b.path)));
            let mut cur = total_bytes_before;
            let mut picked = Vec::new();
            for it in sorted {
                if cur <= *target {
                    break;
                }
                if protected.contains(it.path.as_path()) {
                    continue;
                }
                cur -= it.size;
                picked.push(it);
            }
            picked
        }
    };
    victims.retain(|i| !protected.contains(i.path.as_path()));

    // 哪些分组会被清光：它的全部备份都在待删列表里。
    let victim_set: HashSet<&Path> = victims.iter().map(|i| i.path.as_path()).collect();
    // (总数, 待删数, 展示名, 是否有索引)
    let mut per_group: HashMap<&str, (usize, usize, &str, bool)> = HashMap::new();
    for it in items {
        let e = per_group
            .entry(it.group_key.as_str())
            .or_insert((0, 0, it.original.as_str(), it.indexed));
        e.0 += 1;
        if victim_set.contains(it.path.as_path()) {
            e.1 += 1;
        }
    }
    let mut files_losing_all: Vec<String> = per_group
        .values()
        .filter(|(total, killed, _, _)| *total > 0 && total == killed)
        .map(|(_, _, display, indexed)| {
            if *indexed {
                (*display).to_string()
            } else {
                // 无索引项只能按文件名归组，可能涵盖多个目录下的同名文件。
                // 这个不确定性必须告知用户，不能假装它归属于某个确定路径。
                format!("{display}（无索引，按文件名归组）")
            }
        })
        .collect();
    files_losing_all.sort();

    CleanupPlan {
        freed_bytes: victims.iter().map(|i| i.size).sum(),
        victims: victims.iter().map(|i| i.path.clone()).collect(),
        total_bytes_before,
        total_count_before,
        files_losing_all,
    }
}

/// 批量删文件（**不碰数据库**）。返回 (已删掉的路径, 实际释放字节, 删失败数)。
///
/// 与 db 分开是有意的：调用方可以在**不持锁**的情况下跑完这一步（备份可能上万，
/// 持着 db 锁删上万个文件会把所有 MCP 写操作卡在那里数十秒），
/// 事后再一次性把索引行交给 `purge_index_rows`。
///
/// 不直接用 `plan.freed_bytes`：个别文件可能在预览后被外部删掉，报给用户的
/// 必须是**真实发生的**数字。删失败（被杀软/编辑器占用、只读属性）也不能吞：
/// 预览说 900、实际只删了 3 而不给任何解释，用户无法判断发生了什么。
pub fn delete_files_bulk(victims: &[PathBuf]) -> (Vec<PathBuf>, u64, u32) {
    let mut deleted = Vec::with_capacity(victims.len());
    let mut freed = 0u64;
    let mut failed = 0u32;
    for p in victims {
        let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        match std::fs::remove_file(p) {
            Ok(()) => {
                freed += size;
                deleted.push(p.clone());
            }
            Err(e) => {
                failed += 1;
                log::warn!("删除备份失败 {}：{e}", p.display());
            }
        }
    }
    (deleted, freed, failed)
}

/// 把已删掉的备份从 `backup_index` 里清除——**单事务**。
///
/// 一条一事务的写法在上万量级上是上万次 fsync，而且中途失败会留下半截状态。
pub fn purge_index_rows(db: &Connection, deleted: &[PathBuf]) {
    if deleted.is_empty() {
        return;
    }
    if let Err(e) = db.execute_batch("BEGIN") {
        log::warn!("开启索引清理事务失败：{e}");
        return;
    }
    for p in deleted {
        if let Err(e) = db.execute(
            "DELETE FROM backup_index WHERE backup_path = ?1",
            params![p.to_string_lossy().into_owned()],
        ) {
            log::warn!("清理索引行失败 {}：{e}", p.display());
        }
    }
    if let Err(e) = db.execute_batch("COMMIT") {
        log::warn!("提交索引清理失败：{e}");
        let _ = db.execute_batch("ROLLBACK");
    }
}

/// 清掉 `backup_index` 里指向已不存在文件的行，返回清掉的行数。
///
/// 孤儿行的来源：在本功能之前，面板上**根本没有删备份的入口**，用户只能
/// 「打开目录」自己手删——而手删不会清索引（自动裁剪会，见 `prune_backups`）。
///
/// **三道防护，每一道都是为了不把整张表误删**：
/// 1. 只处理落在 `backup_dir` 下的行——历史上改过备份目录的话，旧目录的行不归它管。
/// 2. 用 `symlink_metadata` 且**只有 `NotFound` 才算孤儿**。原先用的 `Path::exists()`
///    把任何错误都当成“不存在”：网络盘/移动盘掉线、ACL 拒绝、路径过长一律为 false，
///    于是备份目录在 `Z:\` 且掉线时点一次清理就能把整张索引表删光。后果不可逆：
///    所有备份永久失去 original_path 映射，还原 / 看改了什么全部失效。
/// 3. 单事务。
///
/// 调用方还必须自己确认备份目录**读得到**（`list_backup_items` 返回 `Some`）才能调它。
pub fn heal_orphan_index(db: &Connection, backup_dir: &Path) -> u32 {
    let prefix = backup_dir.to_string_lossy().into_owned();
    let mut orphans: Vec<String> = Vec::new();
    if let Ok(mut stmt) = db.prepare("SELECT backup_path FROM backup_index") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for p in rows.flatten() {
                if !p.starts_with(&prefix) {
                    continue;
                }
                match std::fs::symlink_metadata(&p) {
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => orphans.push(p),
                    // 其余错误（权限/IO/盘掉线）一律**不当孤儿**，宁可留着
                    Err(e) => log::warn!("无法确认备份是否存在，跳过 {p}：{e}"),
                }
            }
        }
    }
    if orphans.is_empty() {
        return 0;
    }
    let mut n = 0u32;
    if db.execute_batch("BEGIN").is_err() {
        return 0;
    }
    for p in &orphans {
        if db
            .execute(
                "DELETE FROM backup_index WHERE backup_path = ?1",
                params![p],
            )
            .is_ok()
        {
            n += 1;
        }
    }
    if let Err(e) = db.execute_batch("COMMIT") {
        log::warn!("提交孤儿索引清理失败：{e}");
        let _ = db.execute_batch("ROLLBACK");
        return 0;
    }
    n
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
                // 与 `list_backup_items` 保持同一口径：名为 `*.bak` 的目录不计入，
                // 否则卡片上的「共 N 个备份」与预览里的总数对不上。
                if let Ok(meta) = entry.metadata() {
                    if !meta.is_file() {
                        continue;
                    }
                    count += 1;
                    total += meta.len();
                }
            }
        }
    }
    (count, total)
}

#[cfg(test)]
mod cleanup_tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn item(path: &str, original: &str, size: u64, days_ago: u64) -> BackupItem {
        BackupItem {
            path: PathBuf::from(path),
            group_key: format!("p:{original}"),
            original: original.to_string(),
            size,
            created: SystemTime::now() - Duration::from_secs(days_ago * 86_400),
            indexed: true,
        }
    }

    /// 无索引项：归组键走 `n:` 命名空间，且 `indexed = false`。
    fn item_noindex(path: &str, name: &str, size: u64, days_ago: u64) -> BackupItem {
        BackupItem {
            path: PathBuf::from(path),
            group_key: format!("n:{name}"),
            original: name.to_string(),
            size,
            created: SystemTime::now() - Duration::from_secs(days_ago * 86_400),
            indexed: false,
        }
    }

    /// 底线开启时：即使某文件所有备份都超期，也必须留最新一份，
    /// 且 files_losing_all 为空——这正是「按天清理」不再是破坏性操作的保证。
    #[test]
    fn keep_last_one_protects_newest_and_clears_warning() {
        let items = vec![
            item("/b/a.1.bak", "/src/a.rs", 10, 200),
            item("/b/a.2.bak", "/src/a.rs", 20, 100),
            item("/b/z.1.bak", "/src/z.rs", 30, 300),
        ];
        let plan = plan_cleanup(&items, &CleanupMode::OlderThanDays(30), true);
        assert_eq!(plan.victims, vec![PathBuf::from("/b/a.1.bak")]);
        assert_eq!(plan.freed_bytes, 10);
        assert!(
            plan.files_losing_all.is_empty(),
            "底线开启时不应有文件失去全部备份"
        );
    }

    /// 底线关闭时会真的清光，且 files_losing_all 必须点出受影响文件——
    /// 只报「删了几个」，用户意识不到自己丢了什么。
    #[test]
    fn without_floor_reports_files_losing_all_backups() {
        let items = vec![
            item("/b/a.1.bak", "/src/a.rs", 10, 200),
            item("/b/a.2.bak", "/src/a.rs", 20, 100),
            item("/b/z.1.bak", "/src/z.rs", 30, 300),
        ];
        let plan = plan_cleanup(&items, &CleanupMode::OlderThanDays(30), false);
        assert_eq!(plan.victims.len(), 3);
        assert_eq!(plan.freed_bytes, 60);
        assert_eq!(plan.files_losing_all, vec!["/src/a.rs", "/src/z.rs"]);
    }

    /// 按体积：最旧优先删，直到降到目标以下。受保护的那份不能计入“已释放”，
    /// 否则会算出“已达标”而实际没达标。
    #[test]
    fn to_total_bytes_deletes_oldest_first() {
        let items = vec![
            item("/b/x.1.bak", "/src/x.rs", 100, 300),
            item("/b/x.2.bak", "/src/x.rs", 100, 200),
            item("/b/x.3.bak", "/src/x.rs", 100, 100),
        ];
        // 总 300，目标 150：删 x.1 → 200；删 x.2 → 100 ≤ 150 停。x.3 受底线保护。
        let plan = plan_cleanup(&items, &CleanupMode::ToTotalBytes(150), true);
        assert_eq!(
            plan.victims,
            vec![PathBuf::from("/b/x.1.bak"), PathBuf::from("/b/x.2.bak")]
        );
        assert!(plan.files_losing_all.is_empty());
    }

    /// 「全部清空」**也**受底线约束。这是有意的：底线是一个全局开关，
    /// 选了全部清空但没关底线时，仍给每个文件留最新一份；
    /// 要彻底删干净必须显式关掉底线（预览会把差异摄得很清楚）。
    #[test]
    fn all_mode_still_respects_floor() {
        let items = vec![
            item("/b/a.1.bak", "/src/a.rs", 10, 3),
            item("/b/a.2.bak", "/src/a.rs", 20, 1),
        ];
        let with_floor = plan_cleanup(&items, &CleanupMode::All, true);
        assert_eq!(with_floor.victims, vec![PathBuf::from("/b/a.1.bak")]);
        assert!(with_floor.files_losing_all.is_empty());

        let no_floor = plan_cleanup(&items, &CleanupMode::All, false);
        assert_eq!(no_floor.victims.len(), 2);
        assert_eq!(no_floor.files_losing_all, vec!["/src/a.rs"]);
    }

    /// 备份创建时间必须从**文件名时间戳**解，不能用 mtime。
    ///
    /// 这条针对一个已实测确认的真实缺陷：Windows 上 `std::fs::copy` 走 `CopyFileExW`，
    /// 会保留源文件的最后写入时间——今天刚为一个三年没动过的文件建的备份，
    /// mtime 是三年前，拿 mtime 做「删除早于 N 天」会把刚建的备份删掉。
    #[test]
    fn created_time_comes_from_filename_not_mtime() {
        let p = PathBuf::from("/b/Foo.java.20260804_120000_123.bak");
        let got = created_from_backup_name(&p).expect("合规时间戳必须能解出来");
        let expect = chrono::NaiveDateTime::parse_from_str("20260804_120000_123", "%Y%m%d_%H%M%S_%3f")
            .unwrap()
            .and_local_timezone(Local)
            .earliest()
            .unwrap();
        let got_ms = got
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert_eq!(got_ms, expect.timestamp_millis());

        // 没有合规时间戳的文件名返回 None，由调用方退回 mtime
        assert!(created_from_backup_name(&PathBuf::from("/b/weird.bak")).is_none());
        assert!(created_from_backup_name(&PathBuf::from("/b/my.data.bak")).is_none());
    }

    /// 无索引项与有索引项**不能归入同一组**。
    ///
    /// 否则同一个真实文件会因为「一部分备份有索引行、一部分没有」而裂成两组：
    /// 底线会为它保护两份，且其中一组被清光时会误报「将失去全部备份」。
    /// 同时验证：无索引组的提示文案必须带「按文件名归组」的不确定性声明。
    #[test]
    fn indexed_and_unindexed_never_share_a_group() {
        let items = vec![
            item("/b/x.1.bak", "/src/x.rs", 10, 200),
            item_noindex("/b/x.2.bak", "x.rs", 20, 100),
        ];
        // 底线开：两组各自保护自己最新一份 → 一个都不删
        let with_floor = plan_cleanup(&items, &CleanupMode::OlderThanDays(30), true);
        assert!(with_floor.victims.is_empty(), "两个独立组各留一份");

        let no_floor = plan_cleanup(&items, &CleanupMode::All, false);
        assert_eq!(no_floor.victims.len(), 2);
        assert_eq!(
            no_floor.files_losing_all,
            vec!["/src/x.rs", "x.rs（无索引，按文件名归组）"],
            "两组必须各报一条，且无索引组要标注不确定性"
        );
    }

    /// 创建时间完全相同时，结果不得依赖枚举顺序（拿路径做二级比较）。
    /// 否则同一次预览与执行可能保护不同的那一份。
    #[test]
    fn ties_are_broken_by_path_not_enumeration_order() {
        // 时间戳必须先算好：写在 map 里的话 `SystemTime::now()` 会每项各调一次，
        // 三份就不是同一个时间了，测的也就不再是「并列」这个场景。
        let same = SystemTime::now() - Duration::from_secs(200 * 86_400);
        let mk = |paths: [&str; 3]| {
            paths
                .iter()
                .map(|p| BackupItem {
                    path: PathBuf::from(*p),
                    group_key: "p:/src/t.rs".to_string(),
                    original: "/src/t.rs".to_string(),
                    size: 10,
                    created: same,
                    indexed: true,
                })
                .collect::<Vec<_>>()
        };
        let a = plan_cleanup(&mk(["/b/1.bak", "/b/2.bak", "/b/3.bak"]), &CleanupMode::All, true);
        let b = plan_cleanup(&mk(["/b/3.bak", "/b/1.bak", "/b/2.bak"]), &CleanupMode::All, true);
        let mut va = a.victims.clone();
        let mut vb = b.victims.clone();
        va.sort();
        vb.sort();
        assert_eq!(va, vb, "枚举顺序不得影响受保护的是哪一份");
        assert_eq!(va.len(), 2);
    }

    /// 纯函数：同输入多次调用结果必须一致。
    ///
    /// 注意这只能证明**幂等性**，它并不能证明「预览 == 执行」——后者靠的是
    /// 预览把 victims 列表交给前端、执行只删这份已确认的列表（见 `cleanup_backups`）。
    #[test]
    fn plan_is_deterministic() {
        let items = vec![
            item("/b/a.1.bak", "/src/a.rs", 10, 200),
            item("/b/b.1.bak", "/src/b.rs", 20, 200),
        ];
        let a = plan_cleanup(&items, &CleanupMode::OlderThanDays(30), false);
        let b = plan_cleanup(&items, &CleanupMode::OlderThanDays(30), false);
        assert_eq!(a.victims, b.victims);
        assert_eq!(a.freed_bytes, b.freed_bytes);
        assert_eq!(a.files_losing_all, b.files_losing_all);
    }
}
