use super::*;
use crate::config::{ForwardKind, ForwardRule};
use crate::ssh_tunnel::{RuleState, TunnelState, TunnelStatus};

fn receipt(attempt: &GuardAttempt) -> GuardReceipt {
    GuardReceipt {
        version: 1,
        owner: attempt.owner.clone(),
        nonce: attempt.nonce.clone(),
        port: attempt.port,
        boot_id: Uuid::new_v4().to_string(),
        uid: 1004,
        pid: 400,
        start_ticks: 500,
        guard_pid: 401,
        guard_start_ticks: 501,
    }
}

struct CacheFixture(PathBuf);

impl CacheFixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("cc-bridge-tunnel-guard-{}", Uuid::new_v4())))
    }
}

impl Drop for CacheFixture {
    fn drop(&mut self) {
        let directory = self.0.join("ssh_tunnel_sessions");
        if let Ok(files) = fs::read_dir(&directory) {
            for file in files.flatten() {
                let _ = fs::remove_file(file.path());
            }
        }
        let _ = fs::remove_dir(directory);
        let _ = fs::remove_dir(&self.0);
    }
}

#[test]
fn stale_attempt_identity_cannot_mark_a_new_tunnel_ready() {
    let cache = CacheFixture::new();
    let guard = ManagedGuard::new(&cache.0, b"fixture-server", 7823);
    let old = guard.attempt();
    let current = guard.attempt();
    assert!(!current.accepts(&receipt(&old)));
    assert!(guard.remember(&current, receipt(&old)).is_err());
    assert!(guard.previous().is_none());
}

#[test]
fn receipts_survive_restart_for_the_same_server_and_port() {
    let cache = CacheFixture::new();
    let guard = ManagedGuard::new(&cache.0, b"fixture-server", 7823);
    let attempt = guard.attempt();
    let expected = receipt(&attempt);
    guard.remember(&attempt, expected.clone()).unwrap();
    let restarted = ManagedGuard::new(&cache.0, b"fixture-server", 7823);
    assert_eq!(restarted.previous(), Some(expected));
    assert!(ManagedGuard::new(&cache.0, b"another-server", 7823)
        .previous()
        .is_none());
    assert!(ManagedGuard::new(&cache.0, b"fixture-server", 7824)
        .previous()
        .is_none());
}

#[test]
fn stale_cleanup_does_not_delete_a_replacement_receipt() {
    let cache = CacheFixture::new();
    let guard = ManagedGuard::new(&cache.0, b"fixture-server", 7823);
    let old = guard.attempt();
    let old_receipt = receipt(&old);
    guard.remember(&old, old_receipt.clone()).unwrap();
    let current = guard.attempt();
    let current_receipt = receipt(&current);
    guard.remember(&current, current_receipt.clone()).unwrap();
    guard.forget(&old_receipt).unwrap();
    assert_eq!(guard.previous(), Some(current_receipt.clone()));
    guard.forget(&current_receipt).unwrap();
    assert!(ManagedGuard::new(&cache.0, b"fixture-server", 7823)
        .previous()
        .is_none());
}

#[test]
fn corrupted_cache_is_never_used_to_reclaim_a_process() {
    let cache = CacheFixture::new();
    let guard = ManagedGuard::new(&cache.0, b"fixture-server", 7823);
    fs::create_dir_all(guard.path.parent().unwrap()).unwrap();
    fs::write(&guard.path, b"{\"pid\":1,\"uid\":0}").unwrap();
    assert!(ManagedGuard::new(&cache.0, b"fixture-server", 7823)
        .previous()
        .is_none());
    fs::write(&guard.path, vec![b'x'; 4097]).unwrap();
    assert!(ManagedGuard::new(&cache.0, b"fixture-server", 7823)
        .previous()
        .is_none());
}

#[test]
fn ready_protocol_preserves_the_recorded_process_identity() {
    let attempt = GuardAttempt {
        owner: Uuid::new_v4().to_string(),
        nonce: Uuid::new_v4().to_string(),
        port: 7823,
    };
    let expected = receipt(&attempt);
    let line = format!(
        "CCB_TUNNEL_GUARD_READY {}\r",
        serde_json::to_string(&expected).unwrap()
    );
    match GuardFrame::parse(&line).unwrap().unwrap() {
        GuardFrame::Ready(actual) => assert_eq!(actual, expected),
        _ => panic!("expected ready identity"),
    }
    assert!(GuardFrame::parse("debug1: Sending command: CCB_TUNNEL_GUARD_READY invalid").is_none());
    assert!(GuardFrame::parse("CCB_TUNNEL_GUARD_READY invalid")
        .unwrap()
        .is_err());
}

#[test]
fn only_the_expected_owner_and_port_can_be_registered() {
    let attempt = GuardAttempt {
        owner: Uuid::new_v4().to_string(),
        nonce: Uuid::new_v4().to_string(),
        port: 7823,
    };
    let mut wrong = receipt(&attempt);
    wrong.owner = Uuid::new_v4().to_string();
    assert!(!attempt.accepts(&wrong));
    wrong = receipt(&attempt);
    wrong.port = 7824;
    assert!(!attempt.accepts(&wrong));
    wrong = receipt(&attempt);
    wrong.pid = 1;
    assert!(!attempt.accepts(&wrong));
}

fn guarded_status() -> TunnelStatus {
    let mut status = TunnelStatus::new(
        "stable:fixture".into(),
        &[ForwardRule {
            kind: ForwardKind::Remote,
            listen_port: 7823,
            target_port: 7823,
            ..Default::default()
        }],
    );
    status.require_guard();
    status
}

#[test]
fn managed_authentication_and_listener_wait_for_verified_guard_readiness() {
    let mut status = guarded_status();
    status.apply_line("Authenticated to fixture ([127.0.0.1]:22) using password.");
    assert_eq!(status.state, TunnelState::Connecting);
    status.apply_line(
        "debug1: remote forward success for: listen 127.0.0.1:7823, connect 127.0.0.1:7823",
    );
    assert_eq!(status.rules[0].state, RuleState::Listening);
    assert_eq!(status.state, TunnelState::Connecting);
    assert!(status.guard_started());
    assert_eq!(status.state, TunnelState::Up);
}

#[test]
fn guard_readiness_does_not_hide_a_failed_listener() {
    let mut status = guarded_status();
    status.apply_line("Authenticated to fixture ([127.0.0.1]:22) using password.");
    status.guard_started();
    status.apply_line("Error: remote port forwarding failed for listen port 7823");
    assert_eq!(status.rules[0].state, RuleState::Failed);
    assert_ne!(status.state, TunnelState::Up);
}

#[test]
fn reconnect_requires_a_fresh_guard_registration() {
    let mut status = guarded_status();
    status.apply_line("Authenticated to fixture ([127.0.0.1]:22) using password.");
    status.apply_line(
        "debug1: remote forward success for: listen 127.0.0.1:7823, connect 127.0.0.1:7823",
    );
    status.guard_started();
    assert_eq!(status.state, TunnelState::Up);
    status.begin_attempt();
    status.apply_line("Authenticated to fixture ([127.0.0.1]:22) using password.");
    status.apply_line(
        "debug1: remote forward success for: listen 127.0.0.1:7823, connect 127.0.0.1:7823",
    );
    assert_eq!(status.state, TunnelState::Connecting);
    assert!(!status.guard_is_ready());
}

#[test]
fn manual_forwarding_keeps_its_existing_authentication_state() {
    let mut status = TunnelStatus::new("manual-fixture".into(), &[]);
    status.apply_line("Authenticated to fixture ([127.0.0.1]:22) using password.");
    assert_eq!(status.state, TunnelState::Up);
}

#[test]
fn guard_commands_are_bounded_and_carry_payload_without_shell_interpolation() {
    let attempt = GuardAttempt {
        owner: Uuid::new_v4().to_string(),
        nonce: Uuid::new_v4().to_string(),
        port: 7823,
    };
    for command in [attempt.command(), reclaim_command(&receipt(&attempt)).0] {
        assert!(
            command.len() < 24 * 1024,
            "must fit Windows process arguments"
        );
        let args = shell_words::split(&command).unwrap();
        assert_eq!(&args[..3], ["python3", "-u", "-c"]);
        let payload = base64::engine::general_purpose::STANDARD
            .decode(args.last().unwrap())
            .unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&payload).is_ok());
        assert!(!command.contains('`'));
        assert!(!command.contains("$("));
    }
}
