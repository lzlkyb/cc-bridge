use super::stable_connect_cmds::changed;
use crate::config::BridgeConfig;
use crate::ssh_tunnel::{RuleState, TunnelState};
use crate::stable_connect::{self as stable, StableOperation, StableSaved};
use crate::stable_discovery::{self, ConfiguredTarget, ReplacedTarget};
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
    credentials: (Option<String>, Option<String>),
    activate: bool,
) -> Result<Option<ReplacedTarget>, String> {
    let mut takeover = super::forward_takeover::Takeover::default();
    let result =
        configure_with_takeover(app, state, config, op, credentials, &mut takeover, activate).await;
    match result {
        Ok(replaced) => Ok(replaced),
        Err(error) => match takeover.restore(app, state).await {
            Ok(()) => Err(error),
            Err(restore) => Err(format!("{error}。恢复原有转发失败：{restore}")),
        },
    }
}

async fn configure_with_takeover(
    app: &AppHandle,
    state: &Arc<AppState>,
    config: &BridgeConfig,
    op: &StableOperation,
    (password, passphrase): (Option<String>, Option<String>),
    takeover: &mut super::forward_takeover::Takeover,
    activate: bool,
) -> Result<Option<ReplacedTarget>, String> {
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
    // 多设备只能使用服务器分配的端口。试旧候选可能占到同账号离线设备的端口，
    // 而且这些号码不会写进该设备的账本。
    let mut ports = if op.access.is_some() {
        let allocated = op.access.as_ref().and_then(|access| access.tunnel_port);
        if request.multi_device {
            allocated.filter(|port| *port >= 1024).into_iter().collect()
        } else {
            stable::candidate_ports(None, allocated, config.port)
        }
    } else {
        stable::candidate_ports(saved.map(|s| s.port), None, config.port)
    };
    // 一轮本地候选 + 至多一次服务器重分配：账本端口被占时，老候选（7823 / 17823 …）
    // 在同一台共享服务器上几乎必然也被占，光靠本地退避撞不满就永远好不了。
    // 旧记录里的 port 若被写坏成 0 或特权端口，不能拿去建隧道——`-R 0` 会让 sshd
    // 自己挑一个号，那号没人记账、下次必然对不上。
    ports.retain(|port| *port >= 1024);
    if ports.is_empty() && !request.multi_device {
        ports = stable::candidate_ports(None, None, config.port);
    }
    let mut reallocated = false;
    let mut last_failure = String::new();
    loop {
        let mut listening = false;
        for candidate in &ports {
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
                return resume_saved(state, config, op, saved).await.map(|()| None);
            }
            match wait_for_tunnel(state, &runtime_id, op).await {
                Ok(()) => {
                    listening = true;
                    break;
                }
                Err((message, port_failed)) => {
                    last_failure = message;
                    // 不是端口问题（登录 / 网络 / 隧道被停）时换号毫无意义，直接给原因。
                    if !port_failed {
                        return Err(last_failure);
                    }
                    takeover
                        .restore(app, state)
                        .await
                        .map_err(|error| format!("恢复原有转发失败：{error}"))?;
                }
            }
        }
        if listening {
            break;
        }
        if op.access.is_some() && !reallocated {
            if let Some(fresh) =
                reallocate_port(state, &link, op, password.clone(), passphrase.clone()).await
            {
                if !ports.contains(&fresh) {
                    // 已经证明不可用的号不再重试，直接换到服务器刚分配的那个。
                    reallocated = true;
                    ports = vec![fresh];
                    continue;
                }
            }
        }
        // 自愈脚本也可能刚好在用户点「取消」时失败：真正的原因是取消，不能拿端口冲突盖掉它。
        check(op)?;
        // 文案必须与事实一致：换号没成（python3 缺失、服务器不受理）时不能说「已自动换端口」，
        // 否则下一次用户还是不知道该怎么办。
        return Err(if last_failure.is_empty() {
            "服务器无法监听隧道端口。共享服务器上每个账号需要各自的端口，请稍后重试或联系服务器管理员。".into()
        } else if reallocated {
            format!("{last_failure}；已自动换端口重试仍未成功，请稍后重试或联系服务器管理员。")
        } else {
            format!("{last_failure}。共享服务器上每个账号需要各自的端口，请稍后重试或联系服务器管理员。")
        });
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
    let ConfiguredTarget { target, replaced } = stable_discovery::parse_result(&output, marker)?;
    let target = Some(target);
    progress(app, op, 4)?;
    // A stopped/reconfigured local service must not produce a persisted success for stale credentials.
    let db = state.db.lock().await;
    let mut current = state.config.write().await;
    check(op)?;
    if !current.ssh_enabled
        || !state.mcp_running.load(Ordering::SeqCst)
        || stable::fingerprint(&current, id) != stable::fingerprint(config, id)
        || (!activate
            && !saved.is_some_and(|inspected| {
                current
                    .stable_connect
                    .connections
                    .iter()
                    .any(|entry| entry.enabled && stable::same_saved_endpoint(entry, inspected))
            }))
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
    select_configured(&mut next, id, activate);
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
    Ok(replaced)
}

fn select_configured(settings: &mut stable::StableSettings, id: &str, activate: bool) {
    // A background port repair must not change the user's selected server or access method.
    if activate {
        settings.method = Some("stable".into());
        settings.selected_connection_id = Some(id.into());
    }
}

#[cfg(test)]
#[test]
fn background_repair_preserves_the_selected_access() {
    let mut settings = stable::StableSettings {
        method: Some("direct".into()),
        selected_connection_id: Some("current".into()),
        ..Default::default()
    };
    select_configured(&mut settings, "repaired", false);
    assert_eq!(settings.method.as_deref(), Some("direct"));
    assert_eq!(settings.selected_connection_id.as_deref(), Some("current"));
    select_configured(&mut settings, "repaired", true);
    assert_eq!(settings.method.as_deref(), Some("stable"));
    assert_eq!(settings.selected_connection_id.as_deref(), Some("repaired"));
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
    if !stable::same_saved_endpoint(entry, saved) {
        return Err("原接入配置已变化，请重新检查。".into());
    }
    // Persist the user's resume intent only; do not rewrite or re-verify MCP during network recovery.
    entry.enabled = true;
    select_configured(&mut next, &saved.connection_id, true);
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

/// 让服务器跳过账本重新分配一个隧道端口。
///
/// 任何失败都返回 `None`：自愈是尽力而为，绝不能用自己的错误盖掉真正的原因
/// （端口被占 / 登录失败）。上层拿到 `None` 会照原样报端口错误。
async fn reallocate_port(
    state: &Arc<AppState>,
    link: &super::ssh_cmds::SshLink,
    op: &StableOperation,
    password: Option<String>,
    passphrase: Option<String>,
) -> Option<u16> {
    let multi = op
        .record
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .multi_device;
    let device_id = state.config.read().await.device_id.clone();
    let output = super::ssh_cmds::run_stable_setup(
        state,
        link,
        stable::reallocate_script(multi, &device_id),
        password,
        passphrase,
        op.cancel.clone(),
    )
    .await
    .ok()?;
    if stable::setup_error(&output, "CCB_PORT").is_some() {
        return None;
    }
    crate::stable_discovery::parse_result::<stable::ReallocatedPort>(&output, "CCB_PORT")
        .ok()
        .map(|fresh| fresh.port)
        .filter(|port| *port >= 1024)
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
        if crate::ssh_tunnel::port_taken(&status) {
            return Err(("服务器无法监听转发端口".into(), true));
        }
        if let Some(failed) = status.rules.iter().find(|r| r.state == RuleState::Failed) {
            return Err((
                failed
                    .message
                    .clone()
                    .unwrap_or_else(|| "转发规则启动失败".into()),
                false,
            ));
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
