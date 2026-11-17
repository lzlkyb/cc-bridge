use super::stable_connect_cmds::changed;
use crate::config::BridgeConfig;
use crate::ssh_tunnel::{RuleState, TunnelState};
use crate::stable_connect::{self as stable, StableOperation, StableSaved};
use crate::state::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

fn check(op: &StableOperation) -> Result<(), String> {
    if op.cancel.load(Ordering::SeqCst) {
        Err("操作已取消".into())
    } else {
        Ok(())
    }
}
fn progress(app: &AppHandle, op: &StableOperation, step: u8) -> Result<(), String> {
    check(op)?;
    let mut r = op.record.lock().unwrap_or_else(|p| p.into_inner());
    r.step = step;
    changed(app, Some(&r.connection_id));
    Ok(())
}

pub(super) async fn configure(
    app: &AppHandle,
    state: &Arc<AppState>,
    config: &BridgeConfig,
    op: &StableOperation,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<(), String> {
    let mut takeover = super::forward_takeover::Takeover::default();
    let result =
        configure_with_takeover(app, state, config, op, password, passphrase, &mut takeover).await;
    if let Err(error) = result {
        return match takeover.restore(app, state).await {
            Ok(()) => Err(error),
            Err(restore) => Err(format!("{error}。恢复原有转发失败：{restore}")),
        };
    }
    Ok(())
}

async fn configure_with_takeover(
    app: &AppHandle,
    state: &Arc<AppState>,
    config: &BridgeConfig,
    op: &StableOperation,
    password: Option<String>,
    passphrase: Option<String>,
    takeover: &mut super::forward_takeover::Takeover,
) -> Result<(), String> {
    let request = op.record.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let id = &request.connection_id;
    let link = super::ssh_cmds::SshLink::from_config(config, id)?;
    let runtime_id = stable::runtime_id(id);
    let saved = config
        .stable_connect
        .connections
        .iter()
        .find(|s| &s.connection_id == id);
    let mut port = request.port;
    progress(app, op, 1)?;
    let ports = stable::candidate_ports(saved.map(|s| s.port), config.port);
    for (index, candidate) in ports.iter().enumerate() {
        check(op)?;
        port = *candidate;
        op.record.lock().unwrap_or_else(|p| p.into_inner()).port = port;
        super::ssh_tunnel_cmds::start_owned_tunnel(
            app.clone(),
            state.clone(),
            link.clone(),
            vec![stable::rule(port, config)],
            (password.clone(), passphrase.clone()),
            takeover,
            true,
        )
        .await?;
        progress(app, op, 2)?;
        // Restoring an unchanged saved endpoint belongs to the long-lived supervisor, not the
        // bounded configuration deadline. A temporary VPN/bind failure must keep retrying it.
        if let Some(saved) = saved.filter(|_| op.access.is_none()) {
            return resume_saved(state, config, op, saved).await;
        }
        match wait_for_tunnel(state, &runtime_id, op).await {
            Ok(()) => break,
            Err((message, port_failed)) => {
                if !port_failed || index + 1 == ports.len() {
                    return Err(if port_failed && saved.is_some() {
                        format!("固定端口 {port} 无法监听。为保持原 MCP 地址，请释放该端口或检查服务器转发权限后重试。")
                    } else {
                        message
                    });
                }
                takeover
                    .restore(app, state)
                    .await
                    .map_err(|error| format!("恢复原有转发失败：{error}"))?;
            }
        }
    }
    {
        let mut r = op.record.lock().unwrap_or_else(|p| p.into_inner());
        r.port = port;
    }
    progress(app, op, 3)?;
    let script = stable::remote_script(
        config,
        port,
        &request.scope,
        &request.project_path,
        request.multi_device,
        op.access.as_ref(),
        (op.access.is_none(), request.target.as_ref()),
    );
    let output = super::ssh_cmds::run_stable_setup(
        state,
        &link,
        script,
        password,
        passphrase,
        op.cancel.clone(),
    )
    .await?;
    let marker = if op.access.is_some() {
        "CCB_CONFIGURED"
    } else {
        "CCB_VERIFIED"
    };
    if let Some(error) = stable::setup_error(&output, marker) {
        return Err(error);
    }
    let target = Some(crate::stable_discovery::parse_result::<
        crate::stable_discovery::StableTarget,
    >(&output, marker)?);
    progress(app, op, 4)?;
    // A stopped/reconfigured local service must not produce a persisted success for stale credentials.
    let db = state.db.lock().await;
    let mut current = state.config.write().await;
    check(op)?;
    if !current.ssh_enabled
        || !state.mcp_running.load(Ordering::SeqCst)
        || stable::fingerprint(&current, id) != stable::fingerprint(config, id)
    {
        return Err("本机服务或 SSH 配置在接入期间发生变化，请重新接入。".into());
    }
    let saved = StableSaved {
        connection_id: id.clone(),
        port,
        scope: request.scope,
        project_path: request.project_path,
        multi_device: request.multi_device,
        enabled: true,
        fingerprint: stable::fingerprint(config, id),
        token_fingerprint: crate::connection_access::token_fingerprint(config),
        target: target.clone(),
        verified_at: Some(crate::connection_access::now_ms()),
    };
    let mut next = current.stable_connect.clone();
    if let Some(slot) = next.connections.iter_mut().find(|s| &s.connection_id == id) {
        *slot = saved;
    } else {
        next.connections.push(saved);
    }
    next.method = Some("stable".into());
    next.selected_connection_id = Some(id.clone());
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::config::save_config_field(
        &tx,
        "stable_connect",
        &serde_json::to_value(&next).map_err(|e| e.to_string())?,
    )?;
    crate::config::save_config_field(&tx, "has_onboarded", &serde_json::json!(true))?;
    tx.commit().map_err(|e| e.to_string())?;
    current.stable_connect = next;
    current.has_onboarded = true;
    let mut r = op.record.lock().unwrap_or_else(|p| p.into_inner());
    r.phase = "ready".into();
    r.configured = true;
    r.enabled = true;
    r.config_matches = true;
    r.message = None;
    r.target = target;
    r.verified_at = current
        .stable_connect
        .connections
        .iter()
        .find(|s| &s.connection_id == id)
        .and_then(|s| s.verified_at);
    Ok(())
}

pub(super) async fn resume_saved(
    state: &Arc<AppState>,
    config: &BridgeConfig,
    op: &StableOperation,
    saved: &StableSaved,
) -> Result<(), String> {
    let db = state.db.lock().await;
    let mut current = state.config.write().await;
    check(op)?;
    if !current.ssh_enabled
        || !state.mcp_running.load(Ordering::SeqCst)
        || saved.fingerprint != stable::fingerprint(&current, &saved.connection_id)
        || stable::fingerprint(&current, &saved.connection_id)
            != stable::fingerprint(config, &saved.connection_id)
    {
        return Err("本机服务或 SSH 配置在恢复期间发生变化，请重新接入。".into());
    }
    let mut next = current.stable_connect.clone();
    let entry = next
        .connections
        .iter_mut()
        .find(|s| s.connection_id == saved.connection_id)
        .ok_or("原接入配置已变化，请重新检查。")?;
    if entry.port != saved.port
        || entry.scope != saved.scope
        || entry.project_path != saved.project_path
        || entry.multi_device != saved.multi_device
        || entry.fingerprint != saved.fingerprint
        || entry.target.as_ref().map(|t| &t.id) != saved.target.as_ref().map(|t| &t.id)
    {
        return Err("原接入配置已变化，请重新检查。".into());
    }
    // Persist the user's resume intent only; do not rewrite or re-verify MCP during network recovery.
    entry.enabled = true;
    next.method = Some("stable".into());
    next.selected_connection_id = Some(saved.connection_id.clone());
    crate::config::save_config_field(
        &db,
        "stable_connect",
        &serde_json::to_value(&next).map_err(|e| e.to_string())?,
    )?;
    current.stable_connect = next;
    let mut record = op.record.lock().unwrap_or_else(|p| p.into_inner());
    record.phase = "reconnecting".into();
    record.configured = true;
    record.enabled = true;
    record.config_matches = true;
    record.message = None;
    record.target = saved.target.clone();
    record.verified_at = saved.verified_at;
    Ok(())
}

async fn wait_for_tunnel(
    state: &Arc<AppState>,
    id: &str,
    op: &StableOperation,
) -> Result<(), (String, bool)> {
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        check(op).map_err(|e| (e, false))?;
        let status = state
            .ssh_tunnels
            .get(id)
            .map(|t| t.status.lock().unwrap_or_else(|p| p.into_inner()).clone());
        let Some(status) = status else {
            return Err(("连接已停止".into(), false));
        };
        if status.needs_secret {
            op.record
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .needs_secret = true;
        }
        if status.rules.iter().any(|r| r.state == RuleState::Failed) {
            return Err(("服务器无法监听转发端口".into(), true));
        }
        if status.state == TunnelState::Up
            && status.rules.iter().all(|r| r.state == RuleState::Listening)
        {
            return Ok(());
        }
        if matches!(
            status.state,
            TunnelState::Error | TunnelState::Stopped | TunnelState::Reconnecting
        ) {
            return Err((
                status
                    .message
                    .unwrap_or_else(|| "无法连接服务器，请检查网络和登录信息。".into()),
                false,
            ));
        }
        if Instant::now() >= deadline {
            return Err((
                "连接服务器超时，请检查网络、SSH 登录和端口转发权限。".into(),
                false,
            ));
        }
        // Bounded setup only: one in-memory snapshot per 100ms, exits on cancel/failure/25s deadline.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
