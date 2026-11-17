use super::*;
use crate::config::SshConnection;
use crate::stable_connect::{StableSaved, StableSettings};

fn fixture() -> (BridgeConfig, StableRecord, Vec<String>) {
    let mut config = BridgeConfig {
        token: "fixture-token".into(),
        host: "0.0.0.0".into(),
        port: 7823,
        scope: Some("project".into()),
        project_path: Some("/srv/orders".into()),
        last_selected_ip: Some("10.0.0.2".into()),
        ssh_connections: vec![SshConnection {
            id: "server".into(),
            name: "云服务器".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    config.stable_connect = StableSettings {
        method: Some("stable".into()),
        selected_connection_id: Some("server".into()),
        ..Default::default()
    };
    let record = StableRecord {
        connection_id: "server".into(),
        port: 17823,
        scope: "project".into(),
        project_path: "/srv/orders".into(),
        multi_device: false,
        configured: true,
        enabled: true,
        phase: "ready".into(),
        step: 4,
        message: None,
        needs_secret: false,
        config_matches: true,
        target: None,
        verified_at: Some(1000),
    };
    (
        config,
        record,
        vec!["10.0.0.2".into(), "192.168.1.8".into()],
    )
}

#[test]
fn unconfigured_tunnel_never_falls_back_to_direct_commands_or_address() {
    let (config, _, ips) = fixture();
    let access = summary(&config, &[], &ips, true, Some(true), None, false);
    assert_eq!(access.state, "setup");
    assert_eq!(access.address, "");
    assert!(!access.can_copy_address && !access.can_copy_command && !access.can_update_ip);
    assert!(connect_command(&config, &ips).is_err());
    assert!(ip_update_command(&config, &ips).is_err());
}

#[test]
fn vpn_recovery_keeps_endpoint_even_when_direct_ip_has_disappeared() {
    let (config, mut record, _) = fixture();
    record.phase = "reconnecting".into();
    let access = summary(
        &config,
        &[record],
        &["10.9.0.7".into()],
        true,
        Some(false),
        None,
        true,
    );
    assert_eq!(access.state, "recovery");
    assert_eq!(access.address, "http://127.0.0.1:17823/mcp");
    assert!(access.can_copy_address);
    assert!(!access.can_update_ip);
    assert!(access.title.contains("固定地址不变"));
    assert_eq!(config.last_selected_ip.as_deref(), Some("10.0.0.2"));
}

#[test]
fn channel_and_configuration_do_not_prove_the_current_client_has_connected() {
    let (config, record, ips) = fixture();
    let access = summary(&config, &[record], &ips, true, Some(true), None, false);
    assert!(access.channel_ready);
    assert_eq!(access.state, "waiting");
    assert!(access.title.contains("等待 Claude Code"));
}

#[test]
fn tunnel_traffic_only_counts_after_the_config_was_written() {
    let (config, record, ips) = fixture();
    // 记录的写入时刻是 1000；早于它的请求只能说明改配置之前客户端就挂着，不算证据。
    let before = summary_with_client(
        &config,
        std::slice::from_ref(&record),
        &ips,
        true,
        Some(true),
        None,
        false,
        Some(999),
    );
    assert_eq!(before.client_verified_at, None);
    assert_eq!(before.state, "waiting");
    assert!(
        before.title.contains("等待 Claude Code"),
        "{}",
        before.title
    );

    let after = summary_with_client(
        &config,
        &[record],
        &ips,
        true,
        Some(true),
        None,
        false,
        Some(1200),
    );
    assert_eq!(after.client_verified_at, Some(1200));
    assert_eq!(after.title, "隧道连接已生效");
    assert_eq!(after.short, "接入已验证");
    // 状态机语义不动：别的分支（重连/待更新）还靠 state 走，只有文案换掉。
    assert_eq!(after.state, "waiting");
}

#[test]
fn traffic_does_not_count_while_the_server_entry_still_points_elsewhere() {
    let (config, mut record, ips) = fixture();
    record.target = Some(crate::stable_discovery::StableTarget {
        id: "entry".into(),
        name: "cc-bridge".into(),
        scope: "project".into(),
        project_path: "/srv/orders".into(),
        project_key: None,
        config_file: "/srv/orders/.mcp.json".into(),
        url: "http://10.0.0.2:17823/mcp".into(),
        fingerprint: "fp".into(),
        recognized: true,
        token_matches: true,
    });
    // 服务器接入还指向直连地址时，进门的流量来自旧连接，不能算「隧道已验证」。
    let access = summary_with_client(
        &config,
        &[record],
        &ips,
        true,
        Some(true),
        None,
        false,
        Some(1200),
    );
    assert_eq!(access.client_verified_at, None);
    assert_eq!(access.state, "changed");
}

#[test]
fn direct_mode_never_claims_tunnel_verification() {
    let (mut config, _, ips) = fixture();
    config.stable_connect.method = Some("direct".into());
    let access = summary_with_client(
        &config,
        &[],
        &ips,
        true,
        Some(true),
        None,
        false,
        Some(1200),
    );
    assert_eq!(access.client_verified_at, None);
}

#[test]
fn login_pause_changed_config_and_service_stop_have_different_recovery_actions() {
    let (config, record, ips) = fixture();
    for (phase, needs_secret, matches, state) in [
        ("error", true, true, "login"),
        ("stopped", false, true, "paused"),
        ("ready", false, false, "changed"),
        ("running", false, false, "applying"),
    ] {
        let mut r = record.clone();
        r.phase = phase.into();
        r.needs_secret = needs_secret;
        r.config_matches = matches;
        assert_eq!(
            summary(&config, &[r], &ips, true, None, None, false).state,
            state
        );
    }
    assert_eq!(
        summary(
            &config,
            std::slice::from_ref(&record),
            &ips,
            false,
            None,
            None,
            false
        )
        .state,
        "service-stopped"
    );
    assert_eq!(
        summary(
            &config,
            &[record],
            &ips,
            false,
            None,
            Some("occupied"),
            false
        )
        .state,
        "service-error"
    );
}

#[test]
fn direct_copy_preserves_project_scope_path_https_custom_port_and_sse() {
    let (mut config, _, ips) = fixture();
    config.stable_connect.method = Some("direct".into());
    config.project_path = Some("~/orders with spaces/$(literal)".into());
    config.port = 9123;
    config.remote_tls_enabled = true;
    config.transport = "sse".into();
    let command = connect_command(&config, &ips).unwrap();
    assert!(command.starts_with(
        "cd \"$HOME/orders with spaces/\\$(literal)\" && claude mcp add --scope project"
    ));
    assert!(
        command.contains("--transport sse") && command.contains("https://10.0.0.2:9123/mcp/sse")
    );
}

#[test]
fn tunnel_copy_preserves_confirmed_name_and_location_and_refuses_stale_token() {
    let (mut config, _, ips) = fixture();
    config.stable_connect.connections.push(StableSaved {
        connection_id: "server".into(),
        port: 17823,
        scope: "project".into(),
        project_path: "/srv/orders".into(),
        multi_device: false,
        enabled: true,
        fingerprint: stable::fingerprint(&config, "server"),
        token_fingerprint: token_fingerprint(&config),
        target: None,
        verified_at: None,
    });
    assert!(connect_command(&config, &ips)
        .unwrap()
        .contains("http://127.0.0.1:17823/mcp"));
    config.token = "changed-token".into();
    assert!(connect_command(&config, &ips).is_err());
}

#[test]
fn original_update_location_is_independent_of_the_new_scope_draft() {
    let (mut config, _, ips) = fixture();
    config.stable_connect.method = Some("direct".into());
    config.stable_connect.direct = Some(direct_access(&config, &ips));
    config.scope = Some("user".into());
    config.project_path = None;
    let access = summary(&config, &[], &ips, true, Some(true), None, false);
    assert_eq!(access.scope, "user");
    assert_eq!(access.source_scope, "project");
    assert_eq!(access.source_project_path, "/srv/orders");
    assert!(access
        .update_command
        .starts_with("cd \"/srv/orders\" && python3"));
    assert_eq!(access.state, "changed");
    assert!(!access.token_update_pending);
}

#[test]
fn selected_tool_controls_method_without_deleting_saved_tunnels() {
    let (mut config, _, ips) = fixture();
    config.connect_client = Some("codex".into());
    let access = summary(&config, &[], &ips, true, Some(true), None, false);
    assert_eq!(access.method, "direct");
    assert!(connect_command(&config, &ips)
        .unwrap()
        .contains("[mcp_servers.cc-bridge]"));
}

#[test]
fn workbuddy_copy_is_pasteable_json() {
    let (mut config, _, ips) = fixture();
    config.connect_client = Some("workbuddy".into());
    let text = connect_command(&config, &ips).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        parsed["mcpServers"]["cc-bridge"]["url"],
        "http://10.0.0.2:7823/mcp"
    );
}

#[test]
fn direct_local_binding_and_firewall_are_not_remote_verification() {
    let (mut config, _, ips) = fixture();
    config.stable_connect.method = Some("direct".into());
    for (probe, blocked, ready, state) in [
        (None, false, false, "waiting"),
        (Some(true), false, true, "waiting"),
        (Some(false), false, false, "direct-unreachable"),
        (Some(true), true, false, "direct-blocked"),
    ] {
        let access = summary(&config, &[], &ips, true, probe, None, blocked);
        assert_eq!(access.channel_ready, ready);
        assert_eq!(access.state, state);
        assert!(!access.configuration_verified && access.verified_at.is_none());
    }
}

#[test]
fn token_rotation_marks_original_direct_location_for_update() {
    let (mut config, _, ips) = fixture();
    config.stable_connect.method = Some("direct".into());
    config.stable_connect.direct = Some(direct_access(&config, &ips));
    config.scope = Some("user".into());
    config.project_path = None;
    config.token = "new-token".into();
    let access = summary(&config, &[], &ips, true, Some(true), None, false);
    assert!(access.token_update_pending);
    assert_eq!(access.source_scope, "project");
    assert_eq!(access.source_project_path, "/srv/orders");
    assert!(access.update_command.contains("new-token"));
    assert!(access.update_command.starts_with("cd \"/srv/orders\" &&"));
}

#[test]
fn successive_direct_updates_keep_issued_addresses_until_the_user_confirms() {
    let (mut config, _, ips) = fixture();
    config.stable_connect.method = Some("direct".into());
    let original = direct_access(&config, &ips);
    config.stable_connect.direct = Some(original.clone());
    let second = vec!["10.0.0.3".into()];
    let next = direct_access(&config, &second);
    config.stable_connect.direct =
        update_direct_receipt(&config, &second, &next.fingerprint, false).unwrap();
    let pending = config.stable_connect.direct.as_ref().unwrap();
    assert_eq!(pending.address, original.address);
    assert_eq!(
        pending.issued_addresses.as_slice(),
        std::slice::from_ref(&next.address)
    );
    let third = vec!["10.0.0.4".into()];
    let final_target = direct_access(&config, &third);
    let command = ip_update_command(&config, &third).unwrap().0;
    assert!(command.contains(&next.address) && command.contains(&final_target.address));
    assert!(update_direct_receipt(&config, &third, &next.fingerprint, true).is_err());
    config.stable_connect.direct =
        update_direct_receipt(&config, &third, &final_target.fingerprint, true).unwrap();
    let access = summary(&config, &[], &third, true, Some(true), None, false);
    assert!(access.config_matches);
    assert!(!access.can_confirm_update && access.previous_address.is_none());
    assert!(config
        .stable_connect
        .direct
        .unwrap()
        .issued_addresses
        .is_empty());
}

#[test]
fn confirming_direct_update_keeps_original_entry_location() {
    let (mut config, _, ips) = fixture();
    config.stable_connect.method = Some("direct".into());
    config.stable_connect.direct = Some(direct_access(&config, &ips));
    config.scope = Some("user".into());
    config.project_path = None;
    config.token = "rotated".into();
    let next = direct_access(&config, &ips);
    config.stable_connect.direct =
        update_direct_receipt(&config, &ips, &next.fingerprint, true).unwrap();
    let access = summary(&config, &[], &ips, true, Some(true), None, false);
    assert_eq!(access.source_project_path, "/srv/orders");
    assert_eq!(access.source_scope, "project");
    assert!(!access.token_update_pending && !access.config_matches);
}

fn entry(url: &str, token_matches: bool) -> crate::stable_discovery::StableTarget {
    crate::stable_discovery::StableTarget {
        id: "entry".into(),
        name: "cc-bridge".into(),
        scope: "project".into(),
        project_path: "/srv/orders".into(),
        project_key: None,
        config_file: "/srv/orders/.mcp.json".into(),
        url: url.into(),
        fingerprint: "a".repeat(64),
        recognized: true,
        token_matches,
    }
}

#[test]
fn target_pointing_at_the_direct_address_is_not_reported_as_connected() {
    let (config, mut record, ips) = fixture();
    record.target = Some(entry("http://10.0.0.2:7823/mcp", true));
    let access = summary(&config, &[record], &ips, true, Some(true), None, false);
    assert!(access.channel_ready);
    assert_eq!(access.state, "changed");
    assert_eq!(access.short, "接入待更新");
    assert!(!access.configuration_verified);
    // 链路中间段不能一边说「已连通」一边让下面写「接入仍是旧地址」。
    assert_eq!(access.channel_detail, "已连通 · 接入未指向");
    assert_eq!(
        access.previous_address.as_deref(),
        Some("http://10.0.0.2:7823/mcp")
    );
}

#[test]
fn only_a_target_on_the_fixed_address_counts_as_verified() {
    let (config, mut record, ips) = fixture();
    record.target = Some(entry("http://127.0.0.1:17823/mcp", true));
    let access = summary(
        &config,
        &[record.clone()],
        &ips,
        true,
        Some(true),
        None,
        false,
    );
    assert_eq!(access.state, "waiting");
    assert!(access.configuration_verified);
    assert_eq!(access.title, "隧道已连通，等待 Claude Code");

    // Token 轮换也会让原条目失效，不能因为 URL 对得上就报已核实。
    record.target = Some(entry("http://127.0.0.1:17823/mcp", false));
    let access = summary(&config, &[record], &ips, true, Some(true), None, false);
    assert!(!access.configuration_verified);
    assert_eq!(access.state, "changed");
}

#[test]
fn real_direct_update_preserves_unrelated_entries_and_refuses_concurrent_edits() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/stable_remote/direct_update_tests.py");
    let python = if cfg!(windows) { "python" } else { "python3" };
    let result = std::process::Command::new(python)
        .arg(script)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("DIRECT_UPDATE_OK"));
}
