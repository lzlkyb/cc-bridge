//! Relay routes own their SSH listeners and never edit a Connect or manual rule.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::{
    forward_takeover::RunningForward,
    ssh_cmds::SshLink,
    ssh_tunnel_cmds::{start_plan, stop_and_release, stop_and_wait},
};
use crate::{
    config::{ForwardKind, ForwardRule},
    db::{get_config_value, set_config_value},
    relay::config::DEFAULT_PORT,
    ssh_tunnel::{RuleState, TunnelState, TunnelStatus},
    state::AppState,
};

const PREFIX: &str = "relay:";
const LOOPBACK: &str = "127.0.0.1";

pub(super) fn is_relay_runtime(id: &str) -> bool {
    id.starts_with(PREFIX)
}

pub(super) fn runtime_id(connection_id: &str) -> String {
    format!("{PREFIX}{connection_id}")
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Endpoint {
    host: String,
    port: u16,
    username: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Route {
    target: Endpoint,
    jump: Option<Endpoint>,
    port: u16,
}

impl Route {
    fn new(link: &SshLink, port: u16) -> Self {
        fn endpoint(connection: &crate::config::SshConnection) -> Endpoint {
            Endpoint {
                host: connection.host.clone(),
                port: connection.port,
                username: connection.username.clone(),
            }
        }
        Self {
            target: endpoint(&link.conn),
            jump: link.jump.as_ref().map(endpoint),
            port,
        }
    }

    fn load(db: &rusqlite::Connection, link: &SshLink) -> Option<Self> {
        let route: Self =
            serde_json::from_str(&get_config_value(db, &runtime_id(&link.conn.id))?).ok()?;
        let current = Self::new(link, 0);
        (route.target == current.target && route.jump == current.jump).then_some(route)
    }

    fn save(&self, db: &rusqlite::Connection, id: &str) -> Result<(), String> {
        set_config_value(
            db,
            id,
            &serde_json::to_string(self).map_err(|e| e.to_string())?,
        )
    }
}

fn rule(port: u16) -> ForwardRule {
    ForwardRule {
        id: "model-relay".into(),
        kind: ForwardKind::Remote,
        listen_host: LOOPBACK.into(),
        listen_port: port,
        target_host: LOOPBACK.into(),
        target_port: DEFAULT_PORT,
        note: "模型中转".into(),
        ..Default::default()
    }
}

pub(super) async fn save_allocated_port(
    state: &AppState,
    link: &SshLink,
    port: u16,
    stop: &AtomicBool,
) -> Result<(), String> {
    let db = state.db.lock().await;
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    Route::new(link, port).save(&db, &runtime_id(&link.conn.id))
}

pub(super) fn pin_allocated_port(status: &mut TunnelStatus) -> Option<u16> {
    let row = status.rules.first_mut()?;
    let port = row.bound_port.filter(|port| *port != 0)?;
    if row.rule.listen_port != 0 || row.state != RuleState::Listening {
        return None;
    }
    // begin_attempt clears the current listener; the assigned port belongs to the route.
    row.rule.listen_port = port;
    Some(port)
}

async fn relay_available(state: &AppState) -> bool {
    let allowed = {
        let config = state.config.read().await;
        config.ssh_enabled && config.relay_listen_mode == "tunnel"
    };
    allowed
        && state.relay.running_addr().await.as_deref()
            == Some(&format!("{LOOPBACK}:{DEFAULT_PORT}"))
}

#[tauri::command]
pub async fn relay_tunnel_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    password: Option<String>,
    passphrase: Option<String>,
    reallocate: bool,
) -> Result<TunnelStatus, String> {
    let state = state.inner();
    let _lock = state.relay_tunnel_lock.lock().await;
    if !relay_available(state).await {
        return Err("请开启 SSH 功能，并让模型中转在隧道模式下运行。".into());
    }
    let link = SshLink::from_config(&*state.config.read().await, &connection_id)?;
    let id = runtime_id(&connection_id);
    let credentials = password.is_some() || passphrase.is_some();
    if let Some(tunnel) = state.ssh_tunnels.get(&id) {
        let status = tunnel.status.lock().unwrap_or_else(|p| p.into_inner());
        if reallocate
            && !(matches!(status.state, TunnelState::Error | TunnelState::Reconnecting)
                && status
                    .rules
                    .first()
                    .is_some_and(|row| row.state == RuleState::Failed && row.rule.listen_port > 0))
        {
            return Err("隧道状态已更新，请确认当前端口状态后再操作。".into());
        }
        if !credentials
            && !reallocate
            && !matches!(status.state, TunnelState::Error | TunnelState::Stopped)
        {
            return Ok(status.clone());
        }
    }
    let existing = [
        id.clone(),
        crate::stable_connect::runtime_id(&connection_id),
        connection_id,
    ]
    .iter()
    .filter_map(|key| RunningForward::capture(state, key).ok().flatten())
    .find(|forward| forward.same_login(&link));
    let password = password.or_else(|| existing.as_ref()?.password.clone());
    let passphrase = passphrase.or_else(|| existing.as_ref()?.passphrase.clone());

    // Wait before changing the saved assignment so an old SSH process cannot write its port back.
    stop_and_wait(state, &id).await;
    let route = {
        let db = state.db.lock().await;
        let route = if reallocate {
            None
        } else {
            Route::load(&db, &link)
        }
        .unwrap_or_else(|| Route::new(&link, 0));
        route.save(&db, &id)?;
        route
    };
    start_plan(
        app,
        state.clone(),
        id,
        link,
        vec![rule(route.port)],
        password,
        passphrase,
    )
    .await
}

/// Restore only targets the user has already enabled for model relay.
pub async fn sync_relay_tunnels(state: &Arc<AppState>) {
    let _lock = state.relay_tunnel_lock.lock().await;
    let routes = if relay_available(state).await {
        let db = state.db.lock().await;
        let config = state.config.read().await;
        config
            .ssh_connections
            .iter()
            .filter_map(|connection| {
                let link = SshLink::from_config(&config, &connection.id).ok()?;
                let route = Route::load(&db, &link)?;
                Some((runtime_id(&connection.id), link, route.port))
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let obsolete = state
        .ssh_tunnels
        .iter()
        .filter_map(|entry| {
            let id = entry.key();
            (is_relay_runtime(id) && !routes.iter().any(|(wanted, _, _)| wanted == id))
                .then(|| id.clone())
        })
        .collect::<Vec<_>>();
    for id in obsolete {
        stop_and_release(state, &id).await;
        state.emit_tunnels_stopped(&[id]);
    }
    #[cfg(feature = "notifications")]
    let app = state.app_handle.lock().unwrap().clone();
    #[cfg(not(feature = "notifications"))]
    let app: Option<AppHandle> = None;
    let Some(app) = app else {
        return;
    };
    for (id, link, port) in routes {
        if state.ssh_tunnels.contains_key(&id) {
            continue;
        }
        if let Err(error) = start_plan(
            app.clone(),
            state.clone(),
            id.clone(),
            link,
            vec![rule(port)],
            None,
            None,
        )
        .await
        {
            log::warn!("恢复模型中转 SSH 隧道失败（{id}）：{error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SshConnection;

    #[test]
    fn relay_routes_are_scoped_to_the_profile_and_login() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        let connection = SshConnection {
            id: "profile-a".into(),
            host: "shared.example".into(),
            username: "alice".into(),
            ..Default::default()
        };
        let alice = SshLink::new(connection.clone(), None).unwrap();
        let bob = SshLink::new(
            SshConnection {
                id: "profile-b".into(),
                username: "bob".into(),
                ..connection.clone()
            },
            None,
        )
        .unwrap();
        Route::new(&alice, 45201)
            .save(&db, &runtime_id(&alice.conn.id))
            .unwrap();
        Route::new(&bob, 45202)
            .save(&db, &runtime_id(&bob.conn.id))
            .unwrap();
        assert_eq!(Route::load(&db, &alice).unwrap().port, 45201);
        assert_eq!(Route::load(&db, &bob).unwrap().port, 45202);
        let changed = SshLink::new(
            SshConnection {
                username: "charlie".into(),
                ..connection
            },
            None,
        )
        .unwrap();
        assert!(Route::load(&db, &changed).is_none());
        assert_eq!(
            crate::ssh_tunnel::forward_args(&[rule(0)]),
            ["-R", "127.0.0.1:0:127.0.0.1:4100"]
        );
    }

    #[test]
    fn relay_waits_for_the_allocation_and_reuses_it_on_reconnect() {
        let mut status = TunnelStatus::new(runtime_id("alice"), &[rule(0)]);
        status.apply_line("Authenticated to shared.example ([192.0.2.1]:22) using \"publickey\".");
        assert_eq!(pin_allocated_port(&mut status), None);
        status.apply_line(
            "debug1: remote forward success for: listen 127.0.0.1:0, connect 127.0.0.1:4100",
        );
        assert_eq!(pin_allocated_port(&mut status), None);
        status.apply_line("Allocated port 45201 for remote forward to 127.0.0.1:4100");
        assert_eq!(pin_allocated_port(&mut status), Some(45201));
        assert_eq!(pin_allocated_port(&mut status), None);
        status.begin_attempt();
        assert_eq!(status.rules[0].rule.listen_port, 45201);
        assert_eq!(status.rules[0].state, RuleState::Pending);
        status.apply_line(
            "debug1: remote forward success for: listen 127.0.0.1:45201, connect 127.0.0.1:4100",
        );
        assert_eq!(status.rules[0].state, RuleState::Listening);
    }
}
