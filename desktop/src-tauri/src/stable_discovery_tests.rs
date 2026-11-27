use super::*;

#[test]
fn python_fixtures_cover_existing_targets_new_projects_and_stale_receipts() {
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/stable_remote/tests.py");
    let python = if cfg!(windows) { "python" } else { "python3" };
    let result = std::process::Command::new(python)
        .arg(fixture)
        .output()
        .expect("Python 3 is required to verify the remote discovery and upgrade fixtures");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("FIXTURE_OK"));
}

#[test]
fn python_scope_fixtures_cover_migration_collisions_and_safe_rollback() {
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/stable_remote/scope_tests.py");
    let python = if cfg!(windows) { "python" } else { "python3" };
    let result = std::process::Command::new(python)
        .arg(fixture)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("SCOPE_FIXTURE_OK"));
}

#[test]
fn scope_migration_requires_an_explicit_source_and_inspected_destination() {
    let config = BridgeConfig::default();
    let mut access = StableAccessRequest {
        scope_change: false,
        tunnel_port: None,
        target: Some(StableTarget {
            id: "project-entry".into(),
            name: "custom-bridge".into(),
            scope: "project".into(),
            project_path: "/work".into(),
            project_key: None,
            config_file: "/work/.mcp.json".into(),
            url: "http://127.0.0.1:43127/mcp".into(),
            fingerprint: "a".repeat(64),
            recognized: false,
            token_matches: true,
        }),
        inspection: StableInspection {
            signature: fingerprint(&config, "server"),
            complete: true,
            files: vec![
                ConfigProof {
                    scope: "project".into(),
                    project_path: "/work".into(),
                    config_file: "/work/.mcp.json".into(),
                    fingerprint: "a".repeat(64),
                },
                ConfigProof {
                    scope: "user".into(),
                    project_path: "".into(),
                    config_file: "/home/user/.claude.json".into(),
                    fingerprint: "missing".into(),
                },
            ],
        },
    };
    assert!(validate_access(&config, "server", "project", "/work", &access).is_ok());
    assert!(validate_access(&config, "server", "user", "", &access).is_err());
    access.scope_change = true;
    assert!(validate_access(&config, "server", "user", "", &access).is_ok());
    assert!(validate_access(&config, "server", "project", "/work", &access).is_err());
    assert!(validate_access(&config, "server", "project", "/other", &access).is_err());
    access.inspection.files.pop();
    assert!(validate_access(&config, "server", "user", "", &access).is_err());
    access.target = None;
    assert!(validate_access(&config, "server", "project", "/work", &access).is_err());
}

#[test]
fn older_upgrade_receipts_do_not_enable_migration() {
    let access: StableAccessRequest = serde_json::from_str(
        r#"{"target":null,"inspection":{"signature":"old","complete":true,"files":[]}}"#,
    )
    .unwrap();
    assert!(!access.scope_change);
}

#[test]
fn scope_conflicts_and_partial_migrations_reach_the_ui_without_secrets() {
    let mut input = crate::stable_connect::SetupInput::new("{}".into());
    input.push("CCB_INPUT_READY\n");
    // 每个标记都要同时满足两件事：能穿过输入过滤、有对应的人类可读文案。
    for (marker, expected) in [
        ("CCB_SCOPE_CONFLICT", "全局配置"),
        ("CCB_SCOPE_PROJECT_CONFLICT", "目标项目已有同名"),
        ("CCB_SCOPE_LEGACY", "projects 段"),
        ("CCB_SCOPE_PARTIAL", "未完整完成"),
    ] {
        assert_eq!(input.push(&format!("{marker}\n")).1, format!("{marker}\n"));
        let message = crate::stable_connect::friendly_error(
            &format!("{marker} hidden-token"),
            "hidden-token",
        );
        assert!(!message.contains("hidden-token"));
        assert!(message.contains(expected), "{marker}: {message}");
    }
}

#[test]
fn inspection_script_keeps_paths_and_secrets_out_of_process_arguments() {
    let config = BridgeConfig {
        token: "secret-$(echo bad)".into(),
        ..Default::default()
    };
    let path = "/home/user/project'$(touch bad)";
    let script = read_script(
        &config,
        "server",
        Some(path),
        false,
        Some("/work/original"),
        false,
    );
    assert!(!script.0.contains(&config.token));
    assert!(!script.0.contains(path));
    let payload: serde_json::Value = serde_json::from_str(&script.1).unwrap();
    assert_eq!(payload["path"], path);
    assert_eq!(payload["token"], config.token);
    assert_eq!(payload["sourceProjectPath"], "/work/original");
}

#[test]
fn incomplete_results_and_wrong_server_receipts_cannot_configure() {
    let config = BridgeConfig::default();
    let mut access = StableAccessRequest {
        target: None,
        scope_change: false,
        tunnel_port: None,
        inspection: StableInspection {
            signature: fingerprint(&config, "server"),
            complete: false,
            files: vec![ConfigProof {
                scope: "user".into(),
                project_path: "".into(),
                config_file: "/home/user/.claude.json".into(),
                fingerprint: "missing".into(),
            }],
        },
    };
    assert!(validate_access(&config, "server", "user", "", &access).is_err());
    access.inspection.complete = true;
    assert!(validate_access(&config, "server", "user", "", &access).is_ok());
    access.inspection.signature = "old-server".into();
    assert!(validate_access(&config, "server", "user", "", &access).is_err());
}

#[test]
fn protocol_parser_requires_success_and_complete_bounded_frames() {
    let encoded = base64::engine::general_purpose::STANDARD
        .encode(b"{\"name\":\"project\",\"path\":\"/work\"}");
    let output = format!("CCB_DATA {encoded}\nCCB_LISTED\n");
    let parsed: RemoteProject = parse_result(&output, "CCB_LISTED").unwrap();
    assert_eq!(parsed.path, "/work");
    assert!(parse_result::<RemoteProject>(&output, "CCB_DISCOVERED").is_err());
    assert!(
        parse_result::<RemoteProject>(&format!("{output}CCB_RESULT_OVERFLOW\n"), "CCB_LISTED")
            .is_err()
    );
}

#[test]
fn old_saved_records_load_without_target_metadata() {
    let saved: crate::stable_connect::StableSaved = serde_json::from_str(r#"{"connectionId":"cloud","port":17823,"scope":"project","projectPath":"/work","multiDevice":false,"enabled":true,"fingerprint":"old"}"#).unwrap();
    assert!(saved.target.is_none());
    assert_eq!(saved.port, 17823);
}

#[test]
fn framed_input_survives_long_unicode_receipts_without_exposing_secrets() {
    let payload =
        serde_json::json!({"token":"fixture-secret", "path":"项目目录/".repeat(600)}).to_string();
    let mut input = crate::stable_connect::SetupInput::new(payload.clone());
    assert!(input.push("CCB_DATA e30=\n").1.is_empty());
    let sent = input.push("CCB_INPUT_READY\n").0.unwrap();
    assert!(sent.lines().all(|line| line.len() < 80));
    let data: String = sent
        .lines()
        .filter_map(|line| line.strip_prefix("CCB_PAYLOAD "))
        .collect();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data)
        .unwrap();
    assert_eq!(String::from_utf8(decoded).unwrap(), payload);
    assert!(input.push(&sent).1.is_empty());
    let output = input
        .push(
            &"CCB_DATA AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"
                .repeat(1000),
        )
        .1;
    assert!(output.contains("CCB_RESULT_OVERFLOW"));
    assert!(output.len() <= 48 * 1024 + 32);
    assert!(input.push("CCB_CONFIGURED\n").1.is_empty());
}
