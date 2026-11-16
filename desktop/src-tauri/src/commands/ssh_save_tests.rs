use super::*;
use crate::config::{BridgeConfig, ForwardAuto, ForwardRule};
use crate::ssh_tunnel::{RuleState, TunnelState, TunnelStatus};
use crate::stable_connect::{self as stable, StableOperation, StableRecord, StableSaved};
use crate::state::SshTunnel;
use std::sync::atomic::{AtomicBool, Ordering};

fn saved_connection() -> SshConnection {
    SshConnection {
        id: "cloud".into(),
        name: "Cloud".into(),
        host: "original.example".into(),
        username: "user".into(),
        remember_password: true,
        encrypted_password: "fixture-saved-ciphertext".into(),
        ..Default::default()
    }
}

fn register_tunnel(state: &AppState, id: String, rules: &[ForwardRule]) -> Arc<AtomicBool> {
    // No SSH process is started: exercise the real save path with observable runtime handles.
    let stop = Arc::new(AtomicBool::new(false));
    let mut status = TunnelStatus::new(id.clone(), rules);
    status.state = TunnelState::Up;
    for rule in &mut status.rules {
        rule.state = RuleState::Listening;
    }
    state.ssh_tunnels.insert(
        id,
        SshTunnel {
            stop: stop.clone(),
            status: Arc::new(StdMutex::new(status)),
            killer: Arc::new(StdMutex::new(None)),
            thread: StdMutex::new(None),
            restart: None,
        },
    );
    stop
}

struct SaveFixture {
    state: AppState,
    connection: SshConnection,
    stable_stop: Arc<AtomicBool>,
    ordinary_stop: Arc<AtomicBool>,
    directory: PathBuf,
}

impl SaveFixture {
    fn new(connection: SshConnection) -> Self {
        let directory =
            std::env::temp_dir().join(format!("cc-bridge-ssh-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut config = BridgeConfig {
            ssh_enabled: true,
            ..Default::default()
        };
        config.ssh_connections = vec![
            connection.clone(),
            SshConnection {
                id: "jump".into(),
                host: "jump.example".into(),
                username: "user".into(),
                ..Default::default()
            },
        ];
        config.stable_connect.connections.push(StableSaved {
            connection_id: connection.id.clone(),
            port: 17823,
            scope: "project".into(),
            project_path: "/srv/project".into(),
            multi_device: false,
            enabled: true,
            fingerprint: stable::fingerprint(&config, &connection.id),
            token_fingerprint: crate::connection_access::token_fingerprint(&config),
            target: None,
            verified_at: None,
        });
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .unwrap();
        crate::config::save_full_config(&db, &config).unwrap();
        let rule = stable::rule(17823, &config);
        let state = AppState::new(db, config, directory.clone());
        let stable_stop = register_tunnel(&state, stable::runtime_id(&connection.id), &[rule]);
        let ordinary_stop = register_tunnel(&state, connection.id.clone(), &[]);
        Self {
            state,
            connection,
            stable_stop,
            ordinary_stop,
            directory,
        }
    }

    fn pending_setup(&self) -> Arc<AtomicBool> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.state.stable_operations.insert(
            self.connection.id.clone(),
            Arc::new(StableOperation {
                cancel: cancel.clone(),
                active: AtomicBool::new(true),
                record: StdMutex::new(StableRecord {
                    connection_id: self.connection.id.clone(),
                    port: 17823,
                    scope: "project".into(),
                    project_path: "/srv/project".into(),
                    multi_device: false,
                    configured: false,
                    enabled: true,
                    phase: "configuring".into(),
                    step: 1,
                    message: None,
                    needs_secret: false,
                    config_matches: true,
                    target: None,
                    verified_at: None,
                }),
                access: None,
            }),
        );
        cancel
    }

    fn assert_running(&self) {
        assert!(self
            .state
            .ssh_tunnels
            .contains_key(&stable::runtime_id(&self.connection.id)));
        assert!(!self.stable_stop.load(Ordering::SeqCst));
        assert!(!self.ordinary_stop.load(Ordering::SeqCst));
    }

    fn assert_stopped(&self) {
        assert!(!self
            .state
            .ssh_tunnels
            .contains_key(&stable::runtime_id(&self.connection.id)));
        assert!(self.stable_stop.load(Ordering::SeqCst));
        assert!(self.state.ssh_tunnels.contains_key(&self.connection.id));
        assert!(!self.ordinary_stop.load(Ordering::SeqCst));
    }
}

impl Drop for SaveFixture {
    fn drop(&mut self) {
        // Only remove the key file this fixture can create, then its otherwise empty directory.
        let _ = std::fs::remove_file(self.directory.join("ssh_key.bin"));
        let _ = std::fs::remove_dir(&self.directory);
    }
}

#[tokio::test]
async fn saving_forward_rules_preserves_the_access_tunnel() {
    let fixture = SaveFixture::new(saved_connection());
    let cancel = fixture.pending_setup();
    let before = fixture.state.config.read().await.clone();
    let mut connection = fixture.connection.clone();
    connection.forwards = vec![ForwardRule {
        id: "manual-web".into(),
        listen_port: 8888,
        target_port: 80,
        ..Default::default()
    }];
    connection.forward_auto = ForwardAuto::Launch;
    connection.encrypted_password = "ignored-client-ciphertext".into();
    let saved = save_ssh_connection(
        &fixture.state,
        SshSaveArgs {
            connection,
            password: None,
            passphrase: None,
        },
    )
    .await
    .unwrap();
    fixture.assert_running();
    assert!(!cancel.load(Ordering::SeqCst));
    assert_eq!(
        saved.encrypted_password,
        fixture.connection.encrypted_password
    );
    let persisted = crate::config::load_config(&*fixture.state.db.lock().await).unwrap();
    assert_eq!(persisted.ssh_connections[0].forwards, saved.forwards);
    assert_eq!(
        persisted.ssh_connections[0].forward_auto,
        ForwardAuto::Launch
    );
    assert_eq!(
        serde_json::to_value(persisted.stable_connect).unwrap(),
        serde_json::to_value(before.stable_connect).unwrap()
    );
}

#[tokio::test]
async fn saving_unchanged_connection_or_display_name_preserves_the_access_tunnel() {
    for name in ["Cloud", "Renamed cloud"] {
        let fixture = SaveFixture::new(saved_connection());
        let mut connection = fixture.connection.clone();
        connection.name = name.into();
        save_ssh_connection(
            &fixture.state,
            SshSaveArgs {
                connection,
                password: None,
                passphrase: None,
            },
        )
        .await
        .unwrap();
        fixture.assert_running();
    }
}

#[tokio::test]
async fn saving_changed_server_identity_stops_only_the_access_tunnel() {
    let changes: &[fn(&mut SshConnection)] = &[
        |c| c.host = "replacement.example".into(),
        |c| c.port = 2222,
        |c| c.username = "replacement-user".into(),
        |c| {
            c.auth_type = "key".into();
            c.key_path = "id_ed25519".into();
        },
        |c| c.key_path = "replacement-key".into(),
        |c| c.proxy_jump_id = "jump".into(),
        |c| c.remember_password = false,
    ];
    for change in changes {
        let fixture = SaveFixture::new(saved_connection());
        let cancel = fixture.pending_setup();
        let mut connection = fixture.connection.clone();
        change(&mut connection);
        save_ssh_connection(
            &fixture.state,
            SshSaveArgs {
                connection,
                password: None,
                passphrase: None,
            },
        )
        .await
        .unwrap();
        fixture.assert_stopped();
        assert!(cancel.load(Ordering::SeqCst));
        assert_eq!(
            fixture.state.config.read().await.stable_connect.connections[0].port,
            17823
        );
    }
}

#[tokio::test]
async fn saving_new_password_stops_the_access_tunnel_and_encrypts_the_password() {
    let fixture = SaveFixture::new(saved_connection());
    let saved = save_ssh_connection(
        &fixture.state,
        SshSaveArgs {
            connection: fixture.connection.clone(),
            password: Some("fixture-new-password".into()),
            passphrase: None,
        },
    )
    .await
    .unwrap();
    fixture.assert_stopped();
    assert_ne!(
        saved.encrypted_password,
        fixture.connection.encrypted_password
    );
    assert_eq!(
        decrypt_saved_credential(&saved.encrypted_password, &fixture.directory).unwrap(),
        "fixture-new-password"
    );
}

#[tokio::test]
async fn saving_new_key_passphrase_stops_the_access_tunnel_and_encrypts_the_passphrase() {
    let fixture = SaveFixture::new(SshConnection {
        auth_type: "key".into(),
        key_path: "id_ed25519".into(),
        remember_password: false,
        encrypted_password: String::new(),
        remember_passphrase: true,
        encrypted_passphrase: "fixture-saved-passphrase".into(),
        ..saved_connection()
    });
    let saved = save_ssh_connection(
        &fixture.state,
        SshSaveArgs {
            connection: fixture.connection.clone(),
            password: None,
            passphrase: Some("fixture-new-passphrase".into()),
        },
    )
    .await
    .unwrap();
    fixture.assert_stopped();
    assert_ne!(
        saved.encrypted_passphrase,
        fixture.connection.encrypted_passphrase
    );
    assert_eq!(
        decrypt_saved_credential(&saved.encrypted_passphrase, &fixture.directory).unwrap(),
        "fixture-new-passphrase"
    );
}

#[tokio::test]
async fn invalid_forward_rules_preserve_the_access_tunnel_and_saved_configuration() {
    let fixture = SaveFixture::new(saved_connection());
    let before = serde_json::to_value(&*fixture.state.config.read().await).unwrap();
    let mut connection = fixture.connection.clone();
    connection.forwards = vec![ForwardRule {
        listen_port: 8888,
        target_port: 0,
        ..Default::default()
    }];
    assert!(save_ssh_connection(
        &fixture.state,
        SshSaveArgs {
            connection,
            password: None,
            passphrase: None,
        }
    )
    .await
    .is_err());
    fixture.assert_running();
    assert_eq!(
        serde_json::to_value(&*fixture.state.config.read().await).unwrap(),
        before
    );
}
