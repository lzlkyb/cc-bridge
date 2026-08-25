//! 配置域的 IPC 命令：`save_config`、白名单配置组（新建/删除/重命名/切换）、
//! 令牌重生成，以及配置的导入/导出。
//!
//! D19 方案 C 第 4 批（最后一批）。
//!
//! **为何 config 与 config_io 合成一个文件**（而非规划里写的两个）：`commands.rs` 的
//! 两条单元测试一条测 `switch_root_profile`（config）、一条测 `import_config`（config_io），
//! 且共用同一个 `SEQ` 计数器与临时目录搭建。拆成两个文件就得把测试模块也劈开、
//! 复制那套 setup——收益不抵代价，所以按「测试的归属」把两者并在一处。
//!
//! ❗ 那条 `switch_root_profile_refreshes_cached_roots` 是**安全回归测试**：切换配置组后
//! 必须刷新 `canonicalized_roots`，漏刷不是显示问题而是安全缺陷（UI 显示已切到新组，
//! 而所有走 `state.cached_roots()` 的工具校验仍按旧组放行）。它必须跟着被测代码走，
//! 留在聚合文件里就断了守护。
//!
//! **为何叫 `config_cmds` 而不是 `config`**：`crate::config`（`src/config.rs`）已存在。
//! 与第 2/3 批的 `backup_cmds` / `firewall_cmds` 同一理由。
//!
//! 本文件是**纯搬动**：函数体逐字节未改，可用 `tools/fingerprint.py` 比对哈希验证。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::audit;
use crate::config::save_config_field;
use crate::security::auth;
use crate::security::path;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ConfigPatch {
    #[serde(rename = "allowedRoots")]
    pub allowed_roots: Option<Vec<String>>,
    #[serde(rename = "allowedExtensions")]
    pub allowed_extensions: Option<Vec<String>>,
    #[serde(rename = "maxFileSizeBytes")]
    pub max_file_size_bytes: Option<u64>,
    #[serde(rename = "rateLimitMaxRequests")]
    pub rate_limit_max_requests: Option<u32>,
    #[serde(rename = "rateLimitWindowMs")]
    pub rate_limit_window_ms: Option<u64>,
    #[serde(rename = "backupDir")]
    pub backup_dir: Option<String>,
    #[serde(rename = "backupRetention")]
    pub backup_retention: Option<u32>,
    #[serde(rename = "auditRetentionDays")]
    pub audit_retention_days: Option<u32>,
    /// 后台命令结束后保留时长（秒），可调。
    #[serde(rename = "commandCleanupSecs")]
    pub command_cleanup_secs: Option<u64>,
    pub host: Option<String>,
    pub port: Option<u16>,
    #[serde(rename = "whitelistEnabled")]
    pub whitelist_enabled: Option<bool>,
    #[serde(rename = "readonlyMode")]
    pub readonly_mode: Option<bool>,
    #[serde(rename = "backupEnabled")]
    pub backup_enabled: Option<bool>,
    #[serde(rename = "auditEnabled")]
    pub audit_enabled: Option<bool>,
    #[serde(rename = "rateLimitEnabled")]
    pub rate_limit_enabled: Option<bool>,
    #[serde(rename = "encodingDetectEnabled")]
    pub encoding_detect_enabled: Option<bool>,
    #[serde(rename = "shellEnabled")]
    pub shell_enabled: Option<bool>,
    /// 命令执行壳层：cmd 或 bash。前端「命令执行壳层」分段控件写入。
    #[serde(rename = "shellType")]
    pub shell_type: Option<String>,
    /// MCP 传输协议：http 或 sse。前端「MCP 传输协议」分段控件写入。
    pub transport: Option<String>,
    /// 用户接入时确认的作用域（user/project）。仅首次接入复制命令时由前端写入。
    #[serde(rename = "scope")]
    pub scope: Option<String>,
    /// 用户接入时确认的项目路径（项目级 scope 时用于 cd 前缀）。
    /// 跟随连接页选择，供托盘「复制 IP 替换命令」生成带 cd 的精确命令，与 IpChangedBanner 对齐。
    #[serde(rename = "projectPath")]
    pub project_path: Option<String>,
    /// 命令白名单开关（Layer 2，④P0-1）。前端「安全」页写入。
    #[serde(rename = "commandAllowlistEnabled")]
    pub command_allowlist_enabled: Option<bool>,
    /// 命令白名单程序列表（Layer 2，④P0-1）。前端「安全」页写入。
    #[serde(rename = "commandAllowlist")]
    pub command_allowlist: Option<Vec<String>>,
    /// 后台命令完成通知开关。前端「功能开关」卡写入。
    #[serde(rename = "notifyCommandComplete")]
    pub notify_command_complete: Option<bool>,
    /// 任务完成通知开关（push_notification 工具总开关）。前端「功能开关」卡写入。
    #[serde(rename = "notifyTaskComplete")]
    pub notify_task_complete: Option<bool>,
    /// 关窗时释放界面内存。前端「功能开关」卡写入。
    #[serde(rename = "releaseWebviewOnClose")]
    pub release_webview_on_close: Option<bool>,
    /// SSH 终端总开关（仅布尔，无凭据，可走通用 patch）。
    #[serde(rename = "sshEnabled")]
    pub ssh_enabled: Option<bool>,
    /// 终端拖拽即选开关。前端「高级」卡写入。
    #[serde(rename = "sshDragSelectEnabled")]
    pub ssh_drag_select_enabled: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ConfigSaveResult {
    pub ok: bool,
    pub changed: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(rename = "restartRequired")]
    pub restart_required: bool,
}

#[tauri::command]
pub async fn save_config(
    state: State<'_, Arc<AppState>>,
    patch: ConfigPatch,
) -> Result<ConfigSaveResult, String> {
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    let mut changed = Vec::new();
    let mut restart_required = false;

    macro_rules! apply_field {
        ($field:ident, $key:expr, $val:expr) => {
            if let Some(v) = $val {
                // 先持久化再改内存：若 save_config_field 失败（`?` 提前返回），内存不会领先于
                // DB。旧顺序先改内存后写盘，写盘失败时内存已变、DB 未变，产生不一致。
                save_config_field(&db, $key, &serde_json::to_value(&v).unwrap())?;
                config.$field = v.clone();
                changed.push($key.into());
            }
        };
    }

    apply_field!(allowed_roots, "allowed_roots", &patch.allowed_roots);
    apply_field!(
        allowed_extensions,
        "allowed_extensions",
        &patch.allowed_extensions
    );
    apply_field!(
        max_file_size_bytes,
        "max_file_size_bytes",
        &patch.max_file_size_bytes
    );
    apply_field!(
        rate_limit_max_requests,
        "rate_limit_max_requests",
        &patch.rate_limit_max_requests
    );
    apply_field!(
        rate_limit_window_ms,
        "rate_limit_window_ms",
        &patch.rate_limit_window_ms
    );
    apply_field!(backup_dir, "backup_dir", &patch.backup_dir);
    apply_field!(
        backup_retention,
        "backup_retention",
        &patch.backup_retention
    );
    apply_field!(
        audit_retention_days,
        "audit_retention_days",
        &patch.audit_retention_days
    );
    apply_field!(
        command_cleanup_secs,
        "command_cleanup_secs",
        &patch.command_cleanup_secs
    );
    apply_field!(
        whitelist_enabled,
        "whitelist_enabled",
        &patch.whitelist_enabled
    );
    apply_field!(readonly_mode, "readonly_mode", &patch.readonly_mode);
    apply_field!(backup_enabled, "backup_enabled", &patch.backup_enabled);
    apply_field!(audit_enabled, "audit_enabled", &patch.audit_enabled);
    apply_field!(
        rate_limit_enabled,
        "rate_limit_enabled",
        &patch.rate_limit_enabled
    );
    apply_field!(
        encoding_detect_enabled,
        "encoding_detect_enabled",
        &patch.encoding_detect_enabled
    );
    apply_field!(shell_enabled, "shell_enabled", &patch.shell_enabled);
    // 命令执行壳层：cmd（默认）/ bash。仅接受这两个值，其它值由 config.rs 解析时回退 cmd。
    apply_field!(shell_type, "shell_type", &patch.shell_type);
    apply_field!(transport, "transport", &patch.transport);
    // Layer 2 命令白名单（④P0-1）：开关 + 程序列表。仅当二者均被提供时更新。
    apply_field!(
        command_allowlist_enabled,
        "command_allowlist_enabled",
        &patch.command_allowlist_enabled
    );
    apply_field!(
        command_allowlist,
        "command_allowlist",
        &patch.command_allowlist
    );
    // 通知开关
    apply_field!(
        notify_command_complete,
        "notify_command_complete",
        &patch.notify_command_complete
    );
    apply_field!(
        notify_task_complete,
        "notify_task_complete",
        &patch.notify_task_complete
    );
    apply_field!(
        release_webview_on_close,
        "release_webview_on_close",
        &patch.release_webview_on_close
    );
    // SSH 终端总开关（仅布尔，无凭据，安全可走通用 patch）。
    let ssh_was_enabled = config.ssh_enabled;
    apply_field!(ssh_enabled, "ssh_enabled", &patch.ssh_enabled);
    // 终端拖拽即选（纯布尔，无副作用，安全可走通用 patch）。
    apply_field!(
        ssh_drag_select_enabled,
        "ssh_drag_select_enabled",
        &patch.ssh_drag_select_enabled
    );
    // 🔴 这个开关必须是**断路器**：由开变关时立刻杀掉全部活会话。
    // 否则关掉后已经开着的终端照样能输入、能操作远程主机，开关就只是
    // 「能不能新建」而不是安全边界。此处仍持有 config 写锁，而该方法只碰
    // ssh_sessions（DashMap），不会回头拿 config 锁，无死锁。
    if ssh_was_enabled && !config.ssh_enabled {
        state.kill_all_ssh_sessions();
    }
    // 首次接入复制命令时由前端写入，记录 cc-bridge 被注册到远程的作用域，
    // 供后续 IP 变化 / Token 重生成生成精确 sed 命令（方案 A）。
    // scope 在 config 中也是 Option<String>，与 apply_field! 宏的 "T vs Option<T>" 假设不符，故单独处理。
    if let Some(ref s) = patch.scope {
        save_config_field(&db, "scope", &serde_json::to_value(s).unwrap())?;
        config.scope = Some(s.clone());
        changed.push("scope".into());
    }
    // project_path 同 scope 为 Option<String>，apply_field! 宏假设不符，单独处理。
    if let Some(ref p) = patch.project_path {
        save_config_field(&db, "project_path", &serde_json::to_value(p).unwrap())?;
        config.project_path = Some(p.clone());
        changed.push("project_path".into());
    }

    if let Some(ref h) = patch.host {
        if *h != config.host {
            save_config_field(&db, "host", &serde_json::to_value(h).unwrap())?;
            config.host = h.clone();
            changed.push("host".into());
            restart_required = true;
        }
    }
    if let Some(p) = patch.port {
        if p != config.port {
            save_config_field(&db, "port", &serde_json::to_value(p).unwrap())?;
            config.port = p;
            changed.push("port".into());
            restart_required = true;
        }
    }

    // 反向同步：在当前组里增删目录时，把生效集合写回该组的存档。
    // 不同步的后果：“切走再切回来”会用旧存档覆盖掉刚改的目录，看起来就像改动丢了。
    // 注意方向：`allowed_roots` 仍是唯一事实源，这里只是让存档跟上它。
    if patch.allowed_roots.is_some() {
        let active = config.active_profile.clone();
        let roots = config.allowed_roots.clone();
        if let Some(p) = config.root_profiles.iter_mut().find(|p| p.name == active) {
            p.roots = roots;
        }
        save_config_field(
            &db,
            "root_profiles",
            &serde_json::to_value(&config.root_profiles).unwrap(),
        )?;
    }

    // 保留天数一变就后台跑一次清理，不再等下次启动。
    // 原行为：`save_config` 只存值，而清理只在启动时跑——用户把 30 天改成 7 天后
    // 什么都不会发生，很容易误以为改完就生效了。
    // 放后台：大 audit.log 的重写可能耗时，不能卡住保存配置这个交互
    // （与启动那次同理，E-P2-4 当时就是为此改成后台的）。
    if patch.audit_retention_days.is_some() {
        let dir = state.data_dir.clone();
        let retention = config.audit_retention_days;
        tauri::async_runtime::spawn(async move {
            match audit::cleanup_old_entries(&dir, retention) {
                Ok(0) => {}
                Ok(n) => log::info!("保留天数改为 {retention} 天，已删除 {n} 条过期审计记录"),
                Err(e) => log::warn!("保留天数变更后清理审计日志失败：{e}"),
            }
        });
    }

    // 白名单根目录缓存随配置刷新（性能优化）：先释放 config 写锁，避免下面读锁死等。
    drop(config);
    state.refresh_canonicalized_roots(&state.config.read().await.allowed_roots);

    Ok(ConfigSaveResult {
        ok: true,
        changed,
        warnings: vec![],
        restart_required,
    })
}

// ===== 白名单配置组（按项目切换）=====
//
// 安全要点：以下命令**只**经 Tauri invoke 暴露给本机面板，不注册为 MCP 工具——
// 远程 AI 不能自行更换自己的可访问范围。这是选「人工切换配置组」而非
// 「按远程项目自动切」的核心理由。
//
// 另一个要点：切换组 = 把该组 roots 写进 `allowed_roots`，然后跑与 `save_config`
// 完全相同的收尾（持久化 → 刷新 canonicalize 缓存）。不新增任何安全关键路径。

/// 组名校验：去首尾空白 → 非空 → 长度上限 → 不重名。
/// `allow_same` 传重命名时的原名（允许改成自己，否则“只改大小写”之类会被误判重名）。
/// 重名直接拒绝而不自动加后缀：两个看起来一样的组比报错更害人。
fn validate_profile_name(
    name: &str,
    existing: &[crate::config::RootProfile],
    allow_same: Option<&str>,
) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("组名不能为空".into());
    }
    if n.chars().count() > 40 {
        return Err("组名过长（最多 40 字）".into());
    }
    if existing
        .iter()
        .any(|p| p.name == n && Some(p.name.as_str()) != allow_same)
    {
        return Err(format!("已存在同名配置组「{n}」"));
    }
    Ok(n.to_string())
}

/// 新建配置组。`copy_current=true` 时用当前生效集合作为初内容，否则建空组。
/// `switch=true` 则建完立即切过去。
#[tauri::command]
pub async fn create_root_profile(
    state: State<'_, Arc<AppState>>,
    name: String,
    copy_current: bool,
    switch: bool,
) -> Result<(), String> {
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    let clean = validate_profile_name(&name, &config.root_profiles, None)?;
    let roots = if copy_current {
        config.allowed_roots.clone()
    } else {
        vec![]
    };
    config.root_profiles.push(crate::config::RootProfile {
        name: clean.clone(),
        roots: roots.clone(),
    });
    save_config_field(
        &db,
        "root_profiles",
        &serde_json::to_value(&config.root_profiles).unwrap(),
    )?;
    if switch {
        apply_profile_switch(&db, &mut config, &clean, roots)?;
    }
    drop(config);
    state.refresh_canonicalized_roots(&state.config.read().await.allowed_roots);
    Ok(())
}

/// 删除配置组。**只删这份目录清单，不碰目录里的任何文件。**
/// 两条护栏：不能删当前组（否则生效集合无归属），也不能删到一个不剩。
#[tauri::command]
pub async fn delete_root_profile(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<(), String> {
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    if config.active_profile == name {
        return Err("不能删除当前使用中的配置组，请先切到其它组".into());
    }
    if config.root_profiles.len() <= 1 {
        return Err("至少需保留一个配置组".into());
    }
    let before = config.root_profiles.len();
    config.root_profiles.retain(|p| p.name != name);
    if config.root_profiles.len() == before {
        return Err(format!("配置组「{name}」不存在"));
    }
    save_config_field(
        &db,
        "root_profiles",
        &serde_json::to_value(&config.root_profiles).unwrap(),
    )?;
    Ok(())
}

/// 重命名配置组。改的是当前组时，`active_profile` 指针要跟着改，
/// 否则下次 `normalize_profiles` 会因为“指针指向不存在的组”而默默回落到第一个组。
#[tauri::command]
pub async fn rename_root_profile(
    state: State<'_, Arc<AppState>>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    let clean = validate_profile_name(&new_name, &config.root_profiles, Some(&old_name))?;
    match config.root_profiles.iter_mut().find(|p| p.name == old_name) {
        Some(p) => p.name = clean.clone(),
        None => return Err(format!("配置组「{old_name}」不存在")),
    }
    save_config_field(
        &db,
        "root_profiles",
        &serde_json::to_value(&config.root_profiles).unwrap(),
    )?;
    if config.active_profile == old_name {
        config.active_profile = clean;
        save_config_field(
            &db,
            "active_profile",
            &serde_json::to_value(&config.active_profile).unwrap(),
        )?;
    }
    Ok(())
}

/// 切换到指定配置组：把该组 roots 写进生效集合，并刷新白名单缓存 + 记审计。
///
/// 已在跑的后台命令不会被杀，但它后续经 cc-bridge 的文件操作按**新**白名单校验。
#[tauri::command]
pub async fn switch_root_profile(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<(), String> {
    switch_root_profile_inner(&state, &name).await
}

/// 纯逻辑入口（与 `import_config_inner` 同一套路）：不依赖 Tauri `State`，
/// 便于单元测试直达——「切换后必须刷新白名单缓存」这条安全不变量得能被测出来。
pub(crate) async fn switch_root_profile_inner(
    state: &Arc<AppState>,
    name: &str,
) -> Result<(), String> {
    let name = name.to_string();
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    let from = config.active_profile.clone();
    let roots = config
        .root_profiles
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| format!("配置组「{name}」不存在"))?
        .roots
        .clone();
    let count = roots.len();
    apply_profile_switch(&db, &mut config, &name, roots)?;
    drop(config);
    drop(db);

    // 刷新 canonicalize 缓存——漏了这一步就是安全缺陷：UI 显示已切换，
    // 而路径校验还在用旧根目录（import_config 历史上正是漏在这里，有回归测试）。
    state.refresh_canonicalized_roots(&state.config.read().await.allowed_roots);

    let entry = audit::new_entry(
        "switch_root_profile",
        &serde_json::json!({ "from": from, "to": name, "rootCount": count }).to_string(),
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
    let _ = audit::write_audit_log(&state.data_dir, &entry);
    Ok(())
}

/// 切换的共用写入：先落盘再改内存（与 save_config 的 apply_field! 同一约定，
/// 避免写盘失败时内存领先于 DB）。不在此刷缓存：谁持有锁谁负责，由调用方
/// 释锁后统一刷。
fn apply_profile_switch(
    db: &rusqlite::Connection,
    config: &mut crate::config::BridgeConfig,
    name: &str,
    roots: Vec<String>,
) -> Result<(), String> {
    save_config_field(db, "allowed_roots", &serde_json::to_value(&roots).unwrap())?;
    save_config_field(db, "active_profile", &serde_json::to_value(name).unwrap())?;
    config.allowed_roots = roots;
    config.active_profile = name.to_string();
    Ok(())
}

#[tauri::command]
pub async fn regenerate_token(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let new_token = auth::generate_token();
    let db = state.db.lock().await;
    save_config_field(&db, "token", &serde_json::to_value(&new_token).unwrap())?;
    let mut config = state.config.write().await;
    config.token = new_token.clone();
    Ok(new_token)
}

// ===== 配置导入/导出（C8）=====

#[tauri::command]
pub async fn export_config(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let config = state.config.read().await;
    export_config_json(&config)
}

/// `export_config` 的纯逻辑入口。抽出来是为了让脱敏不变量能被直接单测（同
/// `import_config_inner`）——它守的是密钥不外泄，不能只靠人看。
pub(crate) fn export_config_json(config: &crate::config::BridgeConfig) -> Result<String, String> {
    // M1 修复：不导出 Bearer token（唯一远程访问凭证）。克隆后脱敏再序列化，
    // 避免导出的配置文件被备份/转发/入库时泄露凭证。导入端 token 为空时会保留现有或重新生成。
    let mut export = config.clone();
    export.token = String::new();
    // 🔴 外挂 MCP 桥的配置**不导出**，两个理由，任一个单独成立：
    //
    // 1. `env` 里是真的 API key（本机 `paper_search_mcp` 就带一个）。不摸掉的话，
    //    点一下「导出配置」就把密钥明文写进了一个会被备份 / 转发的文件——
    //    跟 token 同一类风险（S7）。
    // 2. 它写的是“要启动哪个可执行文件”。一份能四处传的配置文件不应该携带执行通道（S1）。
    //
    // 不担心导出/导入往返会丢东西：`import_config_inner` 同样**忽略**这两个字段，
    // 两边是一致的。
    export.external_mcp_enabled = false;
    export.external_mcp_servers = vec![];
    serde_json::to_string_pretty(&export).map_err(|e| format!("序列化配置失败：{e}"))
}

/// `import_config` 的纯逻辑入口：解析 → 白名单兜底校验 → 落库 → 写 config → 刷新白名单缓存。
///
/// 抽出来是为了让回归测试能直达「写 config 后必须刷新缓存」这一不变量，而不触发
/// Tauri `State` 包装与 `restart_server` 的端口副作用（见文件末尾 `import_config_refreshes_cached_roots`）。
pub(crate) async fn import_config_inner(
    state: &Arc<AppState>,
    json: &str,
) -> Result<ConfigSaveResult, String> {
    let mut incoming: crate::config::BridgeConfig =
        serde_json::from_str(json).map_err(|e| format!("配置解析失败：{e}"))?;
    // M1 配套：导出已脱敏 token（空）。导入时 token 为空则保留现有、现有也空则生成新，
    // 避免把鉴权凭证清空（空 token 会导致鉴权被绕过）。
    if incoming.token.trim().is_empty() {
        let cur = state.config.read().await.token.clone();
        incoming.token = if cur.trim().is_empty() {
            crate::security::auth::generate_token()
        } else {
            cur
        };
    }

    // 白名单兜底校验（复用 security::path 白名单逻辑，不可绕过）。
    // incoming 尚未写入 state，用其自身 roots 预 canonicalize 的本地缓存集合校验。
    let incoming_roots = crate::security::path::canonicalize_roots(&incoming.allowed_roots);
    for root in &incoming.allowed_roots {
        if let Err(e) =
            path::resolve_safe_path_cached(root, &incoming_roots, incoming.whitelist_enabled)
        {
            return Err(format!("白名单目录校验失败「{}」：{}", root, e));
        }
    }

    // 🔴 外挂 MCP 桥的配置**不受导入影响**，原样保留本机现有值。
    //
    // 不这么做的后果：导入一份 `external_mcp_enabled: true` + 某条 `enabled: true`
    // 且 command 指向任意程序的 JSON，就能直接给远程开出一条执行通道——
    // 不过 `mcp_bridge_cmds::validate`（名字 / stdio / S8 自我引用）、不弹风险确认、
    // 不写审计，而那八个专用命令存在的全部理由就是拦这个（S1）。
    // 顺带也避开了第二个坑：导入改掉 command 后，旧子进程仍在连接池里。
    //
    // 导出端（`export_config`）同样不写这两个字段，两边对得上。
    {
        let cur = state.config.read().await;
        incoming.external_mcp_enabled = cur.external_mcp_enabled;
        incoming.external_mcp_servers = cur.external_mcp_servers.clone();
    }

    let db = state.db.lock().await;
    crate::config::save_full_config(&db, &incoming)?;
    drop(db);

    *state.config.write().await = incoming;

    // 白名单根缓存随导入刷新（性能优化）：与 save_config 一致，写完 config 后用最新 roots 重算，
    // 否则缓存仍指向旧 roots，导致后续工具校验误放行/误拒绝。
    state.refresh_canonicalized_roots(&state.config.read().await.allowed_roots);

    Ok(ConfigSaveResult {
        ok: true,
        changed: vec!["(全部配置)".into()],
        warnings: vec![],
        restart_required: true,
    })
}

#[tauri::command]
pub async fn import_config(
    state: State<'_, Arc<AppState>>,
    json: String,
) -> Result<ConfigSaveResult, String> {
    let result = import_config_inner(state.inner(), &json).await;
    // 仅成功时重启服务使 host/port 等配置生效（失败时不重启，与原语义一致）
    if result.is_ok() {
        crate::mcp::http::restart_server(state.inner()).await;
        state
            .mcp_running
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    result
}

// ===== 单元测试 =====

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BridgeConfig;
    use crate::db;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 回归测试（安全）：`switch_root_profile` 切换配置组后**必须**刷新
    /// `canonicalized_roots`。漏刷的后果不是显示问题而是**安全缺陷**：UI 与
    /// `get_status` 都显示已切到新组，而所有走 `state.cached_roots()` 的工具校验
    /// 仍按旧组的根目录放行 / 拒给。若有人删掉 `switch_root_profile_inner` 里的
    /// `refresh_canonicalized_roots` 一行，下面第 2 条断言会直接失败。
    #[tokio::test]
    async fn switch_root_profile_refreshes_cached_roots() {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir_a: PathBuf =
            std::env::temp_dir().join(format!("cc-bridge-prof-a-{}-{}", std::process::id(), n));
        let dir_b: PathBuf =
            std::env::temp_dir().join(format!("cc-bridge-prof-b-{}-{}", std::process::id(), n));
        for d in [&dir_a, &dir_b] {
            let _ = std::fs::remove_dir_all(d);
            std::fs::create_dir_all(d).expect("create dir");
        }
        let root_a = dir_a.to_string_lossy().into_owned();
        let root_b = dir_b.to_string_lossy().into_owned();

        let conn = db::init_database(Path::new(&dir_a)).expect("init db");
        let cfg = BridgeConfig {
            allowed_roots: vec![root_a.clone()],
            root_profiles: vec![
                crate::config::RootProfile {
                    name: "A组".into(),
                    roots: vec![root_a.clone()],
                },
                crate::config::RootProfile {
                    name: "B组".into(),
                    roots: vec![root_b.clone()],
                },
            ],
            active_profile: "A组".into(),
            ..BridgeConfig::default()
        };
        let state = Arc::new(AppState::new(conn, cfg, dir_a.clone()));

        assert_eq!(
            state.cached_roots(),
            crate::security::path::canonicalize_roots(std::slice::from_ref(&root_a)),
            "切换前缓存应为 A 组"
        );

        super::switch_root_profile_inner(&state, "B组")
            .await
            .expect("切换应成功");

        // 1) 生效集合与当前组名都已换成 B 组
        assert_eq!(
            state.config.read().await.allowed_roots,
            vec![root_b.clone()]
        );
        assert_eq!(state.config.read().await.active_profile, "B组");
        // 2) 关键：白名单缓存必须跟着换
        assert_eq!(
            state.cached_roots(),
            crate::security::path::canonicalize_roots(std::slice::from_ref(&root_b)),
            "切换后缓存必须等于 B 组的 canonicalize——漏刷即安全缺陷"
        );

        // 3) 切到不存在的组必须报错，且不得改动任何状态
        assert!(super::switch_root_profile_inner(&state, "不存在的组")
            .await
            .is_err());
        assert_eq!(state.config.read().await.active_profile, "B组");

        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    /// 回归测试：import_config 写入新的 `allowed_roots` 后**必须**刷新白名单缓存
    /// （`canonicalized_roots`），否则 `cached_roots()` 仍指向旧 roots，导致后续所有
    /// 走 `state.cached_roots()` 的工具校验误放行/误拒绝。
    ///
    /// 复现 #1-A 复审发现的 `import_config` 漏刷缓存 bug：若有人把
    /// `import_config_inner` 里的 `refresh_canonicalized_roots(...)` 一行删掉，
    /// 本测试的"缓存必须等于新 roots"断言会直接失败——这正是本测试存在的意义。
    #[tokio::test]
    async fn import_config_refreshes_cached_roots() {
        // 两个不同目录，确保"导入后缓存是否跟着变"可被明确测出（若用同一目录则无差异）。
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir_a: PathBuf = std::env::temp_dir().join(format!(
            "cc-bridge-import-test-a-{}-{}-{}",
            std::process::id(),
            n,
            "a"
        ));
        let dir_b: PathBuf = std::env::temp_dir().join(format!(
            "cc-bridge-import-test-b-{}-{}-{}",
            std::process::id(),
            n,
            "b"
        ));
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
        std::fs::create_dir_all(&dir_a).expect("create dir_a");
        std::fs::create_dir_all(&dir_b).expect("create dir_b");

        let root_a = dir_a.to_string_lossy().into_owned();
        let root_b = dir_b.to_string_lossy().into_owned();

        // 初始 state：白名单 = [dir_a]
        let conn = db::init_database(Path::new(&dir_a)).expect("init db");
        let cfg = BridgeConfig {
            allowed_roots: vec![root_a.clone()],
            ..BridgeConfig::default()
        };
        let state = Arc::new(AppState::new(conn, cfg, dir_a.clone()));

        // 导入前：缓存必须等于 [dir_a] 的 canonicalize 结果
        let expected_a =
            crate::security::path::canonicalize_roots(&state.config.read().await.allowed_roots);
        assert_eq!(
            state.cached_roots(),
            expected_a,
            "导入前缓存应等于 [dir_a] 的 canonicalize"
        );

        // 构造 incoming 配置，白名单改为 [dir_b]
        let incoming = BridgeConfig {
            allowed_roots: vec![root_b.clone()],
            ..BridgeConfig::default()
        };
        let json = serde_json::to_string(&incoming).expect("serialize config");

        // 直达纯逻辑入口（不经过 restart_server，无端口副作用）
        let result = super::import_config_inner(&state, &json).await;
        assert!(result.is_ok(), "import_config 应成功：{:?}", result.err());

        // 导入后 1：config 自身必须已更新为 [dir_b]
        let cfg_roots = state.config.read().await.allowed_roots.clone();
        assert_eq!(
            cfg_roots,
            vec![root_b.clone()],
            "导入后 config.allowed_roots 应更新为 [dir_b]"
        );

        // 导入后 2（关键）：缓存必须同步刷新为 [dir_b]，否则白名单校验会误放行/误拒绝
        let expected_b = crate::security::path::canonicalize_roots(&cfg_roots);
        assert_eq!(
            state.cached_roots(),
            expected_b,
            "导入后缓存必须刷新为 [dir_b] 的 canonicalize，否则白名单校验会误放行/误拒绝"
        );

        // 导入后 3：缓存不应仍停留在导入前的旧 roots（删掉刷新行时此断言必败）
        assert_ne!(
            state.cached_roots(),
            expected_a,
            "缓存不应仍指向导入前的旧 roots [dir_a]"
        );

        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    fn mcp_spec() -> crate::mcp::bridge::config::ExternalMcpServer {
        crate::mcp::bridge::config::ExternalMcpServer {
            name: "paper".into(),
            transport: "stdio".into(),
            command: "python.exe".into(),
            args: vec!["-m".into(), "paper_search_mcp.server".into()],
            env: vec![("API_KEY".into(), "sk-live-super-secret".into())],
            cwd: None,
            enabled: true,
            allow_remote_cwd: false,
        }
    }

    /// 🔴 回归测试（安全）：导出的配置**不得含外挂 MCP server 的 env 值**。
    ///
    /// 旧实现只脱敏了 `token`，而 `external_mcp_servers` 跟着 `BridgeConfig` 一起
    /// 序列化，于是点一下「导出配置」就把 API key 明文写进了文件（S7）。
    /// 把那两行脱敏删掉，本测试必败。
    #[test]
    fn export_never_leaks_external_mcp_env() {
        let cfg = BridgeConfig {
            token: "tok-should-not-appear".into(),
            external_mcp_enabled: true,
            external_mcp_servers: vec![mcp_spec()],
            ..BridgeConfig::default()
        };
        let json = super::export_config_json(&cfg).expect("export");
        assert!(!json.contains("sk-live"), "env 值泄露了：{json}");
        assert!(!json.contains("tok-should-not-appear"), "token 泄露了");
        // 连名字与命令都不带：它写的是“要启动哪个可执行文件”，
        // 一份能四处传的配置文件不应该携带执行通道（S1）。
        assert!(
            !json.contains("paper_search_mcp"),
            "外挂 server 不应导出：{json}"
        );
    }

    /// 🔴 回归测试（安全）：`import_config` **不得改动**外挂 MCP 桥的配置。
    ///
    /// 旧实现是整体替换 config，于是导入一份 `external_mcp_enabled: true` +
    /// 某条 `enabled: true` 且 command 指向任意程序的 JSON，就能直接给远程
    /// 开出一条执行通道——不过三道校验、不弹风险确认、不写审计（S1）。
    #[tokio::test]
    async fn import_cannot_touch_external_mcp() {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir: PathBuf =
            std::env::temp_dir().join(format!("cc-bridge-mcp-import-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create dir");

        let conn = db::init_database(Path::new(&dir)).expect("init db");
        // 本机现状：总开关关，一条已配置的 server。
        let cfg = BridgeConfig {
            allowed_roots: vec![dir.to_string_lossy().into_owned()],
            external_mcp_enabled: false,
            external_mcp_servers: vec![mcp_spec()],
            ..BridgeConfig::default()
        };
        let state = Arc::new(AppState::new(conn, cfg, dir.clone()));

        // 恶意/粗心的导入：想把总开关打开并换成另一条 server。
        let mut evil = mcp_spec();
        evil.name = "evil".into();
        evil.command = "cmd".into();
        let incoming = BridgeConfig {
            allowed_roots: vec![dir.to_string_lossy().into_owned()],
            external_mcp_enabled: true,
            external_mcp_servers: vec![evil],
            ..BridgeConfig::default()
        };
        let json = serde_json::to_string(&incoming).expect("serialize");
        super::import_config_inner(&state, &json)
            .await
            .expect("import");

        let after = state.config.read().await;
        assert!(!after.external_mcp_enabled, "导入不得打开总开关");
        assert_eq!(after.external_mcp_servers.len(), 1);
        assert_eq!(
            after.external_mcp_servers[0].name, "paper",
            "导入不得替换外挂 server 列表"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
