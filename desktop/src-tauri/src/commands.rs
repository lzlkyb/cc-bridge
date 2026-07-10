use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::audit;
use crate::browse;
use crate::config::save_config_field;
use crate::network;
use crate::security::auth;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub version: String,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: u64,
    #[serde(rename = "allowedRoots")]
    pub allowed_roots: Vec<String>,
    #[serde(rename = "allowedExtensions")]
    pub allowed_extensions: Vec<String>,
    #[serde(rename = "maxFileSizeBytes")]
    pub max_file_size_bytes: u64,
    #[serde(rename = "rateLimit")]
    pub rate_limit: RateLimitInfo,
    #[serde(rename = "backupDir")]
    pub backup_dir: String,
    #[serde(rename = "backupRetention")]
    pub backup_retention: u32,
    #[serde(rename = "auditRetentionDays")]
    pub audit_retention_days: u32,
    pub host: String,
    pub port: u16,
    pub stats: StatsInfo,
    #[serde(rename = "connectCommand")]
    pub connect_command: String,
    pub token: String,
    // ── 功能开关 + 运行状态（v2.1）──
    #[serde(rename = "whitelistEnabled")]
    pub whitelist_enabled: bool,
    #[serde(rename = "readonlyMode")]
    pub readonly_mode: bool,
    #[serde(rename = "backupEnabled")]
    pub backup_enabled: bool,
    #[serde(rename = "auditEnabled")]
    pub audit_enabled: bool,
    #[serde(rename = "rateLimitEnabled")]
    pub rate_limit_enabled: bool,
    #[serde(rename = "encodingDetectEnabled")]
    pub encoding_detect_enabled: bool,
    #[serde(rename = "shellEnabled")]
    pub shell_enabled: bool,
    pub running: bool,
    // ── 本机地址变更检测 ──
    #[serde(rename = "lanIps")]
    pub lan_ips: Vec<String>,
    #[serde(rename = "lastSelectedIp")]
    pub last_selected_ip: Option<String>,
    #[serde(rename = "ipChanged")]
    pub ip_changed: bool,
}

#[derive(Debug, Serialize)]
pub struct RateLimitInfo {
    #[serde(rename = "maxRequests")]
    pub max_requests: u32,
    #[serde(rename = "windowMs")]
    pub window_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct StatsInfo {
    #[serde(rename = "totalRequests")]
    pub total_requests: u64,
    #[serde(rename = "totalErrors")]
    pub total_errors: u64,
}

#[tauri::command]
pub async fn get_status(state: State<'_, Arc<AppState>>) -> Result<StatusResponse, String> {
    let config = state.config.read().await;
    let stats = state.stats.read().await;
    let uptime = state.uptime_seconds().await;
    let connect_cmd = network::build_connect_command(&config.host, config.port, &config.token);
    let running = state.mcp_running.load(std::sync::atomic::Ordering::Relaxed);
    let lan_ips = network::get_lan_ips();
    let ip_changed = config
        .last_selected_ip
        .as_ref()
        .is_some_and(|ip| !lan_ips.contains(ip));

    Ok(StatusResponse {
        version: env!("CARGO_PKG_VERSION").into(),
        uptime_seconds: uptime,
        allowed_roots: config.allowed_roots.clone(),
        allowed_extensions: config.allowed_extensions.clone(),
        max_file_size_bytes: config.max_file_size_bytes,
        rate_limit: RateLimitInfo {
            max_requests: config.rate_limit_max_requests,
            window_ms: config.rate_limit_window_ms,
        },
        backup_dir: config.backup_dir.clone(),
        backup_retention: config.backup_retention,
        audit_retention_days: config.audit_retention_days,
        host: config.host.clone(),
        port: config.port,
        stats: StatsInfo {
            total_requests: stats.total_requests,
            total_errors: stats.total_errors,
        },
        connect_command: connect_cmd,
        token: config.token.clone(),
        whitelist_enabled: config.whitelist_enabled,
        readonly_mode: config.readonly_mode,
        backup_enabled: config.backup_enabled,
        audit_enabled: config.audit_enabled,
        rate_limit_enabled: config.rate_limit_enabled,
        encoding_detect_enabled: config.encoding_detect_enabled,
        shell_enabled: config.shell_enabled,
        running,
        last_selected_ip: config.last_selected_ip.clone(),
        ip_changed,
        lan_ips,
    })
}

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
                config.$field = v.clone();
                save_config_field(&db, $key, &serde_json::to_value(&v).unwrap())?;
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

    if let Some(ref h) = patch.host {
        if *h != config.host {
            config.host = h.clone();
            save_config_field(&db, "host", &serde_json::to_value(h).unwrap())?;
            changed.push("host".into());
            restart_required = true;
        }
    }
    if let Some(p) = patch.port {
        if p != config.port {
            config.port = p;
            save_config_field(&db, "port", &serde_json::to_value(p).unwrap())?;
            changed.push("port".into());
            restart_required = true;
        }
    }

    Ok(ConfigSaveResult {
        ok: true,
        changed,
        warnings: vec![],
        restart_required,
    })
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

#[tauri::command]
pub async fn get_audit_log(
    state: State<'_, Arc<AppState>>,
    limit: Option<u32>,
) -> Result<Vec<audit::AuditEntry>, String> {
    let limit = limit.unwrap_or(50) as usize;
    audit::read_recent_entries(&state.data_dir, limit)
}

#[tauri::command]
pub async fn clear_audit_log(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    audit::clear_all(&state.data_dir)
}

#[tauri::command]
pub async fn browse_directory(path: Option<String>) -> Result<browse::BrowseResult, String> {
    browse::browse_directory(path.as_deref()).await
}

#[tauri::command]
pub async fn restart_mcp_server(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut handle = state.mcp_server_handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }

    let state_clone = state.inner().clone();
    let new_handle = tauri::async_runtime::spawn(async move {
        crate::mcp::http::spawn_mcp_server(state_clone).await;
    });
    *handle = Some(new_handle);

    Ok(())
}

/// 停止 MCP 服务：abort 监听任务并释放端口。UI 显示「已停止」。
#[tauri::command]
pub async fn stop_mcp_server(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    let mut handle = state.mcp_server_handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
    }
    // 立即置停止态，不必等 serve 协程感知 abort（其也会置 false，幂等）。
    state
        .mcp_running
        .store(false, std::sync::atomic::Ordering::Relaxed);
    // 即时通知托盘刷新图标/tooltip
    let _ = app.emit("mcp-status-changed", ());
    Ok(())
}

/// 启动（或重启）MCP 服务。若已在运行先 abort 旧任务，避免端口占用。
#[tauri::command]
pub async fn start_mcp_server(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    let mut handle = state.mcp_server_handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }

    let state_clone = state.inner().clone();
    let new_handle = tauri::async_runtime::spawn(async move {
        crate::mcp::http::spawn_mcp_server(state_clone).await;
    });
    *handle = Some(new_handle);

    // 乐观置运行态并即时通知托盘（serve 失败会在 http.rs 回退 false）
    state
        .mcp_running
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit("mcp-status-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn get_lan_ips() -> Result<Vec<String>, String> {
    Ok(network::get_lan_ips())
}

/// 用户在 Connect 页选中（或自动默认选中，或点击变更提示 banner 的"标记已处理"）时落盘，
/// 作为下次判断"地址是否变化"的基线。
#[tauri::command]
pub async fn set_selected_ip(state: State<'_, Arc<AppState>>, ip: String) -> Result<(), String> {
    let db = state.db.lock().await;
    save_config_field(&db, "last_selected_ip", &serde_json::to_value(&ip).unwrap())?;
    let mut config = state.config.write().await;
    config.last_selected_ip = Some(ip);
    Ok(())
}

#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[derive(Debug, Serialize)]
pub struct RunningCommandInfo {
    pub handle: String,
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    pub running: bool,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    #[serde(rename = "elapsedSeconds")]
    pub elapsed_seconds: u64,
}

/// 供本机面板展示 run_command(background=true) 启动的后台命令，与远程 MCP 的
/// get_command_output 读的是同一份 `AppState.running_commands` 注册表。
#[tauri::command]
pub async fn list_running_commands(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<RunningCommandInfo>, String> {
    // 先克隆出快照再逐个 await 锁，避免持有 DashMap 的 Ref 跨 await。
    let snapshot: Vec<_> = state
        .running_commands
        .iter()
        .map(|entry| {
            let cmd = entry.value();
            (
                entry.key().clone(),
                cmd.pid,
                cmd.command.clone(),
                cmd.cwd.clone(),
                cmd.exit_code.clone(),
                cmd.started_at.elapsed().as_secs(),
            )
        })
        .collect();

    let mut result = Vec::with_capacity(snapshot.len());
    for (handle, pid, command, cwd, exit_code_arc, elapsed_seconds) in snapshot {
        let exit_code = *exit_code_arc.lock().await;
        result.push(RunningCommandInfo {
            handle,
            pid,
            command,
            cwd,
            running: exit_code.is_none(),
            exit_code,
            elapsed_seconds,
        });
    }
    Ok(result)
}

/// 本机面板的「终止」按钮：移除注册表条目后 drop 其中的 Job Object（kill-on-job-close）
/// 整树终止，不再需要 taskkill，逻辑与 MCP 的 stop_command 工具一致。
#[tauri::command]
pub async fn stop_running_command(
    state: State<'_, Arc<AppState>>,
    handle: String,
) -> Result<(), String> {
    let entry = state
        .running_commands
        .remove(&handle)
        .ok_or_else(|| format!("未知的 handle: {handle}"))?;
    drop(entry);
    Ok(())
}

// ===== 自动更新（后台线程，不阻塞 UI），採自 PastePanda 实现 =====

/// 指数退避重试辅助函数
async fn retry_with_backoff<F, Fut, T, E>(
    max_retries: u32,
    operation_name: &str,
    f: F,
) -> Result<T, E>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(val) => return Ok(val),
            Err(e) => {
                attempt += 1;
                if attempt > max_retries {
                    return Err(e);
                }
                let delay_secs = 1u64 << (attempt - 1);
                log::warn!(
                    "[Update] {} 失败（第 {}/{} 次），{} 秒后重试: {}",
                    operation_name,
                    attempt,
                    max_retries,
                    delay_secs,
                    e
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
            }
        }
    }
}

/// 后台执行更新检查+下载安装，通过 Tauri event 推送状态到前端。
/// 内置指数退避重试：检查更新最多重试 3 次，下载安装最多重试 2 次。
#[tauri::command]
pub fn start_update(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    tauri::async_runtime::spawn(async move {
        let _ = app.emit("update:checking", ());

        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                let _ = app.emit(
                    "update:error",
                    serde_json::json!({
                        "message": format!("更新插件初始化失败: {}", e)
                    }),
                );
                return;
            }
        };

        let check_result = match retry_with_backoff(3, "检查更新", || updater.check()).await {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit(
                    "update:error",
                    serde_json::json!({
                        "message": format!("检查更新失败（已重试 3 次）: {}", e)
                    }),
                );
                return;
            }
        };

        let update = match check_result {
            Some(u) => u,
            None => {
                let _ = app.emit("update:uptodate", ());
                return;
            }
        };

        let _ = app.emit(
            "update:available",
            serde_json::json!({
                "version": update.version,
                "body": update.body,
            }),
        );

        let _ = app.emit("update:downloading", ());

        let app_progress = app.clone();
        let app_ready = app.clone();
        let result = retry_with_backoff(2, "下载安装", || {
            let u = update.clone();
            let ap = app_progress.clone();
            let ar = app_ready.clone();
            async move {
                u.download_and_install(
                    move |downloaded, total| {
                        let _ = ap.emit(
                            "update:progress",
                            serde_json::json!({
                                "downloaded": downloaded,
                                "total": total,
                            }),
                        );
                    },
                    move || {
                        let _ = ar.emit("update:ready", ());
                    },
                )
                .await
            }
        })
        .await;

        if let Err(e) = result {
            let _ = app.emit(
                "update:error",
                serde_json::json!({
                    "message": format!("下载安装失败（已重试 2 次）: {}", e)
                }),
            );
        }
    });
}
