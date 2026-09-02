//! 备份域的 IPC 命令：高级清理、单份/整组删除、一键还原、备份清单与变更 diff。
//!
//! **为何叫 `backup_cmds` 而不是 `backup`**：`crate::backup`（`src/backup.rs`）已经存在，
//! 而 `commands.rs` 顶部有 `use crate::backup;`。子模块再叫 `backup` 会与它同名冲突
//! （幸好是编译错而不是静默覆盖，但没必要赌这个）。
//!
//! D19 方案 C 第 2 批。这是最大的一块（739 行 / 10 个命令），而且它在原文件里
//! **被 running_commands 割成了两段**（原 1052–1314 与 1687–2160），本次合为一处。
//! 两段的相对顺序保持不变（先清理、后还原/清单/diff），以便与原文件对照。
//!
//! ❗ `assert_backup_path_in_scope` 是**安全函数**（7 处调用）：canonicalize 后做前缀校验，
//! 杜绝用备份通道越权读写任意文件。拆到本文件后它**仍是私有的**——七处调用全在
//! 本模块内，所以不需要也不得改成 `pub`（规则 7：安全模块不得削弱）。
//!
//! 本文件是**纯搬动**：函数体逐字节未改，可用 `tools/fingerprint.py` 比对哈希验证。
//! 下面这些 import 全是从 `commands.rs` 顶部拿过来的子集（每个文件各自最小化，
//! 否则 mac 的 `clippy --all-targets -D warnings` 会因未用导入直接失败）。

use std::path::PathBuf;
use std::sync::Arc;

// `reveal_backup_dir` 的 Windows 分支要用 `Command::creation_flags`（CREATE_NO_WINDOW，
// 不加就会闪黑框）。**必须跟着调用点一起 cfg 门控**：mac 上这个 trait 不存在，
// 不门控则 `--no-default-features` 的 mac clippy 会直接报错。
// 本批搬动时正是漏了这行，编译报 E0599 no method named `creation_flags` 才发现。
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;
use similar::TextDiff;
use tauri::State;

use crate::audit;
use crate::backup;
use crate::security::path;
use crate::state::AppState;

// ===== 备份高级清理（设计稿：design/备份与审计-高级清理-设计稿.html）=====

#[derive(Debug, Serialize)]
pub struct BackupCleanupPreview {
    /// 待删份数
    pub count: u32,
    #[serde(rename = "freedBytes")]
    pub freed_bytes: u64,
    #[serde(rename = "totalBytesBefore")]
    pub total_bytes_before: u64,
    #[serde(rename = "totalCountBefore")]
    pub total_count_before: u32,
    /// 执行后将不再有任何备份的原文件（预览里那行红字）。
    #[serde(rename = "filesLosingAll")]
    pub files_losing_all: Vec<String>,
    /// **待删备份的完整路径列表**——前端原样回传给 `cleanup_backups`。
    ///
    /// 这是「预览 == 执行」真正的实现方式。共用同一个 `plan_cleanup` **函数**并不够：
    /// 两个命令各自重扫目录、各自取一次 `now()`，于是预览到确认之间只要发生一次
    /// MCP 写操作（这正是本应用的主业）新增了 `.bak`，或 cutoff 随时间前移，
    /// 实际删除集合就不等于用户确认过的那个集合——恰好就是注释里反复承诺不会发生的
    /// 「预览说删 847、实际删了 900」。
    pub victims: Vec<String>,
}

/// 把前端传的 mode 字符串转成强类型。非法值直接报错——删除操作不容许“猜一个默认”。
fn parse_cleanup_mode(
    mode: &str,
    days: Option<u32>,
    target_mb: Option<u64>,
) -> Result<backup::CleanupMode, String> {
    match mode {
        "olderThanDays" => days
            .filter(|d| *d > 0)
            .map(backup::CleanupMode::OlderThanDays)
            .ok_or_else(|| "按时间清理需提供大于 0 的天数".to_string()),
        // 与 days 一样必须 > 0：目标 0 字节等于全删，但用户以为自己在「清到 300MB」。
        // 想全删必须显式选「全部清空」（`cleanup_audit_before` 已经立了这个规矩）。
        "toTotalMb" => target_mb
            .filter(|mb| *mb > 0)
            .map(|mb| backup::CleanupMode::ToTotalBytes(mb.saturating_mul(1024 * 1024)))
            .ok_or_else(|| {
                "按体积清理需提供大于 0 的目标大小（想全删请选「全部清空」）".to_string()
            }),
        "all" => Ok(backup::CleanupMode::All),
        other => Err(format!("未知的清理方式：{other}")),
    }
}

/// 预览清理（**无副作用**）。与执行共用 `backup::plan_cleanup` 这一份筛选实现，
/// 所以不会出现「预览说删 847、实际删了 900」这类偏差。
#[tauri::command]
pub async fn preview_backup_cleanup(
    state: State<'_, Arc<AppState>>,
    mode: String,
    days: Option<u32>,
    target_mb: Option<u64>,
    keep_last_one: bool,
) -> Result<BackupCleanupPreview, String> {
    let m = parse_cleanup_mode(&mode, days, target_mb)?;
    let backup_dir = state.config.read().await.backup_dir.clone();
    let db = state.db.lock().await;
    let items = backup::list_backup_items(&state.data_dir, &backup_dir, &db)
        .ok_or_else(|| "读不到备份目录（不存在 / 权限不足 / 所在盘未就绪）".to_string())?;
    drop(db);
    let plan = backup::plan_cleanup(&items, &m, keep_last_one);
    Ok(BackupCleanupPreview {
        count: plan.victims.len() as u32,
        freed_bytes: plan.freed_bytes,
        total_bytes_before: plan.total_bytes_before,
        total_count_before: plan.total_count_before,
        files_losing_all: plan.files_losing_all,
        victims: plan
            .victims
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    })
}

#[derive(Debug, Serialize)]
pub struct BackupCleanupResult {
    pub removed: u32,
    #[serde(rename = "freedBytes")]
    pub freed_bytes: u64,
    /// 顺手清掉的孤儿索引行数（历史上绕过面板手删备份遗留的）。
    #[serde(rename = "healedIndexRows")]
    pub healed_index_rows: u32,
    /// 删失败的份数（被杀软/编辑器占用、只读属性等）。
    /// 不能吞：预览说 900、实际只删了 3 而不给解释，用户无法判断发生了什么。
    pub failed: u32,
}

/// 删备份写审计。三个删除命令（批量/单份/整组）共用它——三者同样不可逆，
/// 一次能干掉几百个版本，不能只给批量那条留痕。
fn audit_backup_deletion(data_dir: &std::path::Path, action: &str, detail: serde_json::Value) {
    let entry = audit::new_entry(
        action,
        &detail.to_string(),
        true,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    );
    if let Err(e) = audit::write_audit_log(data_dir, &entry) {
        log::warn!("写入删备份审计失败：{e}");
    }
}

/// 执行清理。**只删 `victims` 里的路径**，即预览返回、用户看到并确认过的那一份清单。
///
/// 为何不重新根据条件算一遍（原先的写法）：预览到确认之间只要发生一次 MCP 写操作
/// 就会新增 `.bak`，或自动裁剪删掉几个，或 cutoff 随 `now()` 前移——实际删除集合
/// 就不等于用户确认过的集合。后新增的备份因为不在清单里而不会被删，这是对的：
/// 用户没确认过它们。
///
/// `mode`/`days`/`target_mb`/`keep_last_one` 已不参与筛选，**仅用于审计记录**当时的条件。
#[tauri::command]
pub async fn cleanup_backups(
    state: State<'_, Arc<AppState>>,
    victims: Vec<String>,
    mode: String,
    days: Option<u32>,
    target_mb: Option<u64>,
    keep_last_one: bool,
) -> Result<BackupCleanupResult, String> {
    if victims.is_empty() {
        return Err("没有待删备份（请先重新预览）".into());
    }
    let backup_dir_name = state.config.read().await.backup_dir.clone();

    // 每一条路径都重新过一次「必须落在备份目录内且是 .bak」的校验。
    // 前端传什么都不能直接信，复用已有的 `assert_backup_path_in_scope`（安全模块不另写一套）。
    let mut targets: Vec<PathBuf> = Vec::with_capacity(victims.len());
    for v in &victims {
        targets.push(assert_backup_path_in_scope(
            v,
            &state.data_dir,
            &backup_dir_name,
        )?);
    }

    // 删文件全程**不持 db 锁**，并且丢到 spawn_blocking：备份可能上万，
    // 原先持锁删完所有文件会把 write_files/edit_files 等全部 MCP 写操作
    // （它们写备份索引也要同一把锁）卡在那里数十秒，同时还挂住一个 tokio worker。
    let (deleted, freed, failed) =
        tokio::task::spawn_blocking(move || backup::delete_files_bulk(&targets))
            .await
            .map_err(|e| format!("清理任务异常结束：{e}"))?;
    let removed = deleted.len() as u32;

    let db = state.db.lock().await;
    backup::purge_index_rows(&db, &deleted);
    // 自愈孤儿索引前先确认备份目录**真的读得到**：读不到时绝不能把索引行当孤儿清掉。
    let dir_readable = backup::list_backup_items(&state.data_dir, &backup_dir_name, &db).is_some();
    let healed = if dir_readable {
        backup::heal_orphan_index(&db, &state.data_dir.join(&backup_dir_name))
    } else {
        log::warn!("备份目录不可读，跳过孤儿索引自愈");
        0
    };
    drop(db);

    audit_backup_deletion(
        &state.data_dir,
        "cleanup_backups",
        serde_json::json!({
            "mode": mode, "days": days, "targetMb": target_mb,
            "keepLastOne": keep_last_one, "confirmed": victims.len(),
            "removed": removed, "failed": failed, "freedBytes": freed
        }),
    );
    log::info!(
        "清理备份：确认 {} 个，删除 {removed} 个，失败 {failed} 个，释放 {freed} 字节，修复孤儿索引 {healed} 行",
        victims.len()
    );
    Ok(BackupCleanupResult {
        removed,
        freed_bytes: freed,
        healed_index_rows: healed,
        failed,
    })
}

/// 删单份备份（版本历史逐行）。路径必须落在备份目录内且以 .bak 结尾——
/// 复用已有的 `assert_backup_path_in_scope`，不另写一套校验（安全模块不削弱）。
#[tauri::command]
pub async fn delete_backup(
    state: State<'_, Arc<AppState>>,
    backup_path: String,
) -> Result<u64, String> {
    let backup_dir = state.config.read().await.backup_dir.clone();
    let canon = assert_backup_path_in_scope(&backup_path, &state.data_dir, &backup_dir)?;
    let size = std::fs::metadata(&canon).map(|m| m.len()).unwrap_or(0);
    std::fs::remove_file(&canon).map_err(|e| format!("删除备份失败：{e}"))?;
    let db = state.db.lock().await;
    let _ = db.execute(
        "DELETE FROM backup_index WHERE backup_path = ?1",
        rusqlite::params![canon.to_string_lossy().into_owned()],
    );
    drop(db);
    audit_backup_deletion(
        &state.data_dir,
        "delete_backup",
        serde_json::json!({ "backupPath": canon.to_string_lossy(), "freedBytes": size }),
    );
    Ok(size)
}

/// 删某原文件的**全部**备份（分组头一键）。返回 (删除数, 释放字节)。
#[tauri::command]
pub async fn delete_backups_of_file(
    state: State<'_, Arc<AppState>>,
    original_path: String,
) -> Result<BackupCleanupResult, String> {
    let backup_dir = state.config.read().await.backup_dir.clone();
    let db = state.db.lock().await;
    let items = backup::list_backup_items(&state.data_dir, &backup_dir, &db)
        .ok_or_else(|| "读不到备份目录（不存在 / 权限不足 / 所在盘未就绪）".to_string())?;
    // 只选属于该原文件的，然后走与批量清理同一条执行路径。
    //
    // 两种口径都认：`BackupItem.original` 优先取索引里的**完整原路径**，而版本历史
    // （`list_backups`）是按**备份文件名推导出的原文件名**分组的。前端从分组头传过来的
    // 是后者，如果只比 `i.original`，有索引记录的备份（绝大多数）一个都匹配不上。
    // 按名匹配会把不同目录的同名文件一起删——但那正是用户在分组里看到的内容。
    let mine: Vec<backup::BackupItem> = items
        .into_iter()
        .filter(|i| {
            i.original == original_path
                || backup::original_from_backup_name(&i.path) == original_path
        })
        .collect();
    if mine.is_empty() {
        return Err("该文件没有备份".into());
    }
    // 此处故意不给底线：用户明确要删这个文件的全部备份，前端会弹确认。
    let plan = backup::plan_cleanup(&mine, &backup::CleanupMode::All, false);
    let (deleted, freed, failed) = backup::delete_files_bulk(&plan.victims);
    let removed = deleted.len() as u32;
    backup::purge_index_rows(&db, &deleted);
    drop(db);
    audit_backup_deletion(
        &state.data_dir,
        "delete_backups_of_file",
        serde_json::json!({
            "originalPath": original_path, "removed": removed,
            "failed": failed, "freedBytes": freed
        }),
    );
    Ok(BackupCleanupResult {
        removed,
        freed_bytes: freed,
        healed_index_rows: 0,
        failed,
    })
}
// ===== 一键回滚 + 变更 Diff（P1）=====

/// 校验 backup_path 合法性：必须在 data_dir/backup_dir 内且以 .bak 结尾。
/// canonicalize 后做前缀校验，杜绝用备份通道越权读写任意文件（安全模块不削弱）。
fn assert_backup_path_in_scope(
    backup_path: &str,
    data_dir: &std::path::Path,
    backup_dir: &str,
) -> Result<PathBuf, String> {
    let expected_dir = data_dir.join(backup_dir);
    let expected_canon = expected_dir
        .canonicalize()
        .map_err(|e| format!("备份目录解析失败：{e}"))?;
    let bak_canon = PathBuf::from(backup_path)
        .canonicalize()
        .map_err(|_| "备份文件不存在或路径非法".to_string())?;
    let bak_str = bak_canon.to_string_lossy();
    if !bak_canon.starts_with(&expected_canon) || !bak_str.ends_with(".bak") {
        return Err("备份路径越权：必须为白名单备份目录内的 .bak 文件".into());
    }
    Ok(bak_canon)
}

/// 一键回滚：将指定 .bak 备份按原字节写回目标文件（保留原始编码）。
///
/// 安全（不削弱）：backup_path 限备份目录内 .bak；target_path 走白名单校验。
/// 还原前对当前目标再备一次（可继续撤销）；目标不存在（删除类操作）则直接恢复被删文件。
/// 自身写一条审计（关联新备份），使回滚动作也可追溯。
#[tauri::command(rename_all = "snake_case")]
pub async fn restore_file(
    state: State<'_, Arc<AppState>>,
    backup_path: String,
    target_path: String,
) -> Result<(), String> {
    let config = state.config.read().await;
    let data_dir = state.data_dir.clone();
    let backup_dir = config.backup_dir.clone();
    let backup_retention = config.backup_retention;
    let readonly_mode = config.readonly_mode;
    let allowed_extensions = config.allowed_extensions.clone();

    // 1) 安全校验 backup_path
    let bak_canon = assert_backup_path_in_scope(&backup_path, &data_dir, &backup_dir)?;
    // 2) 白名单校验 target（安全模块不削弱）
    let resolved = path::resolve_safe_path_cached(
        &target_path,
        &state.cached_roots(),
        config.whitelist_enabled,
    )?;
    drop(config);

    // 回滚也是写操作：与写工具一致，只读模式下拒绝、并校验扩展名白名单，
    // 避免经回滚通道绕过只读闸门或向非白名单扩展名写入。
    if readonly_mode {
        return Err("只读模式已开启，禁止恢复文件（写操作被拦截）".into());
    }
    crate::security::extension::assert_extension_allowed(&resolved, &allowed_extensions)?;

    // 3) 还原前再备一次（可继续撤销）——仅当目标已存在
    let mut new_backup: Option<PathBuf> = None;
    if resolved.exists() {
        let db = state.db.lock().await;
        new_backup = backup::backup_before_overwrite(&resolved, &backup_dir, &data_dir, &db)?;
        backup::prune_backups(&resolved, &backup_dir, &data_dir, backup_retention, &db)?;
        drop(db);
    }

    // 4) 原子写回：临时文件 + rename（保留原始字节 / 编码）
    let tmp = resolved.with_extension("tmp_restore");
    std::fs::copy(&bak_canon, &tmp).map_err(|e| format!("写入临时文件失败：{e}"))?;
    std::fs::rename(&tmp, &resolved).map_err(|e| format!("恢复文件失败：{e}"))?;

    // 5) 写审计（工具名 restore_file，关联本次新备份以便再撤销）
    let mut entry = audit::new_entry(
        "restore_file",
        &serde_json::json!({ "backupPath": backup_path, "targetPath": target_path }).to_string(),
        true,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    );
    entry.backup_path = new_backup
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    entry.target_path = Some(target_path.clone());
    audit::write_audit_log(&data_dir, &entry)?;

    Ok(())
}

// ===== 备份目录查看 + 清单（P0/P1）=====

/// 在系统文件管理器中打开备份目录（复用 reveal_install_dir 的 cmd start 思路，
/// 规避 explorer /select 的 DDE 转发导致不弹窗）。同时返回绝对路径供前端展示。
/// 目录可能尚不存在（从未产生备份）——先创建，确保资源管理器能打开。
#[tauri::command]
pub async fn reveal_backup_dir(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let config = state.config.read().await;
    let dir = state.data_dir.join(&config.backup_dir);
    drop(config);
    let dir_str = dir.to_string_lossy().into_owned();
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(windows)]
    {
        // 修复：漏加 CREATE_NO_WINDOW，cmd.exe 会一闪而过弹出黑框（对齐 firewall.rs 里
        // netsh/powershell 子进程的同款修复；run_command.rs 的 CREATE_NO_WINDOW 修复未覆盖到这里）。
        let mut command = std::process::Command::new("cmd");
        command.args(["/c", "start", "", &dir_str]);
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Err(e) = command.status() {
            return Err(format!("打开备份目录失败: {e}"));
        }
    }
    // 非 Windows 上根本没有 `cmd`，原来这里必然返回「No such file or directory」，
    // 「打开备份目录」按钮在 mac 上是死的。改走 opener 插件（与 reveal_install_dir 同一条路）。
    // Windows 分支保留原样不动：当年用 `cmd /c start` 正是为了规避 explorer /select 的
    // DDE 转发导致不弹窗，不能顺手「统一」掉。
    #[cfg(not(windows))]
    tauri_plugin_opener::open_path(&dir_str, None::<&str>)
        .map_err(|e| format!("打开备份目录失败: {e}"))?;
    Ok(dir_str)
}

#[derive(Debug, Serialize)]
pub struct BackupFileInfo {
    #[serde(rename = "backupPath")]
    pub backup_path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// 创建备份时记录的原始绝对路径（仍落在当前白名单内才返回）。白名单关闭
    /// 或该备份无对应索引记录（历史备份）时恒为空。
    pub targets: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct BackupGroupInfo {
    #[serde(rename = "originalFile")]
    pub original_file: String,
    pub count: usize,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    pub entries: Vec<BackupFileInfo>,
}

#[derive(Debug, Serialize)]
pub struct BackupListResult {
    pub dir: String,
    pub exists: bool,
    pub count: usize,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    pub groups: Vec<BackupGroupInfo>,
}

/// 列出全部 .bak 备份，按原文件名分组，并从 backup_index 表精确反查还原目标。
///
/// 安全（不削弱）：targets 仅在白名单开启时返回，且仍需再次经过 resolve_safe_path
/// 确认当前确实落在 allowed_roots 内（root 配置可能在备份之后被改过），不返回白名单外
/// 路径；白名单关闭时 targets 恒为空（还原交由 restore_file 再走一次白名单校验）。
#[tauri::command]
pub async fn list_backups(state: State<'_, Arc<AppState>>) -> Result<BackupListResult, String> {
    let config = state.config.read().await;
    let data_dir = state.data_dir.clone();
    let backup_dir_name = config.backup_dir.clone();
    let whitelist_enabled = config.whitelist_enabled;
    drop(config);

    let dir = data_dir.join(&backup_dir_name);
    let mut result = BackupListResult {
        dir: dir.to_string_lossy().into_owned(),
        exists: dir.exists(),
        count: 0,
        total_bytes: 0,
        groups: Vec::new(),
    };
    if !result.exists {
        return Ok(result);
    }

    let mut groups: std::collections::BTreeMap<String, BackupGroupInfo> =
        std::collections::BTreeMap::new();

    let rd = std::fs::read_dir(&dir).map_err(|e| format!("读取备份目录失败: {e}"))?;
    for entry in rd.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("bak") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = meta.len();
        // 文件名 = "{original}.{timestamp}.bak"（时间戳含下划线、无点）
        let stem = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let (original, ts) = match stem.rsplit_once('.') {
            Some((o, t)) => (o.to_string(), t.to_string()),
            None => (stem.clone(), String::new()),
        };
        let created_at = parse_backup_timestamp(&ts, &meta);
        let g = groups
            .entry(original.clone())
            .or_insert_with(|| BackupGroupInfo {
                original_file: original.clone(),
                count: 0,
                total_bytes: 0,
                entries: Vec::new(),
            });
        g.count += 1;
        g.total_bytes += size;
        g.entries.push(BackupFileInfo {
            backup_path: p.to_string_lossy().into_owned(),
            size_bytes: size,
            created_at,
            targets: Vec::new(),
        });
    }

    // 反查还原目标（仅白名单开启时）：从 backup_index 表精确读取创建备份时记录的原始绝对路径，
    // 不再对文件系统做"按文件名猜"的有边界遍历（旧实现受 max_depth=6/max_scan=8000 限制，
    // 对深层企业级仓库容易查不到）。旧备份（backup_index 上线前创建）无对应记录，
    // 查不到即 targets 为空，前端按钮相应禁用（已知、可接受的降级）。
    if whitelist_enabled && !groups.is_empty() {
        let db = state.db.lock().await;
        let mut index: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        if let Ok(mut stmt) = db.prepare("SELECT backup_path, original_path FROM backup_index") {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }) {
                for row in rows.filter_map(|r| r.ok()) {
                    index.insert(row.0, row.1);
                }
            }
        }
        drop(db);

        for g in groups.values_mut() {
            for e in g.entries.iter_mut() {
                if let Some(original_path) = index.get(&e.backup_path) {
                    // 仍需核实该路径当前确实落在白名单内（root 配置可能在备份之后被改过）。
                    if let Ok(resolved) =
                        path::resolve_safe_path_cached(original_path, &state.cached_roots(), true)
                    {
                        e.targets = vec![path::display_path(&resolved)];
                    }
                }
            }
        }
    }

    // 每组内按时间倒序（文件名时间戳字典序即时间序）
    for g in groups.values_mut() {
        g.entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    }
    result.groups = groups.into_values().collect();
    result.count = result.groups.iter().map(|g| g.count).sum();
    result.total_bytes = result.groups.iter().map(|g| g.total_bytes).sum();
    Ok(result)
}

/// 解析备份时间戳（文件名内嵌的 %Y%m%d_%H%M%S_%3f）；失败回退到文件修改时间。
fn parse_backup_timestamp(ts: &str, meta: &std::fs::Metadata) -> String {
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(ts, "%Y%m%d_%H%M%S_%3f") {
        return dt.format("%Y-%m-%d %H:%M:%S").to_string();
    }
    if let Ok(system_time) = meta.modified() {
        let dt: chrono::DateTime<chrono::Local> = system_time.into();
        return dt.format("%Y-%m-%d %H:%M:%S").to_string();
    }
    "未知时间".to_string()
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    /// "context" | "added" | "removed"
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct FileDiffResult {
    pub lines: Vec<DiffLine>,
    /// 触发护栏的原因（二进制 / 体积过大 / 行数过多）；非空时前端仅允许「还原」、不展示全量 diff。
    #[serde(rename = "guard")]
    pub guard: Option<String>,
    #[serde(rename = "beforeLines")]
    pub before_lines: usize,
    #[serde(rename = "afterLines")]
    pub after_lines: usize,
}

/// 变更 Diff：实时用 .bak（前）vs 当前文件（后）做行级 diff，不占存储。
///
/// 安全（不削弱）：同 restore_file —— backup_path 限备份目录内 .bak；target 走白名单校验。
/// 大文件 / 二进制 / 行数过多触发护栏，仅返回行数统计，避免前端卡死；护栏下仍允许「还原」。
#[tauri::command(rename_all = "snake_case")]
pub async fn get_file_diff(
    state: State<'_, Arc<AppState>>,
    backup_path: String,
    target_path: String,
) -> Result<FileDiffResult, String> {
    let config = state.config.read().await;
    let data_dir = state.data_dir.clone();
    let backup_dir = config.backup_dir.clone();

    // 1) 校验 backup_path
    let bak_canon = assert_backup_path_in_scope(&backup_path, &data_dir, &backup_dir)?;
    // 2) 白名单校验 target
    let resolved = path::resolve_safe_path_cached(
        &target_path,
        &state.cached_roots(),
        config.whitelist_enabled,
    )?;

    // 3) 读取 before（.bak）与 after（当前；不存在 = 已删除）
    let before_bytes = std::fs::read(&bak_canon).map_err(|e| format!("读取备份失败：{e}"))?;
    let after_bytes = if resolved.exists() {
        Some(std::fs::read(&resolved).map_err(|e| format!("读取当前文件失败：{e}"))?)
    } else {
        None
    };
    drop(config);

    let before_has_nul = before_bytes.contains(&0u8);
    let after_has_nul = after_bytes
        .as_ref()
        .map(|b| b.contains(&0u8))
        .unwrap_or(false);
    let big = before_bytes.len() > 1_000_000
        || after_bytes
            .as_ref()
            .map(|b| b.len() > 1_000_000)
            .unwrap_or(false);

    let before = String::from_utf8_lossy(&before_bytes).into_owned();
    let after = after_bytes
        .as_ref()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();

    let before_lines = before.lines().count();
    let after_lines = after.lines().count();
    let many = before_lines > 2000 || after_lines > 2000;

    let guard = if before_has_nul || after_has_nul {
        Some("文件含二进制内容，仅可一键还原，不可预览 diff".into())
    } else if big {
        Some("文件体积超过 1MB，仅可一键还原，不可预览 diff".into())
    } else if many {
        Some("变更行数过多（>2000），仅可一键还原，不可预览 diff".into())
    } else {
        None
    };

    if guard.is_some() {
        return Ok(FileDiffResult {
            lines: vec![],
            guard,
            before_lines,
            after_lines,
        });
    }

    // 行级 diff（复用 similar，已是项目依赖）
    let diff = TextDiff::from_lines(&before, &after);
    let lines: Vec<DiffLine> = diff
        .iter_all_changes()
        .map(|c| {
            let (sign, kind) = match c.tag() {
                similar::ChangeTag::Delete => ("-", "removed"),
                similar::ChangeTag::Insert => ("+", "added"),
                similar::ChangeTag::Equal => (" ", "context"),
            };
            DiffLine {
                kind: kind.into(),
                text: format!("{}{}", sign, c.value()),
            }
        })
        .collect();

    Ok(FileDiffResult {
        lines,
        guard: None,
        before_lines,
        after_lines,
    })
}

/// 相邻版本对比：两个 .bak 互为 before/after 做行级 diff（均限备份目录内）。
///
/// 安全（不削弱）：两个路径都经 `assert_backup_path_in_scope` 双重校验（必须在备份目录内、以 .bak 结尾），
/// 杜绝用对比通道越权读取任意文件。复用 get_file_diff 的护栏 + similar，零新依赖。
#[tauri::command(rename_all = "snake_case")]
pub async fn diff_backups(
    state: State<'_, Arc<AppState>>,
    from_path: String,
    to_path: String,
) -> Result<FileDiffResult, String> {
    let config = state.config.read().await;
    let data_dir = state.data_dir.clone();
    let backup_dir = config.backup_dir.clone();
    drop(config);

    // 双重校验：两个路径都需在备份目录内且为 .bak
    let from_canon = assert_backup_path_in_scope(&from_path, &data_dir, &backup_dir)?;
    let to_canon = assert_backup_path_in_scope(&to_path, &data_dir, &backup_dir)?;

    let from_bytes = std::fs::read(&from_canon).map_err(|e| format!("读取备份失败：{e}"))?;
    let to_bytes = std::fs::read(&to_canon).map_err(|e| format!("读取备份失败：{e}"))?;

    let from_has_nul = from_bytes.contains(&0u8);
    let to_has_nul = to_bytes.contains(&0u8);
    let big = from_bytes.len() > 1_000_000 || to_bytes.len() > 1_000_000;

    let from = String::from_utf8_lossy(&from_bytes).into_owned();
    let to = String::from_utf8_lossy(&to_bytes).into_owned();

    let before_lines = from.lines().count();
    let after_lines = to.lines().count();
    let many = before_lines > 2000 || after_lines > 2000;

    let guard = if from_has_nul || to_has_nul {
        Some("文件含二进制内容，仅可一键还原，不可预览 diff".into())
    } else if big {
        Some("文件体积超过 1MB，仅可一键还原，不可预览 diff".into())
    } else if many {
        Some("变更行数过多（>2000），仅可一键还原，不可预览 diff".into())
    } else {
        None
    };

    if guard.is_some() {
        return Ok(FileDiffResult {
            lines: vec![],
            guard,
            before_lines,
            after_lines,
        });
    }

    // 行级 diff（复用 similar，已是项目依赖）。from=较旧版本，to=较新版本。
    let diff = TextDiff::from_lines(&from, &to);
    let lines: Vec<DiffLine> = diff
        .iter_all_changes()
        .map(|c| {
            let (sign, kind) = match c.tag() {
                similar::ChangeTag::Delete => ("-", "removed"),
                similar::ChangeTag::Insert => ("+", "added"),
                similar::ChangeTag::Equal => (" ", "context"),
            };
            DiffLine {
                kind: kind.into(),
                text: format!("{}{}", sign, c.value()),
            }
        })
        .collect();

    Ok(FileDiffResult {
        lines,
        guard: None,
        before_lines,
        after_lines,
    })
}
