//! Local-only one-click configuration; no MCP registration or credential persistence.
use super::stable_connect_run;
use crate::config::BridgeConfig;
use crate::ssh_tunnel::{RuleState, TunnelState};
use crate::stable_connect::{self as stable, StableOperation, StableRecord, StableSaved};
use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StableSnapshot {
    method: String,
    selected_connection_id: Option<String>,
    connections: Vec<StableRecord>,
}

pub(super) fn changed(app: &AppHandle, id: Option<&str>) {
    let _ = app.emit(
        "stable_connect_changed",
        serde_json::json!({"connectionId":id}),
    );
}

fn saved_record(saved: &StableSaved, config: &BridgeConfig, state: &AppState) -> StableRecord {
    let mut record = StableRecord {
        connection_id: saved.connection_id.clone(),
        port: saved.port,
        scope: saved.scope.clone(),
        project_path: saved.project_path.clone(),
        multi_device: saved.multi_device,
        configured: true,
        enabled: saved.enabled,
        phase: "stopped".into(),
        step: 4,
        message: None,
        needs_secret: false,
        config_matches: saved.fingerprint == stable::fingerprint(config, &saved.connection_id),
        target: saved.target.clone(),
        verified_at: saved.verified_at,
    };
    if let Some(t) = state
        .ssh_tunnels
        .get(&stable::runtime_id(&saved.connection_id))
    {
        let t = t.status.lock().unwrap_or_else(|p| p.into_inner());
        record.needs_secret = t.needs_secret;
        record.message = t.message.clone();
        record.phase = match t.state {
            TunnelState::Connecting => "reconnecting",
            TunnelState::Reconnecting => "reconnecting",
            TunnelState::Error => "error",
            TunnelState::Stopped => "stopped",
            TunnelState::Up => {
                if t.rules.iter().any(|r| r.state == RuleState::Failed) {
                    record.message = Some(format!(
                        "固定端口 {} 暂时无法监听，正在按原 MCP 地址自动重试。若持续失败，请检查端口占用或服务器转发权限。",
                        saved.port
                    ));
                    "reconnecting"
                } else if t.rules.iter().all(|r| r.state == RuleState::Listening) {
                    "ready"
                } else {
                    "reconnecting"
                }
            }
        }
        .into();
    }
    record
}

pub fn stable_records(config: &BridgeConfig, state: &AppState) -> Vec<StableRecord> {
    let mut connections: Vec<_> = config
        .stable_connect
        .connections
        .iter()
        .map(|s| saved_record(s, config, state))
        .collect();
    for op in state.stable_operations.iter() {
        let record = op.record.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let active = op.active.load(Ordering::SeqCst);
        // An ended connection attempt cannot mask the live recovery of the unchanged saved endpoint.
        // Configuration/write errors (step 3+) and active progress still own their result.
        let obsolete_connection_error = !active
            && record.phase == "error"
            && record.step == 2
            && op.access.is_none()
            && state
                .ssh_tunnels
                .contains_key(&stable::runtime_id(&record.connection_id))
            && connections.iter().any(|saved| {
                saved.connection_id == record.connection_id
                    && saved.configured
                    && saved.enabled
                    && saved.config_matches
                    && saved.port == record.port
                    && saved.scope == record.scope
                    && saved.project_path == record.project_path
                    && saved.multi_device == record.multi_device
                    && saved.target.as_ref().map(|t| &t.id) == record.target.as_ref().map(|t| &t.id)
            });
        if !obsolete_connection_error && (active || record.phase == "error" || !record.configured) {
            if let Some(slot) = connections
                .iter_mut()
                .find(|r| r.connection_id == record.connection_id)
            {
                *slot = record;
            } else {
                connections.push(record);
            }
        }
    }
    connections
}

pub(super) async fn snapshot(state: &Arc<AppState>) -> StableSnapshot {
    let config = state.config.read().await;
    StableSnapshot {
        method: stable::method(&config),
        selected_connection_id: config.stable_connect.selected_connection_id.clone(),
        connections: stable_records(&config, state),
    }
}

#[tauri::command]
pub async fn stable_connect_get(state: State<'_, Arc<AppState>>) -> Result<StableSnapshot, String> {
    Ok(snapshot(state.inner()).await)
}

#[tauri::command]
pub async fn stable_connect_select(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    method: String,
    connection_id: Option<String>,
) -> Result<StableSnapshot, String> {
    if !["stable", "direct"].contains(&method.as_str()) {
        return Err("未知连接方式".into());
    }
    {
        let db = state.db.lock().await;
        let mut config = state.config.write().await;
        if connection_id
            .as_ref()
            .is_some_and(|id| !config.ssh_connections.iter().any(|c| &c.id == id))
        {
            return Err("服务器不存在，请重新选择".into());
        }
        let mut next = config.stable_connect.clone();
        next.method = Some(method);
        next.selected_connection_id = connection_id;
        crate::config::save_config_field(
            &db,
            "stable_connect",
            &serde_json::to_value(&next).map_err(|e| e.to_string())?,
        )?;
        config.stable_connect = next;
    }
    changed(&app, None);
    Ok(snapshot(state.inner()).await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat IPC fields match the shared connection-card form.
pub async fn stable_connect_start(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
    scope: String,
    project_path: String,
    multi_device: bool,
    password: Option<String>,
    passphrase: Option<String>,
    access: Option<crate::stable_discovery::StableAccessRequest>,
) -> Result<StableSnapshot, String> {
    stable::validate_setup(&scope, &project_path, multi_device)?;
    let start_guard = state.ssh_tunnel_start_lock.lock().await;
    let config = state.config.read().await.clone();
    if !config.ssh_enabled {
        return Err("请先启用 SSH 连接功能".into());
    }
    if !state.mcp_running.load(Ordering::SeqCst) {
        return Err("请先启动本机 MCP 服务".into());
    }
    if config.remote_tls_enabled {
        return Err("当前已启用 HTTPS。自动接入暂不支持配置服务器证书信任，请使用 IP 直连的现有 HTTPS 接入步骤。".into());
    }
    if config.transport != "http" {
        return Err(
            "隧道连接目前支持 HTTP 接入。请先将传输协议切换为 HTTP，或继续使用原有 SSE 接入方式。"
                .into(),
        );
    }
    if !config.ssh_connections.iter().any(|c| c.id == connection_id) {
        return Err("服务器不存在，请重新选择".into());
    }
    let saved = config
        .stable_connect
        .connections
        .iter()
        .find(|s| s.connection_id == connection_id);
    if let Some(access) = &access {
        crate::stable_discovery::validate_access(
            &config,
            &connection_id,
            &scope,
            &project_path,
            access,
        )?;
    } else if saved.is_none_or(|saved| {
        saved.fingerprint != stable::fingerprint(&config, &connection_id)
            || saved.scope != scope
            || saved.project_path != project_path.trim()
            || saved.multi_device != multi_device
    }) {
        return Err("请先检查服务器上的原有接入，再继续配置。".into());
    }
    let link = super::ssh_cmds::SshLink::from_config(&config, &connection_id)?;
    super::forward_takeover::plan_owned(
        state.inner(),
        &config,
        &link,
        &[stable::rule(saved.map_or(config.port, |s| s.port), &config)],
    )?;
    let op = Arc::new(StableOperation {
        cancel: Arc::new(AtomicBool::new(false)),
        active: AtomicBool::new(true),
        record: Mutex::new(StableRecord {
            connection_id: connection_id.clone(),
            port: saved.map_or(config.port, |s| s.port),
            scope: scope.clone(),
            project_path: project_path.trim().into(),
            multi_device,
            configured: saved.is_some(),
            enabled: saved.is_some_and(|s| s.enabled),
            phase: "running".into(),
            step: 0,
            message: None,
            needs_secret: false,
            config_matches: false,
            target: if let Some(access) = &access {
                access.target.clone()
            } else {
                saved.and_then(|s| s.target.clone())
            },
            verified_at: saved.and_then(|s| s.verified_at),
        }),
        access,
    });
    // One in-flight writer per server, including the interval while cancellation is being acknowledged.
    match state.stable_operations.entry(connection_id.clone()) {
        dashmap::mapref::entry::Entry::Occupied(mut e) => {
            if e.get().active.load(Ordering::SeqCst) {
                return Err("正在处理这台服务器，请等待当前操作结束".into());
            }
            e.insert(op.clone());
        }
        dashmap::mapref::entry::Entry::Vacant(e) => {
            e.insert(op.clone());
        }
    }
    drop(start_guard);
    changed(&app, Some(&connection_id));
    let outcome =
        stable_connect_run::configure(&app, state.inner(), &config, &op, password, passphrase)
            .await;
    if let Err(error) = outcome {
        let mut record = op.record.lock().unwrap_or_else(|p| p.into_inner());
        if op.cancel.load(Ordering::SeqCst) {
            record.phase = "stopped".into();
            let detail = stable::friendly_error(&error, &config.token);
            record.message = Some(if record.step >= 3 {
                format!("{detail}。请重新检查服务器上的接入配置。")
            } else {
                detail
            });
        } else {
            record.phase = "error".into();
            record.needs_secret |= error.contains("Permission denied")
                || error.contains("需要密码")
                || error.contains("CCB_AUTH_REQUIRED");
            record.message = Some(stable::friendly_error(&error, &config.token));
        }
    }
    op.active.store(false, Ordering::SeqCst);
    changed(&app, Some(&connection_id));
    Ok(snapshot(state.inner()).await)
}

#[tauri::command]
pub fn stable_connect_cancel(state: State<'_, Arc<AppState>>, connection_id: String) {
    if let Some(op) = state.stable_operations.get(&connection_id) {
        op.cancel.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn stable_connect_stop(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
) -> Result<StableSnapshot, String> {
    let _start_guard = state.ssh_tunnel_start_lock.lock().await;
    if state
        .stable_operations
        .get(&connection_id)
        .is_some_and(|op| op.active.load(Ordering::SeqCst))
    {
        return Err("正在配置接入，请先取消本次操作。".into());
    }
    super::ssh_tunnel_cmds::stop_and_wait(state.inner(), &stable::runtime_id(&connection_id)).await;
    {
        let db = state.db.lock().await;
        let mut config = state.config.write().await;
        let mut next = config.stable_connect.clone();
        if let Some(saved) = next
            .connections
            .iter_mut()
            .find(|s| s.connection_id == connection_id)
        {
            saved.enabled = false;
        }
        crate::config::save_config_field(
            &db,
            "stable_connect",
            &serde_json::to_value(&next).map_err(|e| e.to_string())?,
        )?;
        config.stable_connect = next;
    }
    if let Some(op) = state.stable_operations.get(&connection_id) {
        let mut r = op.record.lock().unwrap_or_else(|p| p.into_inner());
        r.phase = "stopped".into();
        r.enabled = false;
        r.message = None;
    }
    changed(&app, Some(&connection_id));
    Ok(snapshot(state.inner()).await)
}

pub async fn autostart_stable_connections(app: AppHandle, state: Arc<AppState>) {
    let config = state.config.read().await.clone();
    if !config.ssh_enabled {
        return;
    }
    for saved in config
        .stable_connect
        .connections
        .iter()
        .filter(|s| s.enabled)
    {
        if saved.fingerprint != stable::fingerprint(&config, &saved.connection_id) {
            continue;
        }
        let Ok(link) = super::ssh_cmds::SshLink::from_config(&config, &saved.connection_id) else {
            continue;
        };
        let mut takeover = super::forward_takeover::Takeover::default();
        if let Err(e) = super::ssh_tunnel_cmds::start_owned_tunnel(
            app.clone(),
            state.clone(),
            link,
            vec![stable::rule(saved.port, &config)],
            (None, None),
            &mut takeover,
            false,
        )
        .await
        {
            if let Err(error) = takeover.restore(&app, &state).await {
                log::warn!(
                    "恢复原有转发失败：{}",
                    stable::friendly_error(&error, &config.token)
                );
            }
            log::warn!(
                "隧道连接自动恢复失败：{}",
                stable::friendly_error(&e, &config.token)
            );
        }
    }
}
