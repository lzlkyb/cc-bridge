use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

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
    pub running: bool,
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

    Ok(StatusResponse {
        version: "2.1.0".into(),
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
        running,
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
pub async fn stop_mcp_server(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut handle = state.mcp_server_handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
    }
    // 立即置停止态，不必等 serve 协程感知 abort（其也会置 false，幂等）。
    state
        .mcp_running
        .store(false, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// 启动（或重启）MCP 服务。若已在运行先 abort 旧任务，避免端口占用。
#[tauri::command]
pub async fn start_mcp_server(state: State<'_, Arc<AppState>>) -> Result<(), String> {
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

#[tauri::command]
pub async fn get_lan_ips() -> Result<Vec<String>, String> {
    Ok(network::get_lan_ips())
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
