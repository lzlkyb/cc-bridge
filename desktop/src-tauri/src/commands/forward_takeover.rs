//! Transfer only a duplicated Claude listener, preserving the running snapshot of extra rules.
use super::ssh_cmds::SshLink;
use super::ssh_tunnel_cmds::{start_plan, stop_and_wait};
use crate::config::{BridgeConfig, ForwardRule};
use crate::forward_ownership::{self as ownership, ManagedForward};
use crate::ssh_tunnel::{TunnelState, TunnelStatus};
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub(super) struct ForwardAdjustment {
    pub rules: Vec<ForwardRule>,
    pub original: RunningForward,
}

pub(super) struct RunningForward {
    id: String,
    pub rules: Vec<ForwardRule>,
    link: SshLink,
    pub password: Option<String>,
    passphrase: Option<String>,
}

impl RunningForward {
    pub(super) fn capture(state: &AppState, id: &str) -> Result<Option<Self>, String> {
        let Some(tunnel) = state.ssh_tunnels.get(id) else {
            return Ok(None);
        };
        let status = tunnel.status.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(status.state, TunnelState::Error | TunnelState::Stopped) {
            return Ok(None);
        }
        let restart = tunnel
            .restart
            .as_ref()
            .ok_or("缺少恢复原有转发所需的登录信息。")?;
        Ok(Some(Self {
            id: id.into(),
            rules: status
                .rules
                .iter()
                .map(|entry| entry.rule.clone())
                .collect(),
            link: SshLink::new(restart.connection.clone(), restart.jump.clone())?,
            password: restart.password.clone(),
            passphrase: restart.passphrase.clone(),
        }))
    }

    async fn start(
        &self,
        app: &AppHandle,
        state: &Arc<AppState>,
        rules: Vec<ForwardRule>,
    ) -> Result<(), String> {
        start_plan(
            app.clone(),
            state.clone(),
            self.id.clone(),
            self.link.clone(),
            rules,
            self.password.clone(),
            self.passphrase.clone(),
        )
        .await?;
        Ok(())
    }
}

struct ChangedForward {
    id: String,
    original: Option<RunningForward>,
    replacement: Option<Arc<AtomicBool>>,
}

#[derive(Default)]
pub(super) struct Takeover(Vec<ChangedForward>);

impl Takeover {
    pub(super) fn record(
        &mut self,
        state: &AppState,
        id: String,
        original: Option<RunningForward>,
    ) {
        let replacement = state.ssh_tunnels.get(&id).map(|entry| entry.stop.clone());
        self.0.push(ChangedForward {
            id,
            original,
            replacement,
        });
    }

    pub(super) async fn restore(
        &mut self,
        app: &AppHandle,
        state: &Arc<AppState>,
    ) -> Result<(), String> {
        let _start_guard = state.ssh_tunnel_start_lock.lock().await;
        let mut failures = Vec::new();
        // Release the managed listener before restarting the original manual rule on that port.
        for change in self.0.drain(..).rev() {
            let current = state
                .ssh_tunnels
                .get(&change.id)
                .map(|entry| entry.stop.clone());
            if !same_runtime(current.as_ref(), change.replacement.as_ref()) {
                continue;
            }
            stop_and_wait(state, &change.id).await;
            let _ = app.emit("ssh_tunnel_status", TunnelStatus::stopped(change.id));
            if let Some(original) = change.original {
                let config = state.config.read().await;
                let can_restore = config.ssh_enabled
                    && SshLink::from_config(&config, &original.link.conn.id)
                        .is_ok_and(|current| original.link.same_login(&current));
                drop(config);
                if can_restore {
                    if let Err(error) = original.start(app, state, original.rules.clone()).await {
                        failures.push(error);
                    }
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("；"))
        }
    }
}

fn same_runtime(current: Option<&Arc<AtomicBool>>, replacement: Option<&Arc<AtomicBool>>) -> bool {
    match (current, replacement) {
        (Some(current), Some(replacement)) => {
            Arc::ptr_eq(current, replacement) && !current.load(Ordering::SeqCst)
        }
        (None, None) => true,
        _ => false,
    }
}

#[cfg(test)]
#[test]
fn rollback_never_stops_a_newer_or_explicitly_stopped_runtime() {
    let attempt = Arc::new(AtomicBool::new(false));
    let newer = Arc::new(AtomicBool::new(false));
    assert!(same_runtime(Some(&attempt), Some(&attempt)));
    assert!(same_runtime(None, None));
    assert!(!same_runtime(Some(&newer), Some(&attempt)));
    assert!(!same_runtime(None, Some(&attempt)));
    attempt.store(true, Ordering::SeqCst);
    assert!(!same_runtime(Some(&attempt), Some(&attempt)));
}

pub(super) fn plan_owned(
    state: &AppState,
    config: &BridgeConfig,
    link: &SshLink,
    rules: &[ForwardRule],
) -> Result<Vec<ForwardAdjustment>, String> {
    let claims: Vec<_> = rules
        .iter()
        .map(|rule| ManagedForward {
            connection_id: link.conn.id.clone(),
            rule: rule.clone(),
            phase: "running".into(),
            enabled: true,
            message: None,
        })
        .collect();
    let existing = super::forward_context_cmds::context_for(config, state, &link.conn, &[]);
    if existing.managed.iter().any(|m| {
        m.connection_id != link.conn.id
            && rules
                .iter()
                .any(|r| ownership::listeners_overlap(r, &m.rule))
    }) {
        return Err("这台服务器的端口已由另一条 Claude Code 隧道管理，请前往已有接入设置。".into());
    }
    let mut adjustments = Vec::new();
    for connection in config
        .ssh_connections
        .iter()
        .filter(|c| ownership::same_server(c, &link.conn))
    {
        let configured = ownership::context(connection, &connection.forwards, claims.clone());
        if let Some(conflict) = configured.conflicts.first() {
            return Err(conflict.message.clone());
        }
        let Some(tunnel) = state.ssh_tunnels.get(&connection.id) else {
            continue;
        };
        let snapshot = tunnel
            .status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let running: Vec<_> = snapshot.rules.iter().map(|r| r.rule.clone()).collect();
        let plan = ownership::context(connection, &running, claims.clone());
        if let Some(conflict) = plan.conflicts.first() {
            return Err(conflict.message.clone());
        }
        drop(tunnel);
        if !plan.managed_rule_ids.is_empty() {
            if let Some(original) = RunningForward::capture(state, &connection.id)? {
                adjustments.push(ForwardAdjustment {
                    rules: plan.manual_rules,
                    original,
                });
            }
        }
    }
    Ok(adjustments)
}

pub(super) async fn prepare_owned(
    app: &AppHandle,
    state: &Arc<AppState>,
    config: &BridgeConfig,
    link: &SshLink,
    rules: &[ForwardRule],
    takeover: &mut Takeover,
) -> Result<(), String> {
    let adjustments = plan_owned(state, config, link, rules)?;
    // Validate every collision before stopping anything. The caller holds the shared start lock.
    for adjustment in adjustments {
        let id = adjustment.original.id.clone();
        if adjustment.rules.is_empty() {
            stop_and_wait(state, &id).await;
            let _ = app.emit("ssh_tunnel_status", TunnelStatus::stopped(id.clone()));
        } else {
            adjustment
                .original
                .start(app, state, adjustment.rules)
                .await?;
        }
        takeover.record(state, id, Some(adjustment.original));
    }
    Ok(())
}
