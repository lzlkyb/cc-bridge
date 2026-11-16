use super::super::stable_connect_cmds::stable_records;
use super::*;
use crate::config::{ForwardKind, SshConnection};
use crate::ssh_tunnel::{RuleState, TunnelState, TunnelStatus};
use crate::stable_connect::{self as stable, StableOperation, StableRecord, StableSaved};
use crate::state::{SshTunnel, SshTunnelRestart};
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

fn fixture(enabled: Option<bool>) -> (BridgeConfig, Arc<AppState>, SshConnection) {
    let mut config = BridgeConfig {
        port: 7823,
        token: "private-test-token".into(),
        ..Default::default()
    };
    let connection = SshConnection {
        id: "server".into(),
        host: "server.test".into(),
        username: "dev".into(),
        forwards: vec![stable::rule(7823, &config)],
        ..Default::default()
    };
    config.ssh_connections = vec![connection.clone()];
    if let Some(enabled) = enabled {
        config.stable_connect.connections.push(StableSaved {
            connection_id: connection.id.clone(),
            port: 7823,
            scope: "project".into(),
            project_path: "/srv/project".into(),
            multi_device: false,
            enabled,
            fingerprint: stable::fingerprint(&config, &connection.id),
            token_fingerprint: String::new(),
            target: None,
            verified_at: Some(100),
        });
    }
    let state = Arc::new(AppState::new(
        Connection::open_in_memory().unwrap(),
        config.clone(),
        std::env::temp_dir().join("cc-bridge-forward-context-no-io"),
    ));
    (config, state, connection)
}

fn insert(
    state: &AppState,
    id: &str,
    connection: &SshConnection,
    rules: &[ForwardRule],
) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let mut status = TunnelStatus::new(id.into(), rules);
    status.state = TunnelState::Up;
    for rule in &mut status.rules {
        rule.state = RuleState::Listening;
    }
    state.ssh_tunnels.insert(
        id.into(),
        SshTunnel {
            stop: stop.clone(),
            status: Arc::new(Mutex::new(status)),
            killer: Arc::new(Mutex::new(None)),
            thread: Mutex::new(None),
            restart: Some(Arc::new(SshTunnelRestart {
                connection: connection.clone(),
                jump: None,
                password: Some("original-one-time".into()),
                passphrase: None,
            })),
        },
    );
    stop
}

fn operation(connection: &SshConnection, active: bool) -> Arc<StableOperation> {
    Arc::new(StableOperation {
        cancel: Arc::new(AtomicBool::new(false)),
        active: AtomicBool::new(active),
        record: Mutex::new(StableRecord {
            connection_id: connection.id.clone(),
            port: 7823,
            scope: "project".into(),
            project_path: "/srv/project".into(),
            multi_device: false,
            configured: false,
            enabled: false,
            phase: if active { "running" } else { "error" }.into(),
            step: 1,
            message: None,
            needs_secret: false,
            config_matches: false,
            target: None,
            verified_at: None,
        }),
        access: None,
    })
}

#[test]
fn vpn_listener_failure_remains_recoverable_then_becomes_ready_on_the_original_port() {
    let (config, state, connection) = fixture(Some(true));
    let before = serde_json::to_value(&config.stable_connect).unwrap();
    let id = stable::runtime_id(&connection.id);
    insert(&state, &id, &connection, &connection.forwards);
    state
        .ssh_tunnels
        .get(&id)
        .unwrap()
        .status
        .lock()
        .unwrap()
        .apply_line("Warning: remote port forwarding failed for listen port 7823");
    let retry = stable_records(&config, &state).remove(0);
    assert_eq!(retry.phase, "reconnecting");
    assert!(retry.message.unwrap().contains("自动重试"));
    assert!(retry.enabled);
    {
        let tunnel = state.ssh_tunnels.get(&id).unwrap();
        let mut status = tunnel.status.lock().unwrap();
        status.begin_attempt();
        status.apply_line("Authenticated to server.test ([10.0.0.1]:22) using \"password\".");
        status.apply_line(
            "debug1: remote forward success for: listen 127.0.0.1:7823, connect 127.0.0.1:7823",
        );
    }
    let recovered = stable_records(&config, &state).remove(0);
    assert_eq!(recovered.phase, "ready");
    assert_eq!(recovered.port, 7823);
    assert!(recovered.message.is_none());
    assert_eq!(
        serde_json::to_value(&config.stable_connect).unwrap(),
        before
    );
}

#[test]
fn vpn_finished_connection_error_does_not_override_a_recovered_runtime() {
    let (config, state, connection) = fixture(Some(true));
    insert(
        &state,
        &stable::runtime_id(&connection.id),
        &connection,
        &connection.forwards,
    );
    let op = operation(&connection, false);
    {
        let mut record = op.record.lock().unwrap();
        record.configured = true;
        record.enabled = true;
        record.step = 2;
        record.message = Some("固定端口 7823 无法监听".into());
    }
    state.stable_operations.insert(connection.id.clone(), op);
    let recovered = stable_records(&config, &state).remove(0);
    assert_eq!(recovered.phase, "ready");
    assert!(recovered.message.is_none());
}

#[test]
fn vpn_configuration_errors_and_active_progress_remain_visible() {
    let (config, state, connection) = fixture(Some(true));
    insert(
        &state,
        &stable::runtime_id(&connection.id),
        &connection,
        &connection.forwards,
    );
    for (active, phase) in [(false, "error"), (true, "running")] {
        let op = operation(&connection, active);
        {
            let mut record = op.record.lock().unwrap();
            record.configured = true;
            record.step = 3;
        }
        state.stable_operations.insert(connection.id.clone(), op);
        assert_eq!(stable_records(&config, &state)[0].phase, phase);
    }
}

#[tokio::test]
async fn vpn_resume_keeps_supervisor_and_persists_only_the_original_endpoint_intent() {
    let (mut config, state, connection) = fixture(Some(false));
    config.ssh_enabled = true;
    config.stable_connect.method = Some("stable".into());
    config.stable_connect.selected_connection_id = Some(connection.id.clone());
    config.stable_connect.connections[0].fingerprint = stable::fingerprint(&config, &connection.id);
    *state.config.write().await = config.clone();
    state.mcp_running.store(true, Ordering::SeqCst);
    {
        let db = state.db.lock().await;
        db.execute_batch("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .unwrap();
        crate::config::save_full_config(&db, &config).unwrap();
    }
    let id = stable::runtime_id(&connection.id);
    let stop = insert(&state, &id, &connection, &connection.forwards);
    state
        .ssh_tunnels
        .get(&id)
        .unwrap()
        .status
        .lock()
        .unwrap()
        .begin_attempt();
    let op = operation(&connection, true);
    {
        let mut record = op.record.lock().unwrap();
        record.configured = true;
        record.step = 2;
    }
    super::super::stable_connect_run::resume_saved(
        &state,
        &config,
        &op,
        &config.stable_connect.connections[0],
    )
    .await
    .unwrap();
    op.active.store(false, Ordering::SeqCst);
    state.stable_operations.insert(connection.id.clone(), op);
    let mut expected = config.clone();
    expected.stable_connect.connections[0].enabled = true;
    assert_eq!(
        serde_json::to_value(&*state.config.read().await).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    let persisted = crate::config::load_config(&*state.db.lock().await).unwrap();
    assert_eq!(
        serde_json::to_value(&persisted.stable_connect).unwrap(),
        serde_json::to_value(&expected.stable_connect).unwrap()
    );
    assert!(!stop.load(Ordering::SeqCst));
    assert_eq!(stable_records(&expected, &state)[0].phase, "reconnecting");
}

#[test]
fn vpn_authentication_failure_still_requires_login_instead_of_background_retries() {
    let (config, state, connection) = fixture(Some(true));
    let id = stable::runtime_id(&connection.id);
    insert(&state, &id, &connection, &connection.forwards);
    {
        let tunnel = state.ssh_tunnels.get(&id).unwrap();
        let mut status = tunnel.status.lock().unwrap();
        status.state = TunnelState::Error;
        status.needs_secret = true;
        status.message = Some("需要密码或密钥口令".into());
    }
    let failed = stable_records(&config, &state).remove(0);
    assert_eq!(failed.phase, "error");
    assert!(failed.needs_secret);
}

#[tokio::test]
async fn vpn_cancelled_or_changed_resume_cannot_enable_the_saved_tunnel() {
    for cancelled in [true, false] {
        let (mut config, state, connection) = fixture(Some(false));
        config.ssh_enabled = true;
        config.stable_connect.connections[0].fingerprint =
            stable::fingerprint(&config, &connection.id);
        *state.config.write().await = config.clone();
        state.mcp_running.store(true, Ordering::SeqCst);
        let op = operation(&connection, true);
        if cancelled {
            op.cancel.store(true, Ordering::SeqCst);
        } else {
            state.config.write().await.token = "changed-during-resume".into();
        }
        assert!(super::super::stable_connect_run::resume_saved(
            &state,
            &config,
            &op,
            &config.stable_connect.connections[0]
        )
        .await
        .is_err());
        assert!(!state.config.read().await.stable_connect.connections[0].enabled);
    }
}

#[test]
fn paused_saved_tunnel_keeps_ownership_even_without_a_runtime_or_current_selection() {
    let (mut config, state, connection) = fixture(Some(false));
    config.stable_connect.method = Some("direct".into());
    let result = context_for(&config, &state, &connection, &connection.forwards);
    assert!(result.manual_rules.is_empty());
    assert!(!result.managed[0].enabled);
    assert_eq!(result.managed[0].phase, "stopped");
    assert!(state.ssh_tunnels.is_empty());
    let json = serde_json::to_string(&result).unwrap();
    assert!(!json.contains(&config.token));
}

#[test]
fn in_flight_setup_claims_its_listener_but_failed_unconfigured_setup_does_not() {
    let (config, state, connection) = fixture(None);
    state
        .stable_operations
        .insert(connection.id.clone(), operation(&connection, true));
    assert!(
        context_for(&config, &state, &connection, &connection.forwards)
            .manual_rules
            .is_empty()
    );
    state
        .stable_operations
        .insert(connection.id.clone(), operation(&connection, false));
    let failed = context_for(&config, &state, &connection, &connection.forwards);
    assert!(failed.managed.is_empty());
    assert_eq!(failed.manual_rules.len(), 1);
}

#[test]
fn unapplied_local_port_change_reserves_live_and_planned_targets() {
    let (mut config, state, connection) = fixture(Some(true));
    insert(
        &state,
        &stable::runtime_id(&connection.id),
        &connection,
        &connection.forwards,
    );
    config.port = 9000;
    let result = context_for(&config, &state, &connection, &connection.forwards);
    assert!(result.manual_rules.is_empty());
    assert_eq!(result.managed.len(), 2);
    assert!(result.managed.iter().any(|m| m.rule.target_port == 7823));
    assert!(result.managed.iter().any(|m| m.rule.target_port == 9000));
    assert_eq!(config.stable_connect.connections[0].port, 7823);
}

#[test]
fn manual_status_counts_only_extra_rules_and_never_promotes_managed_state() {
    let (config, state, connection) = fixture(Some(true));
    insert(&state, &connection.id, &connection, &connection.forwards);
    let legacy_only = context_for(&config, &state, &connection, &connection.forwards);
    assert!(legacy_only.manual_status.is_none());
    assert_eq!(legacy_only.managed[0].phase, "stopped");
    let extra = ForwardRule {
        id: "database".into(),
        kind: ForwardKind::Local,
        listen_port: 15432,
        target_port: 5432,
        ..connection.forwards[0].clone()
    };
    insert(
        &state,
        &connection.id,
        &connection,
        &[connection.forwards[0].clone(), extra],
    );
    let result = context_for(&config, &state, &connection, &connection.forwards);
    assert_eq!(result.manual_status.unwrap().rules.len(), 1);
}

#[test]
fn takeover_rebuilds_only_extra_rules_using_the_original_running_snapshot_and_credentials() {
    let (mut config, state, connection) = fixture(Some(true));
    let extra = ForwardRule {
        id: "database".into(),
        kind: ForwardKind::Local,
        listen_port: 15432,
        target_port: 5432,
        ..connection.forwards[0].clone()
    };
    let stop = insert(
        &state,
        &connection.id,
        &connection,
        &[connection.forwards[0].clone(), extra],
    );
    config.ssh_connections[0].forwards.push(ForwardRule {
        id: "database".into(),
        kind: ForwardKind::Local,
        listen_port: 15432,
        target_port: 6000,
        ..connection.forwards[0].clone()
    });
    let link = super::super::ssh_cmds::SshLink::from_config(&config, &connection.id).unwrap();
    let plan =
        super::super::forward_takeover::plan_owned(&state, &config, &link, &connection.forwards)
            .unwrap();
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].rules[0].target_port, 5432);
    assert_eq!(
        plan[0].original.password.as_deref(),
        Some("original-one-time")
    );
    assert_eq!(
        plan[0].original.rules,
        [
            connection.forwards[0].clone(),
            ForwardRule {
                id: "database".into(),
                kind: ForwardKind::Local,
                listen_port: 15432,
                target_port: 5432,
                ..connection.forwards[0].clone()
            }
        ]
    );
    assert!(!stop.load(Ordering::SeqCst));
    assert_eq!(config.stable_connect.connections[0].scope, "project");
    assert_eq!(
        config.stable_connect.connections[0].project_path,
        "/srv/project"
    );
}

#[test]
fn preflight_conflict_preserves_all_existing_processes() {
    let (mut config, state, connection) = fixture(Some(true));
    let manual = insert(&state, &connection.id, &connection, &connection.forwards);
    let managed = insert(
        &state,
        &stable::runtime_id(&connection.id),
        &connection,
        &connection.forwards,
    );
    config.ssh_connections[0].forwards[0].target_port = 9000;
    let link = super::super::ssh_cmds::SshLink::from_config(&config, &connection.id).unwrap();
    let result =
        super::super::forward_takeover::plan_owned(&state, &config, &link, &connection.forwards);
    assert!(result.is_err());
    assert!(!manual.load(Ordering::SeqCst));
    assert!(!managed.load(Ordering::SeqCst));
    assert_eq!(state.ssh_tunnels.len(), 2);
}

#[test]
fn scope_change_can_reuse_a_healthy_listener_with_the_same_login() {
    let (config, state, connection) = fixture(Some(true));
    let id = stable::runtime_id(&connection.id);
    let rule = stable::rule(7823, &config);
    let stop = insert(&state, &id, &connection, std::slice::from_ref(&rule));
    let link = super::super::ssh_cmds::SshLink::from_config(&config, &connection.id).unwrap();
    let ready = super::super::ssh_tunnel_cmds::owned_tunnel_is_ready;
    assert!(ready(&state, &id, &link, std::slice::from_ref(&rule)));
    assert!(!ready(
        &state,
        &id,
        &link,
        &[ForwardRule {
            target_port: 9000,
            ..rule.clone()
        }]
    ));
    let mut edited = config.clone();
    edited.ssh_connections[0].key_path = "different-key".into();
    let new_login = super::super::ssh_cmds::SshLink::from_config(&edited, &connection.id).unwrap();
    assert!(!ready(&state, &id, &new_login, &[rule]));
    assert!(!stop.load(Ordering::SeqCst));
}

#[test]
fn takeover_captures_a_manual_forward_even_when_no_other_rules_remain() {
    let (config, state, connection) = fixture(None);
    let stop = insert(&state, &connection.id, &connection, &connection.forwards);
    let link = super::super::ssh_cmds::SshLink::from_config(&config, &connection.id).unwrap();
    let plan =
        super::super::forward_takeover::plan_owned(&state, &config, &link, &connection.forwards)
            .unwrap();
    assert!(plan[0].rules.is_empty());
    assert_eq!(plan[0].original.rules, connection.forwards);
    assert_eq!(
        plan[0].original.password.as_deref(),
        Some("original-one-time")
    );
    assert!(!stop.load(Ordering::SeqCst));
}

#[test]
fn alias_cannot_start_another_managed_process_on_the_owned_port() {
    let (mut config, state, connection) = fixture(Some(true));
    let alias = SshConnection {
        id: "alias".into(),
        ..connection.clone()
    };
    config.ssh_connections.push(alias.clone());
    let link = super::super::ssh_cmds::SshLink::from_config(&config, &alias.id).unwrap();
    assert!(super::super::forward_takeover::plan_owned(
        &state,
        &config,
        &link,
        &connection.forwards
    )
    .is_err());
    let result = context_for(&config, &state, &alias, &alias.forwards);
    assert!(result.manual_rules.is_empty());
    assert_eq!(result.managed[0].connection_id, connection.id);
}
