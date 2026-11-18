//! Transfer only a duplicated Claude listener, preserving the running snapshot of extra rules.
use super::ssh_cmds::SshLink;
use super::ssh_tunnel_cmds::{start_plan, stop_and_wait};
use crate::config::{BridgeConfig, ForwardRule};
use crate::forward_ownership::{self as ownership, ManagedForward};
use crate::ssh_tunnel::{TunnelState, TunnelStatus};
use crate::state::AppState;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub(super) struct ForwardAdjustment {
    pub rules: Vec<ForwardRule>,
    pub original: RunningForward,
}

/// Clone 是给「先登记再动进程」用的：登记要存一份 original，动进程还要用原件。
#[derive(Clone)]
pub(super) struct RunningForward {
    id: String,
    pub rules: Vec<ForwardRule>,
    link: SshLink,
    pub password: Option<String>,
    pub(super) passphrase: Option<String>,
}

impl RunningForward {
    pub(super) fn same_login(&self, link: &SshLink) -> bool {
        self.link.same_login(link)
    }

    pub(super) fn capture(state: &AppState, id: &str) -> Result<Option<Self>, String> {
        let Some(tunnel) = state.ssh_tunnels.get(id) else {
            return Ok(None);
        };
        // 在一个块里取完再松手：DashMap 的 Ref 与 status 锁都不能带到 Self 构造里。
        let (rules, link, password, passphrase) = {
            let status = tunnel.status.lock().unwrap_or_else(|p| p.into_inner());
            if matches!(status.state, TunnelState::Error | TunnelState::Stopped) {
                return Ok(None);
            }
            let restart = tunnel
                .restart
                .as_ref()
                .ok_or("缺少恢复原有转发所需的登录信息。")?;
            let rules = status
                .rules
                .iter()
                .map(|entry| entry.rule.clone())
                .collect();
            let link = SshLink::new(restart.connection.clone(), restart.jump.clone())?;
            let password = restart
                .password
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            let passphrase = restart
                .passphrase
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            (rules, link, password, passphrase)
        };
        Ok(Some(Self {
            id: id.into(),
            rules,
            link,
            password,
            passphrase,
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
    /// 动进程**之前**该连接在跑的 runtime（`None` = 当时没在跑）。
    previous: Option<Arc<AtomicBool>>,
    /// 动进程**之后**我们留下的 runtime（缩减版重启成功 = 新句柄；停掉 / 没起成 = `None`）。
    replacement: Option<Arc<AtomicBool>>,
    stop_generation: u64,
}

#[derive(Default)]
pub(super) struct Takeover(Vec<ChangedForward>);

impl Takeover {
    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// 动进程**之前**登记。必须赶在 `stop_and_wait` 之前：start 中途失败时 map 已空
    /// （`halt` 即 remove），事后登记就再也说不出原来跑的是什么，回滚便无从谈起。
    pub(super) fn record(
        &mut self,
        state: &AppState,
        id: String,
        original: Option<RunningForward>,
    ) {
        let previous = state.ssh_tunnels.get(&id).map(|entry| entry.stop.clone());
        let stop_generation = state.ssh_tunnel_stops.get(&id).map_or(0, |value| *value);
        self.0.push(ChangedForward {
            id,
            original,
            previous,
            replacement: None,
            stop_generation,
        });
    }

    /// 动进程**之后**更新留下的 runtime：缩减版重启成功后 map 里是新句柄，
    /// 停掉或没起成则留 `None`（该连接当前没有 runtime，回滚时直接恢复原样）。
    pub(super) fn settle(&mut self, state: &AppState, id: &str) {
        if let Some(change) = self.0.iter_mut().rev().find(|c| c.id == id) {
            change.replacement = state.ssh_tunnels.get(id).map(|entry| entry.stop.clone());
        }
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
            let stop_generation = state
                .ssh_tunnel_stops
                .get(&change.id)
                .map_or(0, |value| *value);
            if !ours_to_restore(current.as_ref(), &change, stop_generation) {
                continue;
            }
            if current
                .as_ref()
                .zip(change.previous.as_ref())
                .is_some_and(|(current, previous)| Arc::ptr_eq(current, previous))
            {
                // Validation can fail before any replacement was made. Leave the original process alive.
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

/// 当前 runtime 是不是「接管流程自己的」，能不能碰。
///
/// A later explicit user stop always wins, even if the runtime entry has disappeared.
/// - `None`：我们停掉后没起成 / 起了又停——正是「动进程到一半失败」的现场，
///   必须允许恢复原样（曾经这里一律跳过，用户的手动转发就静默丢了）。
/// - `previous` / `replacement` 之一：我们留下的，可以恢复。
/// - 第三者（用户另起的、被别的启动顶替的）：不碰。
fn ours_to_restore(
    current: Option<&Arc<AtomicBool>>,
    change: &ChangedForward,
    stop_generation: u64,
) -> bool {
    if stop_generation != change.stop_generation {
        return false;
    }
    match current {
        None => true,
        Some(current) => {
            change
                .replacement
                .as_ref()
                .is_some_and(|r| Arc::ptr_eq(r, current))
                || change
                    .previous
                    .as_ref()
                    .is_some_and(|p| Arc::ptr_eq(p, current))
        }
    }
}

#[cfg(test)]
fn changed(
    previous: Option<Arc<AtomicBool>>,
    replacement: Option<Arc<AtomicBool>>,
) -> ChangedForward {
    ChangedForward {
        id: "c".into(),
        original: None,
        previous,
        replacement,
        stop_generation: 0,
    }
}

#[cfg(test)]
#[test]
fn rollback_never_stops_a_newer_or_explicitly_stopped_runtime() {
    let attempt = Arc::new(AtomicBool::new(false));
    let newer = Arc::new(AtomicBool::new(false));
    assert!(ours_to_restore(
        Some(&attempt),
        &changed(Some(attempt.clone()), None),
        0
    ));
    assert!(ours_to_restore(
        None,
        &changed(Some(attempt.clone()), None),
        0
    ));
    assert!(!ours_to_restore(
        Some(&newer),
        &changed(Some(attempt.clone()), None),
        0
    ));
    assert!(!ours_to_restore(
        None,
        &changed(None, Some(attempt.clone())),
        1
    ));
}

/// 「动进程到一半失败」：旧隧道已停、新规则没起成，map 里什么都没有。
/// 这条路径必须能恢复原手动转发——B3 的回归就在这里。
#[test]
fn rollback_restores_after_a_half_finished_takeover() {
    let stopped = Arc::new(AtomicBool::new(true));
    assert!(
        ours_to_restore(None, &changed(Some(stopped.clone()), None), 0),
        "停掉旧隧道后没起成，map 为空也必须允许恢复"
    );
    assert!(
        ours_to_restore(None, &changed(None, None), 0),
        "从未起过的连接同样允许恢复（original 为 None 时循环里自然跳过）"
    );
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
        // 🔴 先登记再动进程：start 中途失败时 map 已空（halt 即 remove），
        // 事后登记就丢了这条连接的身份，外层 restore 会认不出该恢复谁，
        // 用户的手动转发就静默没了（B3）。
        takeover.record(state, id.clone(), Some(adjustment.original.clone()));
        let outcome = if adjustment.rules.is_empty() {
            stop_and_wait(state, &id).await;
            let _ = app.emit("ssh_tunnel_status", TunnelStatus::stopped(id.clone()));
            Ok(())
        } else {
            adjustment
                .original
                .start(app, state, adjustment.rules)
                .await
        };
        // 无论成败都更新留下的 runtime：成功 = 缩减版新句柄，失败 = None（该恢复了）。
        takeover.settle(state, &id);
        outcome?;
    }
    Ok(())
}
