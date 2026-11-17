//! Stable Claude access: persistent endpoint and pure command/configuration rules.
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::config::{BridgeConfig, ForwardKind, ForwardRule};
use crate::stable_discovery::{StableAccessRequest, StableTarget};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StableSettings {
    pub method: Option<String>,
    pub selected_connection_id: Option<String>,
    pub connections: Vec<StableSaved>,
    pub direct: Option<crate::connection_access::DirectAccess>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StableSaved {
    pub connection_id: String,
    pub port: u16,
    pub scope: String,
    pub project_path: String,
    pub multi_device: bool,
    pub enabled: bool,
    pub fingerprint: String,
    #[serde(default)]
    pub token_fingerprint: String,
    #[serde(default)]
    pub target: Option<StableTarget>,
    #[serde(default)]
    pub verified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StableRecord {
    pub connection_id: String,
    pub port: u16,
    pub scope: String,
    pub project_path: String,
    pub multi_device: bool,
    pub configured: bool,
    pub enabled: bool,
    pub phase: String,
    pub step: u8,
    pub message: Option<String>,
    pub needs_secret: bool,
    pub config_matches: bool,
    pub target: Option<StableTarget>,
    pub verified_at: Option<u64>,
}

pub struct StableOperation {
    pub cancel: Arc<AtomicBool>,
    pub active: AtomicBool,
    pub record: Mutex<StableRecord>,
    pub access: Option<StableAccessRequest>,
}

pub fn runtime_id(id: &str) -> String {
    format!("stable:{id}")
}

pub fn method(config: &BridgeConfig) -> String {
    config.stable_connect.method.clone().unwrap_or_else(|| {
        if config.has_onboarded {
            "direct"
        } else {
            "stable"
        }
        .into()
    })
}

pub fn selected_saved(config: &BridgeConfig) -> Option<&StableSaved> {
    if method(config) != "stable"
        || config.connect_client.as_deref().unwrap_or("claude-code") != "claude-code"
    {
        return None;
    }
    config
        .stable_connect
        .connections
        .iter()
        .find(|c| Some(&c.connection_id) == config.stable_connect.selected_connection_id.as_ref())
}

pub fn fingerprint(config: &BridgeConfig, id: &str) -> String {
    let connection = config.ssh_connections.iter().find(|c| c.id == id);
    let jump = connection.and_then(|c| {
        config
            .ssh_connections
            .iter()
            .find(|j| j.id == c.proxy_jump_id)
    });
    let identity = |c: &crate::config::SshConnection| {
        (
            c.host.clone(),
            c.port,
            c.username.clone(),
            c.proxy_jump_id.clone(),
            c.auth_type.clone(),
            c.key_path.clone(),
        )
    };
    let data = serde_json::json!([
        config.token,
        config.host,
        config.port,
        config.transport,
        config.remote_tls_enabled,
        connection.map(identity),
        jump.map(identity),
        config.device_id
    ]);
    format!("{:x}", Sha256::digest(data.to_string().as_bytes()))
}

pub fn local_target(config: &BridgeConfig) -> String {
    match config.host.as_str() {
        "0.0.0.0" => "127.0.0.1".into(),
        "::" | "[::]" => "::1".into(),
        value => value.trim_matches(['[', ']']).into(),
    }
}

pub fn rule(port: u16, config: &BridgeConfig) -> ForwardRule {
    ForwardRule {
        id: "cc-bridge-stable".into(),
        enabled: true,
        kind: ForwardKind::Remote,
        listen_host: "127.0.0.1".into(),
        listen_port: port,
        target_host: local_target(config),
        target_port: config.port,
        note: "Claude Code 隧道连接".into(),
    }
}

pub fn validate_setup(scope: &str, path: &str, multi: bool) -> Result<(), String> {
    if !["user", "project"].contains(&scope) {
        return Err("接入范围必须是全局或项目级".into());
    }
    if multi && scope != "user" {
        return Err("多设备接入需要使用全局模式".into());
    }
    if scope == "project" && path.trim().is_empty() {
        return Err("请填写服务器项目路径".into());
    }
    if path.len() > 4096 || path.contains(['\0', '\r', '\n']) {
        return Err("项目路径无效".into());
    }
    Ok(())
}

/// 一个已确认的地址不能被 VPN 重连悄悄换掉；尚未确认时才允许挑新端口。
///
/// `allocated` 是检查阶段服务器按账号分配好的端口（共享服务器上每人一个）。
/// 它排在最前，因为历史候选（7823 / 17823 …）是「谁先连谁占」的旧逻辑产物，
/// 同一台机器上第 5 个人开始就没有可用的号了。
pub fn candidate_ports(saved: Option<u16>, allocated: Option<u16>, preferred: u16) -> Vec<u16> {
    if let Some(port) = saved {
        return vec![port];
    }
    let mut ports = Vec::new();
    if let Some(port) = allocated.filter(|port| *port >= 1024) {
        ports.push(port);
    }
    for port in [preferred.max(1024), 17823, 27823, 37823] {
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    ports
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub fn manual_command(config: &BridgeConfig, saved: &StableSaved) -> String {
    let name = if let Some(target) = &saved.target {
        target.name.clone()
    } else if saved.multi_device {
        format!("cc-bridge-{}", config.device_id)
    } else {
        "cc-bridge".into()
    };
    let url = format!(
        "{}://127.0.0.1:{}{}",
        if config.remote_tls_enabled {
            "https"
        } else {
            "http"
        },
        saved.port,
        if config.transport == "sse" {
            "/mcp/sse"
        } else {
            "/mcp"
        }
    );
    let command = format!(
        "claude mcp add --scope {} --transport {} {} {} --header {}",
        saved
            .target
            .as_ref()
            .map_or(saved.scope.as_str(), |t| t.scope.as_str()),
        config.transport,
        shell_quote(&name),
        shell_quote(&url),
        shell_quote(&format!("Authorization: Bearer {}", config.token))
    );
    if saved.scope == "project" {
        let path = match saved.project_path.strip_prefix("~/") {
            Some(rest) => format!("\"$HOME\"/{}", shell_quote(rest)),
            None if saved.project_path == "~" => "\"$HOME\"".into(),
            None => shell_quote(&saved.project_path),
        };
        format!("cd {path} && {command}")
    } else {
        command
    }
}

pub fn remote_script(
    config: &BridgeConfig,
    port: u16,
    scope: &str,
    path: &str,
    multi: bool,
    access: Option<&StableAccessRequest>,
    verification: (bool, Option<&StableTarget>),
) -> (String, String) {
    let payload = serde_json::json!({"port":port,"scope":scope,"path":path,"token":config.token,"transport":config.transport,
        "name":if multi {format!("cc-bridge-{}",config.device_id)}else{"cc-bridge".into()},
        "access":access,"verifyOnly":verification.0,"verifyTarget":verification.1,"deviceId":config.device_id,"ports":[config.port,port]});
    (format!("PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$PATH\"; export PATH; command -v claude >/dev/null 2>&1 || {{ echo CCB_CLAUDE_MISSING; exit 41; }}; command -v python3 >/dev/null 2>&1 || {{ echo CCB_PYTHON_MISSING; exit 42; }}; python3 -c {}", shell_quote(REMOTE_CONFIGURE)),payload.to_string())
}

/// 远端只允许回这些帧标记。输入过滤与错误文案映射共用同一份清单，
/// 否则新增一个错误标记时，运行期会把它丢掉、只留下一句无信息量的通用提示。
const PROTOCOL_MARKERS: &[&str] = &[
    "CCB_CONFIGURED",
    "CCB_VERIFIED",
    "CCB_DISCOVERED",
    "CCB_LISTED",
    "CCB_CLAUDE_MISSING",
    "CCB_PYTHON_MISSING",
    "CCB_VERIFY_FAILED",
    "CCB_PROJECT_MISSING",
    "CCB_CONFIG_DIRECTORY_MISSING",
    "CCB_CONFIG_SYMLINK",
    "CCB_CONFIG_BUSY",
    "CCB_CONFIG_FAILED",
    "CCB_CONFIG_READ_FAILED",
    "CCB_CONFIG_TOO_LARGE",
    "CCB_FOLDER_READ_FAILED",
    "CCB_ENTRY_UNSUPPORTED",
    "CCB_TARGET_CHANGED",
    "CCB_TARGET_REQUIRED",
    "CCB_SCOPE_CONFLICT",
    "CCB_SCOPE_PARTIAL",
    "CCB_INSPECTION_REQUIRED",
    "CCB_RESULT_OVERFLOW",
];

pub fn is_protocol_marker(line: &str) -> bool {
    PROTOCOL_MARKERS.contains(&line)
}

/// 远端没回预期标记时优先返回它能给出的具体原因。
/// 只有确实一个标记都没收到，才退回通用提示。
pub fn setup_error(output: &str, marker: &str) -> Option<String> {
    if output.lines().any(|line| line.trim() == marker) {
        return None;
    }
    Some(
        output
            .lines()
            .map(str::trim)
            .find(|line| is_protocol_marker(line))
            .map_or_else(
                || "远程配置没有返回确认结果，请重新检测".to_string(),
                str::to_string,
            ),
    )
}

/// PTY echo can include typed input. Retain only protocol markers, never echoed JSON or arbitrary remote output.
pub(crate) struct SetupInput {
    payload: Option<String>,
    line: String,
    line_overflow: bool,
    captured: usize,
}
impl SetupInput {
    pub fn new(payload: String) -> Self {
        Self {
            payload: Some(payload),
            line: String::new(),
            line_overflow: false,
            captured: 0,
        }
    }
    pub fn waiting(&self) -> bool {
        self.payload.is_some()
    }
    fn take_payload(&mut self) -> Option<String> {
        self.payload.take().map(|payload| {
            let encoded = base64::engine::general_purpose::STANDARD.encode(payload);
            let mut framed = String::new();
            for chunk in encoded.as_bytes().chunks(64) {
                framed.push_str("CCB_PAYLOAD ");
                framed.push_str(std::str::from_utf8(chunk).expect("base64 is ASCII"));
                framed.push('\n');
            }
            framed.push_str("CCB_PAYLOAD_END");
            framed
        })
    }
    pub fn push(&mut self, chunk: &str) -> (Option<String>, String) {
        let mut send = None;
        let mut output = String::new();
        for ch in chunk.chars() {
            if ch == '\n' {
                let line = self.line.trim();
                if self.line_overflow {
                    self.line_overflow = false;
                    self.line.clear();
                    continue;
                }
                if line == "CCB_INPUT_READY" {
                    send = self.take_payload();
                } else if is_protocol_marker(line)
                    || (!self.waiting()
                        && line.strip_prefix("CCB_DATA ").is_some_and(|data| {
                            !data.is_empty()
                                && data.len() <= 64
                                && data
                                    .bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
                        }))
                {
                    if self.captured + line.len() < 48 * 1024 {
                        output.push_str(line);
                        output.push('\n');
                        self.captured += line.len() + 1;
                    } else if self.captured <= 48 * 1024 {
                        output.push_str("CCB_RESULT_OVERFLOW\n");
                        self.captured = 48 * 1024 + 1;
                    }
                }
                self.line.clear();
            } else if self.line.len() < 8192 {
                self.line.push(ch);
            } else {
                self.line_overflow = true;
            }
        }
        // A ready prompt waits for stdin; Windows can render its trailing newline as cursor movement.
        if self.waiting() && !self.line_overflow && self.line.trim() == "CCB_INPUT_READY" {
            send = self.take_payload();
            self.line.clear();
        }
        (send, output)
    }
    pub fn finish(&mut self) -> String {
        self.push("\n").1
    }
}

// Shared stdlib-only scripts preserve exact targets and verify before any write.
pub(crate) const REMOTE_CONFIGURE: &str = concat!(
    include_str!("stable_remote/common.py"),
    "\n",
    include_str!("stable_remote/migrate.py"),
    "\n",
    include_str!("stable_remote/configure.py")
);

pub fn friendly_error(error: &str, token: &str) -> String {
    for (marker, message) in [
        (
            "CCB_SETUP_TIMEOUT",
            "后台操作等待服务器响应超时，请重新检查。",
        ),
        (
            "CCB_AUTH_REQUIRED",
            "需要登录服务器，请输入登录密码或密钥口令后重新检查。",
        ),
        (
            "CCB_SCOPE_CONFLICT",
            "新范围已有同名接入，请选择其他项目或先处理该接入，原配置已保留。",
        ),
        (
            "CCB_SCOPE_PARTIAL",
            "范围更改未完整完成，期间配置被修改或恢复失败，请重新检查原范围和新范围的接入。",
        ),
        (
            "CCB_TARGET_CHANGED",
            "原有接入在检查后发生变化，请重新检查并确认要升级的接入。",
        ),
        (
            "CCB_TARGET_REQUIRED",
            "这个位置已存在桥接入，请重新检查并选择原有接入进行升级。",
        ),
        (
            "CCB_INSPECTION_REQUIRED",
            "请先完成服务器接入检查，再继续配置。",
        ),
        (
            "CCB_CONFIG_READ_FAILED",
            "无法读取 Claude Code 配置，请检查文件格式和读取权限。",
        ),
        (
            "CCB_CONFIG_TOO_LARGE",
            "Claude Code 配置文件过大，请选择一个项目后重新检查。",
        ),
        (
            "CCB_FOLDER_READ_FAILED",
            "无法读取这个文件夹，请检查访问权限或选择其他文件夹。",
        ),
        (
            "CCB_ENTRY_UNSUPPORTED",
            "发现了无法自动升级的同名接入，请检查原有 MCP 配置。",
        ),
        (
            "CCB_PROJECTS_LIMITED",
            "项目较多，本次仅检查最近 32 个。请选择一个项目后继续检查。",
        ),
        (
            "CCB_RESULT_OVERFLOW",
            "检查结果较多，请选择一个项目后重新检查。",
        ),
        (
            "CCB_CLAUDE_MISSING",
            "服务器尚未安装 Claude Code，请安装后重新检测。",
        ),
        (
            "CCB_PYTHON_MISSING",
            "服务器未安装 Python 3，无法自动配置；安装后重试，或使用 IP 直连手动接入。",
        ),
        (
            "CCB_VERIFY_FAILED",
            "无法通过固定地址验证本机 MCP 服务，请检查服务是否启动、令牌是否有效。",
        ),
        ("CCB_PROJECT_MISSING", "服务器项目路径不存在，请检查路径。"),
        (
            "CCB_CONFIG_DIRECTORY_MISSING",
            "Claude Code 配置目录不存在，请先在服务器启动一次 Claude Code。",
        ),
        (
            "CCB_CONFIG_SYMLINK",
            "Claude Code 配置是符号链接，请使用手动接入以保留原链接。",
        ),
        ("CCB_CONFIG_BUSY", "Claude Code 配置正在更新，请稍后重试。"),
        (
            "CCB_CONFIG_FAILED",
            "无法写入 Claude Code 配置，请检查文件格式和写入权限，原配置已保留。",
        ),
    ] {
        if error.contains(marker) {
            return message.into();
        }
    }
    let clean = if token.is_empty() {
        error.into()
    } else {
        error.replace(token, "[已隐藏]")
    };
    clean.chars().take(1200).collect()
}

#[cfg(test)]
#[path = "stable_connect_tests.rs"]
mod integration_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmed_port_never_changes() {
        assert_eq!(candidate_ports(Some(17823), Some(17827), 7823), vec![17823]);
        assert_eq!(
            candidate_ports(None, Some(17827), 7823),
            vec![17827, 7823, 17823, 27823, 37823]
        );
        assert_eq!(
            candidate_ports(None, None, 7823),
            vec![7823, 17823, 27823, 37823]
        );
        // 分配端口与历史候选重合时不能重复出现：重复项会让同一条隧道被重建一次，
        // 而那次重建注定失败——端口还在被自己上一轮占着。
        assert_eq!(
            candidate_ports(None, Some(7823), 7823),
            vec![7823, 17823, 27823, 37823]
        );
        // 服务器返回 0 表示分配不出端口，不能当成合法监听端口去试。
        assert_eq!(
            candidate_ports(None, Some(0), 7823),
            vec![7823, 17823, 27823, 37823]
        );
    }
    #[test]
    fn settings_migration_preserves_direct_users() {
        let mut c = BridgeConfig::default();
        assert_eq!(method(&c), "stable");
        c.has_onboarded = true;
        assert_eq!(method(&c), "direct");
    }
    #[test]
    fn managed_rule_is_loopback_and_honors_listener() {
        let c = BridgeConfig {
            host: "192.168.1.10".into(),
            port: 9000,
            ..BridgeConfig::default()
        };
        let r = rule(17823, &c);
        assert_eq!(r.listen_host, "127.0.0.1");
        assert_eq!(r.target_host, c.host);
        assert_eq!(r.target_port, 9000);
        assert_ne!(runtime_id("cloud"), "cloud");
    }
    #[test]
    fn paths_and_tokens_cannot_break_shell_arguments() {
        let c = BridgeConfig {
            token: "a'$(echo broken)".into(),
            ..BridgeConfig::default()
        };
        let script = remote_script(
            &c,
            7823,
            "project",
            "/x'$(touch bad)",
            false,
            None,
            (false, None),
        );
        assert!(!script.0.contains(&c.token));
        assert!(!script.0.contains("touch bad"));
        let words = shell_words::split(script.0.split("; python3 -c ").nth(1).unwrap()).unwrap();
        assert_eq!(words.len(), 1);
        let p: serde_json::Value = serde_json::from_str(&script.1).unwrap();
        assert_eq!(p["path"], "/x'$(touch bad)");
        assert_eq!(p["token"], c.token);
    }
    #[test]
    fn config_signature_excludes_vpn_ip_but_catches_token_and_listener_changes() {
        let mut c = BridgeConfig::default();
        let one = fingerprint(&c, "cloud");
        c.last_selected_ip = Some("10.0.0.2".into());
        assert_eq!(one, fingerprint(&c, "cloud"));
        c.port += 1;
        assert_ne!(one, fingerprint(&c, "cloud"));
    }
    #[test]
    fn validates_project_and_multidevice() {
        assert!(validate_setup("project", "", false).is_err());
        assert!(validate_setup("project", "/work", true).is_err());
        assert!(validate_setup("user", "", true).is_ok());
    }
    #[test]
    fn errors_do_not_expose_token() {
        assert!(!friendly_error("failure secret-value", "secret-value").contains("secret-value"));
        assert!(friendly_error("CCB_CLAUDE_MISSING", "").contains("尚未安装"));
    }
    #[test]
    fn remote_failure_keeps_the_specific_reason() {
        // 精确原因必须活着到 friendly_error，否则用户只会看到"请重新检测"。
        assert_eq!(
            setup_error("CCB_TARGET_REQUIRED\n", "CCB_CONFIGURED").as_deref(),
            Some("CCB_TARGET_REQUIRED")
        );
        assert_eq!(
            setup_error("CCB_SCOPE_CONFLICT\n", "CCB_CONFIGURED").as_deref(),
            Some("CCB_SCOPE_CONFLICT")
        );
        assert!(setup_error("CCB_CONFIGURED\n", "CCB_CONFIGURED").is_none());
        let blank = setup_error("noise\n", "CCB_CONFIGURED").unwrap();
        assert!(blank.contains("远程配置没有返回确认结果"));
    }

    #[test]
    fn setup_input_waits_for_exact_marker_and_never_captures_echo() {
        let payload = "{\"token\":\"secret\"}";
        let mut input = SetupInput::new(payload.into());
        assert_eq!(
            input.push("echo CCB_INPUT_READY\r\n"),
            (None, String::new())
        );
        assert_eq!(input.push("CCB_INPUT_"), (None, String::new()));
        let (send, output) = input.push("READY\r\n");
        let send = send.unwrap();
        assert!(output.is_empty());
        assert!(send.starts_with("CCB_PAYLOAD ") && send.ends_with("CCB_PAYLOAD_END"));
        assert!(!send.contains("secret"));
        assert_eq!(
            input.push("{\"token\":\"secret\"}\r\nCCB_CONFIGURED\r\n"),
            (None, "CCB_CONFIGURED\n".into())
        );
        assert_eq!(input.push("CCB_INPUT_READY\n"), (None, String::new()));
    }

    #[test]
    fn setup_readiness_does_not_require_a_rendered_newline() {
        let mut input = SetupInput::new("fixture-payload".into());
        assert!(input.push("echo CCB_INPUT_READY\nCCB_INPUT_").0.is_none());
        let (send, output) = input.push("READY");
        assert!(send.unwrap().starts_with("CCB_PAYLOAD "));
        assert!(output.is_empty());
        assert!(input.push("\r\nCCB_INPUT_READY").0.is_none());
    }

    #[test]
    fn setup_captures_last_marker_at_eof_without_returning_echo() {
        let mut input = SetupInput::new("fixture-payload".into());
        input.push("CCB_INPUT_READY\n");
        assert_eq!(
            input
                .push("echo fixture-payload\nCCB_DATA e30=\nCCB_DISCOVERED")
                .1,
            "CCB_DATA e30=\n"
        );
        assert_eq!(input.finish(), "CCB_DISCOVERED\n");
        assert!(input.finish().is_empty());
    }

    #[test]
    fn setup_timeout_does_not_blame_a_working_terminal_or_show_empty_output() {
        let message = friendly_error("CCB_SETUP_TIMEOUT\n--- 输出 ---\n", "");
        assert!(message.contains("后台操作"));
        assert!(!message.contains("网络不通") && !message.contains("--- 输出 ---"));
    }
}
