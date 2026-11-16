use super::*;
use crate::config::BridgeConfig;

fn fixture() -> (SshConnection, ManagedForward) {
    let connection = SshConnection {
        id: "server".into(),
        host: "server.test".into(),
        ..Default::default()
    };
    let managed = ManagedForward {
        connection_id: connection.id.clone(),
        rule: crate::stable_connect::rule(7823, &BridgeConfig::default()),
        phase: "ready".into(),
        enabled: true,
        message: None,
    };
    (connection, managed)
}

#[test]
fn legacy_route_is_owned_without_rewriting_its_persisted_rule() {
    let (connection, managed) = fixture();
    let mut legacy = managed.rule.clone();
    legacy.id = "old-manual".into();
    legacy.note = "old note".into();
    let result = context(&connection, &[legacy.clone()], vec![managed]);
    assert!(result.manual_rules.is_empty());
    assert_eq!(result.managed_rule_ids, ["old-manual"]);
    assert!(result.conflicts.is_empty());
    assert_eq!(legacy.note, "old note");
}

#[test]
fn paused_or_reconnecting_tunnel_still_owns_legacy_rules() {
    for phase in ["stopped", "reconnecting", "error", "running"] {
        let (connection, mut managed) = fixture();
        managed.phase = phase.into();
        managed.enabled = false;
        let result = context(&connection, &[managed.rule.clone()], vec![managed]);
        assert!(result.manual_rules.is_empty(), "phase={phase}");
    }
}

#[test]
fn extra_manual_rules_remain_available_and_do_not_change_the_fixed_port() {
    let (connection, managed) = fixture();
    let extra = ForwardRule {
        id: "database".into(),
        kind: ForwardKind::Local,
        listen_port: 15432,
        target_port: 5432,
        ..managed.rule.clone()
    };
    let result = context(
        &connection,
        &[managed.rule.clone(), extra.clone()],
        vec![managed],
    );
    assert_eq!(result.manual_rules.len(), 1);
    assert!(same_route(&result.manual_rules[0], &extra));
    assert_eq!(result.managed[0].rule.listen_port, 7823);
}

#[test]
fn same_port_with_different_target_is_a_conflict_not_a_duplicate() {
    let (connection, managed) = fixture();
    let conflict = ForwardRule {
        id: "other-service".into(),
        target_port: 9000,
        ..managed.rule.clone()
    };
    let result = context(&connection, &[conflict], vec![managed]);
    assert_eq!(result.manual_rules.len(), 1);
    assert!(result.managed_rule_ids.is_empty());
    assert_eq!(result.conflicts[0].rule_id, "other-service");
    assert!(result.conflicts[0].message.contains("7823"));
}

#[test]
fn wildcard_listener_is_a_conflict_and_disabled_rules_do_not_block() {
    let (connection, managed) = fixture();
    let wildcard = ForwardRule {
        listen_host: "0.0.0.0".into(),
        ..managed.rule.clone()
    };
    assert_eq!(
        context(
            &connection,
            std::slice::from_ref(&wildcard),
            vec![managed.clone()],
        )
        .conflicts
        .len(),
        1
    );
    let disabled = ForwardRule {
        enabled: false,
        ..wildcard
    };
    assert!(context(&connection, &[disabled], vec![managed])
        .conflicts
        .is_empty());
}

#[test]
fn local_direction_and_remote_dynamic_port_are_not_claimed() {
    let (connection, managed) = fixture();
    let local = ForwardRule {
        kind: ForwardKind::Local,
        ..managed.rule.clone()
    };
    let allocated = ForwardRule {
        listen_port: 0,
        ..managed.rule.clone()
    };
    let result = context(&connection, &[local, allocated], vec![managed]);
    assert_eq!(result.manual_rules.len(), 2);
    assert!(result.conflicts.is_empty());
}

#[test]
fn ipv6_spellings_match_but_distinct_loopback_bindings_do_not() {
    let (_, managed) = fixture();
    let a = ForwardRule {
        listen_host: "[::1]".into(),
        target_host: "0:0:0:0:0:0:0:1".into(),
        ..managed.rule.clone()
    };
    let b = ForwardRule {
        listen_host: "0:0:0:0:0:0:0:1".into(),
        target_host: "::1".into(),
        ..a.clone()
    };
    assert!(same_route(&a, &b));
    assert!(!listeners_overlap(&a, &managed.rule));
}

#[test]
fn server_aliases_share_ownership_but_other_destinations_and_jumps_do_not() {
    let (connection, _) = fixture();
    let alias = SshConnection {
        id: "alias".into(),
        username: "another-user".into(),
        host: "SERVER.TEST".into(),
        ..connection.clone()
    };
    assert!(same_server(&connection, &alias));
    assert!(!same_server(
        &connection,
        &SshConnection {
            host: "other.test".into(),
            ..alias.clone()
        }
    ));
    assert!(!same_server(
        &connection,
        &SshConnection {
            proxy_jump_id: "other-jump".into(),
            ..alias
        }
    ));
}
