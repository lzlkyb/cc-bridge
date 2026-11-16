use super::*;
use crate::ssh_tunnel_guard::GuardReceipt;
use std::fs;
use uuid::Uuid;

struct Fixture {
    path: PathBuf,
    guard: Arc<ManagedGuard>,
    attempt: GuardAttempt,
    stop: Arc<AtomicBool>,
}

impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("cc-bridge-tunnel-process-{}", Uuid::new_v4()));
        let guard = Arc::new(ManagedGuard::new(&path, b"fixture", 7823));
        Self {
            path,
            attempt: guard.attempt(),
            guard,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    fn run(&self) -> GuardRun {
        GuardRun::serve(self.guard.clone(), self.attempt.clone(), self.stop.clone())
    }

    fn ready(&self) -> String {
        format!(
            "CCB_TUNNEL_GUARD_READY {}",
            serde_json::to_string(&GuardReceipt {
                version: 1,
                owner: self.attempt.owner.clone(),
                nonce: self.attempt.nonce.clone(),
                port: 7823,
                uid: 1004,
                boot_id: Uuid::new_v4().to_string(),
                pid: 400,
                start_ticks: 500,
                guard_pid: 401,
                guard_start_ticks: 501,
            })
            .unwrap()
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let directory = self.path.join("ssh_tunnel_sessions");
        if let Ok(files) = fs::read_dir(&directory) {
            for file in files.flatten() {
                let _ = fs::remove_file(file.path());
            }
        }
        let _ = fs::remove_dir(directory);
        let _ = fs::remove_dir(&self.path);
    }
}

#[test]
fn heartbeat_waits_for_verified_registration_and_obeys_its_interval() {
    let fixture = Fixture::new();
    let run = fixture.run();
    let start = Instant::now();
    let mut input = Vec::new();
    run.pulse(&mut input, start).unwrap();
    assert!(input.is_empty());
    assert!(matches!(
        run.consume(&fixture.ready()),
        Some(Output::GuardReady)
    ));
    run.pulse(&mut input, start).unwrap();
    assert_eq!(input, fixture.attempt.heartbeat());
    run.pulse(&mut input, start + std::time::Duration::from_secs(9))
        .unwrap();
    assert_eq!(input, fixture.attempt.heartbeat());
    run.pulse(&mut input, start + HEARTBEAT_INTERVAL).unwrap();
    assert_eq!(input, fixture.attempt.heartbeat().repeat(2));
}

#[test]
fn a_paused_guard_neither_registers_nor_sends_heartbeats() {
    let fixture = Fixture::new();
    let run = fixture.run();
    fixture.stop.store(true, Ordering::SeqCst);
    assert!(run.consume(&fixture.ready()).is_none());
    assert!(fixture.guard.previous().is_none());
    let mut input = Vec::new();
    run.pulse(&mut input, Instant::now()).unwrap();
    assert!(input.is_empty());
}

#[test]
fn a_stale_ready_frame_cannot_enable_heartbeats() {
    let fixture = Fixture::new();
    let run = fixture.run();
    let stale = fixture
        .ready()
        .replace(&fixture.attempt.nonce, &Uuid::new_v4().to_string());
    assert!(run.consume(&stale).is_none());
    assert!(run.failure().is_some());
    let mut input = Vec::new();
    run.pulse(&mut input, Instant::now()).unwrap();
    assert!(input.is_empty());
    assert!(fixture.guard.previous().is_none());
}

#[test]
fn stale_reclaim_response_is_rejected_without_changing_the_current_reply() {
    let nonce = Uuid::new_v4().to_string();
    let run = GuardRun::reclaim(nonce, Arc::new(AtomicBool::new(false)));
    let stale = format!(
        "CCB_TUNNEL_RECLAIM_RESULT {{\"nonce\":\"{}\",\"result\":\"released\"}}",
        Uuid::new_v4()
    );
    assert!(run.consume(&stale).is_none());
    assert!(run.reply().is_none());
    assert!(run.failure().is_some());
}

#[test]
fn reclaim_response_does_not_start_another_heartbeat_stream() {
    let nonce = Uuid::new_v4().to_string();
    let run = GuardRun::reclaim(nonce.clone(), Arc::new(AtomicBool::new(false)));
    run.consume(&format!(
        "CCB_TUNNEL_RECLAIM_RESULT {{\"nonce\":\"{nonce}\",\"result\":\"gone\"}}"
    ));
    assert_eq!(run.reply(), Some(ReclaimResult::Gone));
    let mut input = Vec::new();
    run.pulse(&mut input, Instant::now()).unwrap();
    assert!(input.is_empty());
}

#[test]
fn unsupported_guard_environment_stops_without_requesting_another_password() {
    let fixture = Fixture::new();
    let run = fixture.run();
    let response = format!(
        "CCB_TUNNEL_GUARD_ERROR {{\"nonce\":\"{}\",\"code\":\"unsupported\"}}",
        fixture.attempt.nonce
    );
    assert!(run.consume(&response).is_none());
    assert!(matches!(run.failure(), Some(Fatal::GuardUnavailable(_))));
    let mut input = Vec::new();
    run.pulse(&mut input, Instant::now()).unwrap();
    assert!(input.is_empty());
    assert!(fixture.guard.previous().is_none());
}

#[test]
fn an_unresponsive_guard_request_has_a_bounded_deadline() {
    let fixture = Fixture::new();
    let run = Arc::new(fixture.run());
    let mut input = Vec::new();
    assert!(check_guard(&Some(run.clone()), &mut input, Instant::now()));
    assert!(matches!(run.failure(), Some(Fatal::Other(_))));
    assert!(input.is_empty());
}

#[test]
fn wrapped_remote_program_is_hidden_but_connection_errors_are_retained() {
    let fixture = Fixture::new();
    let run = fixture.run();
    assert!(run
        .consume("debug1: Sending command: python3 -u -c 'import base64;")
        .is_none());
    assert!(run.consume("YXBwbGljYXRpb24gc291cmNl").is_none());
    assert!(matches!(
        run.consume("Connection reset by peer"),
        Some(Output::SshLine(_))
    ));
}

#[test]
fn an_already_cancelled_process_never_spawns_a_child() {
    let stop = Arc::new(AtomicBool::new(true));
    let killer = Mutex::new(None);
    assert!(super::run(
        &PathBuf::from("cc-bridge-test-must-not-execute"),
        &[],
        PendingCreds::default(),
        &stop,
        &killer,
        None,
        |_| {}
    )
    .is_none());
    assert!(killer.lock().unwrap().is_none());
}

struct NativeConnection {
    link: super::super::ssh_cmds::SshLink,
    ssh: PathBuf,
    creds: PendingCreds,
    port: u16,
}

impl NativeConnection {
    fn load() -> Self {
        assert_eq!(
            std::env::var("CC_BRIDGE_TUNNEL_LIVE_TEST").as_deref(),
            Ok("1")
        );
        let id = std::env::var("CC_BRIDGE_TUNNEL_TEST_CONNECTION_ID").unwrap();
        let port = std::env::var("CC_BRIDGE_TUNNEL_TEST_PORT")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        assert!(port >= 20000 && port != 7823 && port != 7824);
        let data = PathBuf::from(std::env::var_os("APPDATA").unwrap()).join("com.ccbridge.desktop");
        let db = rusqlite::Connection::open_with_flags(
            data.join("cc-bridge.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let raw: String = db
            .query_row(
                "SELECT value FROM config WHERE key='ssh_connections'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let connections: Vec<crate::config::SshConnection> = serde_json::from_str(&raw).unwrap();
        let connection = connections
            .into_iter()
            .find(|connection| connection.id == id)
            .unwrap();
        // This opt-in fixture is authorized for the diagnosed server, never an arbitrary saved target.
        assert_eq!(connection.host, "10.0.19.194");
        assert_eq!(connection.username, "lizuliang");
        assert!(connection.proxy_jump_id.is_empty());
        let link = super::super::ssh_cmds::SshLink::new(connection, None).unwrap();
        let creds =
            super::super::ssh_cmds::resolve_connect_secrets(&link, &data, None, None).unwrap();
        Self {
            link,
            ssh: super::super::ssh_cmds::find_ssh().unwrap(),
            creds,
            port,
        }
    }

    fn start(&self, guard: Arc<ManagedGuard>) -> NativeSession {
        let attempt = guard.attempt();
        let id = crate::stable_connect::runtime_id(&self.link.conn.id);
        let rules = [crate::config::ForwardRule {
            kind: crate::config::ForwardKind::Remote,
            listen_port: self.port,
            target_port: 7823,
            ..Default::default()
        }];
        let mut args = super::super::ssh_tunnel_cmds::tunnel_args(&self.link, &id, &rules);
        args.push(attempt.command());
        let stop = Arc::new(AtomicBool::new(false));
        let run_guard = Arc::new(GuardRun::serve(guard, attempt, stop.clone()));
        let mut status = crate::ssh_tunnel::TunnelStatus::new(id, &rules);
        status.require_guard();
        let status = Arc::new(Mutex::new(status));
        let output_status = status.clone();
        let (ssh, creds, worker_stop, worker_guard) = (
            self.ssh.clone(),
            self.creds.clone(),
            stop.clone(),
            run_guard.clone(),
        );
        let worker = std::thread::spawn(move || {
            super::run(
                &ssh,
                &args,
                creds,
                &worker_stop,
                &Mutex::new(None),
                Some(worker_guard),
                move |output| {
                    let mut status = output_status.lock().unwrap();
                    match output {
                        Output::SshLine(line) => {
                            status.apply_line(line);
                        }
                        Output::GuardReady => {
                            status.guard_started();
                        }
                    }
                },
            )
        });
        NativeSession {
            stop,
            worker: Some(worker),
            status,
            run_guard,
        }
    }

    fn reclaim(&self, guard: &ManagedGuard) {
        let stop = Arc::new(AtomicBool::new(false));
        assert!(
            super::super::ssh_tunnel_cmds::reclaim_previous(
                guard,
                &self.link,
                &self.ssh,
                self.creds.clone(),
                &stop,
                &Mutex::new(None)
            )
            .is_ok(),
            "Native ownership check did not finish safely"
        );
    }
}

struct NativeSession {
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<Option<Fatal>>>,
    status: Arc<Mutex<crate::ssh_tunnel::TunnelStatus>>,
    run_guard: Arc<GuardRun>,
}

impl NativeSession {
    fn wait_ready(&self) {
        let deadline = Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if self.status.lock().unwrap().state == crate::ssh_tunnel::TunnelState::Up {
                return;
            }
            assert!(
                Instant::now() < deadline && !self.worker.as_ref().unwrap().is_finished(),
                "Native SSH listener and verified guard did not become ready"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    fn stay_alive(&self, seconds: u64) {
        let deadline = Instant::now() + std::time::Duration::from_secs(seconds);
        while Instant::now() < deadline {
            assert!(
                !self.worker.as_ref().unwrap().is_finished(),
                "Native heartbeat stream did not keep the lease alive"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    fn finish(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.finish();
    }
}

#[test]
#[ignore = "Opt-in native SSH test uses the authorized server and an isolated temporary port"]
fn managed_native_live_fixture() {
    let connection = NativeConnection::load();
    let path = std::env::temp_dir().join(format!("cc-bridge-native-guard-{}", Uuid::new_v4()));
    let guard = Arc::new(ManagedGuard::new(
        &path,
        b"native-fixture-server",
        connection.port,
    ));
    let fixture = Fixture {
        path,
        attempt: guard.attempt(),
        guard,
        stop: Arc::new(AtomicBool::new(false)),
    };
    let mut first = connection.start(fixture.guard.clone());
    first.wait_ready();
    let original = fixture
        .guard
        .previous()
        .expect("Native guard did not persist its own receipt");
    first.stay_alive(50);
    assert!(first.run_guard.heartbeat_count.load(Ordering::SeqCst) >= 5);
    first.finish();
    let restarted = Arc::new(ManagedGuard::new(
        &fixture.path,
        b"native-fixture-server",
        connection.port,
    ));
    assert_eq!(restarted.previous(), Some(original.clone()));
    connection.reclaim(&restarted);
    let mut second = connection.start(restarted.clone());
    second.wait_ready();
    let replacement = restarted.previous().unwrap();
    assert_eq!(replacement.port, original.port);
    assert_ne!(replacement.nonce, original.nonce);
    second.finish();
    connection.reclaim(&restarted);
    assert!(restarted.previous().is_none());
    println!(
        "CCB_NATIVE_PROBE={}",
        serde_json::json!({
            "port": connection.port, "nativeReady": true, "aliveAfterSeconds": 50,
            "samePortAfterRestart": true, "receiptCleared": true,
        })
    );
}
