//! 端口转发的纯逻辑：规则校验、`-L/-R/-D` 参数拼接、从 `ssh -v` 输出推断每条规则的状态。
//!
//! 进程管理在 `commands::ssh_tunnel_cmds`。这里不碰进程和 IO，方便直接喂 OpenSSH 的真实输出行做单测。
//!
//! 解析依赖的 OpenSSH 日志（7.x – 10.x 一致）：
//! - `Authenticated to host ([ip]:22) using "password".` / `Authentication succeeded (password).`
//! - `debug1: Local forwarding listening on 127.0.0.1 port 8080.`（`-L` 与 `-D` 共用）
//! - `bind [127.0.0.1]:8080: Address already in use` + `...: cannot listen to port: 8080`
//! - `debug1: remote forward success for: listen 127.0.0.1:5000, connect 127.0.0.1:3306`
//! - `Allocated port 34567 for remote forward to 127.0.0.1:3306`（`-R` 端口填 0）
//! - `Warning: remote port forwarding failed for listen port 5000`
//!
//! 不开 `ExitOnForwardFailure`：一条规则失败不该拖垮其它规则，
//! 也避免「端口被占 → 退出 → 自动重连 → 又被占」的死循环。

use serde::Serialize;

use crate::config::{ForwardKind, ForwardRule};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    Connecting,
    Up,
    Reconnecting,
    Error,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleState {
    Pending,
    Listening,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleStatus {
    /// 启动时的规则快照：前端拿它和草稿比，判断「待应用」。
    pub rule: ForwardRule,
    pub state: RuleState,
    /// `-R` 端口填 0 时服务器实际分配的端口。
    pub bound_port: Option<u16>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub connection_id: String,
    pub state: TunnelState,
    pub message: Option<String>,
    /// 失败原因是「没有可填的密码/口令」：前端据此弹输入框再启动一次。
    pub needs_secret: bool,
    pub attempt: u32,
    pub phase: &'static str,
    pub retry_at: Option<u64>,
    pub disconnected_at: Option<u64>,
    pub last_failure: Option<String>,
    #[serde(skip)]
    pub(crate) retry_requested: bool,
    pub rules: Vec<RuleStatus>,
    /// 本轮进程是否认证成功过（决定重连退避是否重置）。
    #[serde(skip)]
    pub was_up: bool,
    /// 最近一行非 debug 输出：ssh 退出时它就是失败原因。
    #[serde(skip)]
    pub last_error: Option<String>,
    #[serde(skip)]
    pending_bind: Option<String>,
    #[serde(skip)]
    guard_required: bool,
    #[serde(skip)]
    guard_ready: bool,
}

impl TunnelStatus {
    pub fn new(connection_id: String, rules: &[ForwardRule]) -> Self {
        Self {
            connection_id,
            state: TunnelState::Connecting,
            message: None,
            needs_secret: false,
            attempt: 0,
            phase: "ssh",
            retry_at: None,
            disconnected_at: None,
            last_failure: None,
            retry_requested: false,
            rules: rules
                .iter()
                .map(|r| RuleStatus {
                    rule: r.clone(),
                    state: RuleState::Pending,
                    bound_port: None,
                    message: None,
                })
                .collect(),
            was_up: false,
            last_error: None,
            pending_bind: None,
            guard_required: false,
            guard_ready: false,
        }
    }

    pub fn stopped(connection_id: String) -> Self {
        Self {
            state: TunnelState::Stopped,
            ..Self::new(connection_id, &[])
        }
    }

    /// 新起一轮 ssh 进程：规则状态全部回到待定。
    pub fn begin_attempt(&mut self) {
        self.attempt = self.attempt.saturating_add(1);
        self.phase = "ssh";
        self.retry_at = None;
        self.retry_requested = false;
        self.state = TunnelState::Connecting;
        self.message = None;
        self.needs_secret = false;
        self.was_up = false;
        self.last_error = None;
        self.pending_bind = None;
        self.guard_ready = false;
        for r in &mut self.rules {
            r.state = RuleState::Pending;
            r.bound_port = None;
            r.message = None;
        }
    }

    pub(crate) fn wait_for_retry(&mut self, reason: String, now: u64, delay_ms: u64) {
        self.state = TunnelState::Reconnecting;
        self.phase = "waiting";
        self.disconnected_at.get_or_insert(now);
        self.retry_at = Some(now.saturating_add(delay_ms));
        self.last_failure = Some(reason.clone());
        self.message = Some(format!("{reason}（{} 秒后重连）", delay_ms / 1000));
    }

    pub(crate) fn request_retry(&mut self, now: u64) -> bool {
        if self.state != TunnelState::Reconnecting || self.retry_requested {
            return false;
        }
        self.retry_requested = true;
        self.retry_at = Some(now);
        true
    }

    pub(crate) fn require_guard(&mut self) {
        self.guard_required = true;
        self.guard_ready = false;
        self.state = TunnelState::Connecting;
    }

    pub(crate) fn guard_started(&mut self) -> bool {
        self.guard_ready = true;
        self.last_error = None;
        self.refresh_guard_state()
    }

    pub(crate) fn guard_is_ready(&self) -> bool {
        !self.guard_required || self.guard_ready
    }

    fn refresh_guard_state(&mut self) -> bool {
        if !self.guard_required {
            return false;
        }
        // A successful login cannot promise recovery before both the listener and its lease exist.
        let next = if self.was_up
            && self.guard_ready
            && !self.rules.is_empty()
            && self
                .rules
                .iter()
                .all(|rule| rule.state == RuleState::Listening)
        {
            TunnelState::Up
        } else {
            TunnelState::Connecting
        };
        let phase = if next == TunnelState::Up {
            "ready"
        } else if !self.was_up {
            self.phase
        } else if self.rules.iter().all(|r| r.state == RuleState::Listening) {
            "confirm"
        } else {
            "forward"
        };
        let changed = self.state != next || self.phase != phase;
        self.phase = phase;
        self.state = next;
        if next == TunnelState::Up {
            self.message = None;
            self.retry_at = None;
            self.disconnected_at = None;
            self.last_failure = None;
        }
        changed
    }

    /// 喂一行已去掉 ANSI 的 ssh 输出，返回对外可见的状态是否变了。
    pub fn apply_line(&mut self, line: &str) -> bool {
        let line = line.trim();
        if line.is_empty() {
            return false;
        }
        // Only report milestones observed in OpenSSH output; never advance on a timer.
        if line == "debug1: Connection established." && self.phase == "ssh" {
            self.phase = "auth";
            return true;
        }
        if line.starts_with("Authenticated to ") || line.contains("Authentication succeeded") {
            self.was_up = true;
            if self.guard_required {
                let changed = self.phase != "forward";
                self.phase = "forward";
                return self.refresh_guard_state() || changed;
            }
            if self.state == TunnelState::Up {
                return false;
            }
            self.state = TunnelState::Up;
            self.phase = "ready";
            self.message = None;
            return true;
        }
        if let Some(rest) = after(line, "Local forwarding listening on ") {
            return match rest.rsplit(" port ").next().and_then(parse_port) {
                Some(port) => self.mark_local(port, RuleState::Listening, None),
                None => false,
            };
        }
        if let Some(port) = after(line, "cannot listen to port: ").and_then(parse_port) {
            let msg = self
                .pending_bind
                .take()
                .unwrap_or_else(|| format!("本机端口 {port} 无法监听（可能已被占用）"));
            return self.mark_local(port, RuleState::Failed, Some(msg));
        }
        if line.starts_with("bind ") || line.starts_with("bind:") {
            self.pending_bind = Some(line.to_string());
            return false;
        }
        if let Some(rest) = after(line, "remote forward success for: listen ") {
            let listen = rest.split(',').next().unwrap_or("");
            return match listen.rsplit(':').next().and_then(parse_port) {
                Some(port) => self.mark_remote(port, RuleState::Listening, None),
                None => false,
            };
        }
        if let Some(rest) = after(line, "Allocated port ") {
            let mut it = rest.splitn(2, " for remote forward to ");
            if let (Some(port), Some(target)) = (it.next().and_then(parse_port), it.next()) {
                return self.mark_allocated(port, target.trim());
            }
            return false;
        }
        if let Some(port) =
            after(line, "remote port forwarding failed for listen port ").and_then(parse_port)
        {
            let msg = "服务器拒绝监听（端口已被占用，或 sshd 不允许绑定该地址，见 GatewayPorts）";
            return self.mark_remote(port, RuleState::Failed, Some(msg.into()));
        }
        if !line.starts_with("debug") && !line.starts_with("OpenSSH") {
            self.last_error = Some(line.to_string());
        }
        false
    }

    fn mark_local(&mut self, port: u16, state: RuleState, message: Option<String>) -> bool {
        let mut changed = false;
        for r in &mut self.rules {
            if r.rule.kind != ForwardKind::Remote && r.rule.listen_port == port && r.state != state
            {
                r.state = state;
                r.message = message.clone();
                changed = true;
            }
        }
        changed
    }

    /// 端口 0 的规则在日志里只能靠顺序对上：取第一条还在待定的。
    fn mark_remote(&mut self, port: u16, state: RuleState, message: Option<String>) -> bool {
        let hit = self.rules.iter_mut().find(|r| {
            r.rule.kind == ForwardKind::Remote
                && r.rule.listen_port == port
                && (port != 0 || r.state == RuleState::Pending)
        });
        let changed = match hit {
            Some(r) if r.state != state || r.message != message => {
                r.state = state;
                r.message = message;
                true
            }
            _ => false,
        };
        let ready_changed = self.refresh_guard_state();
        changed || ready_changed
    }

    fn mark_allocated(&mut self, port: u16, target: &str) -> bool {
        let unbound = |r: &RuleStatus| {
            r.rule.kind == ForwardKind::Remote && r.rule.listen_port == 0 && r.bound_port.is_none()
        };
        let idx = self
            .rules
            .iter()
            .position(|r| {
                unbound(r) && format!("{}:{}", r.rule.target_host, r.rule.target_port) == target
            })
            .or_else(|| self.rules.iter().position(unbound));
        let Some(i) = idx else {
            return false;
        };
        let r = &mut self.rules[i];
        r.bound_port = Some(port);
        r.state = RuleState::Listening;
        true
    }
}

fn after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    line.find(marker).map(|i| &line[i + marker.len()..])
}

fn parse_port(s: &str) -> Option<u16> {
    s.trim().trim_end_matches('.').parse().ok()
}

/// 重试也救不回来的失败：继续重连只会反复撞服务器（还可能触发 fail2ban）。
pub fn is_fatal(reason: &str) -> bool {
    const KEYS: [&str; 4] = [
        "Permission denied",
        "Host key verification failed",
        "Too many authentication failures",
        "REMOTE HOST IDENTIFICATION HAS CHANGED",
    ];
    KEYS.iter().any(|k| reason.contains(k))
}

/// 入口校验（`ssh_save_connection`）。每个方向内监听地址+端口不能重叠：
/// 状态解析按端口把日志对应到规则上，而 `127.0.0.1:8080` 与 `0.0.0.0:8080`
/// 会互相抢绑定（前者是后者的子集）——只看端口号会放行它们，运行时必有一条
/// bind 失败，且失败信息里看不出是规则打架。判重口径与托管冲突检测同一套
/// （`forward_ownership::listeners_overlap` 的 hosts_overlap）。
pub fn validate_rules(rules: &[ForwardRule]) -> Result<(), String> {
    let mut local: Vec<&ForwardRule> = Vec::new();
    let mut remote: Vec<&ForwardRule> = Vec::new();
    for r in rules {
        let label = format!("转发规则 {}:{}", r.listen_host, r.listen_port);
        if !host_ok(&r.listen_host) {
            return Err(format!("{label}：监听地址不合法"));
        }
        if r.kind != ForwardKind::Remote && r.listen_port == 0 {
            return Err(format!("{label}：本地监听端口必须在 1-65535 之间"));
        }
        if r.kind != ForwardKind::Dynamic && (!host_ok(&r.target_host) || r.target_port == 0) {
            return Err(format!("{label}：目标地址或端口不合法"));
        }
        if !r.enabled || r.listen_port == 0 {
            continue;
        }
        let seen = if r.kind == ForwardKind::Remote {
            &mut remote
        } else {
            &mut local
        };
        if let Some(other) = seen
            .iter()
            .find(|other| crate::forward_ownership::listeners_overlap(r, other))
        {
            return Err(format!(
                "{label}：与规则「{}」的监听地址/端口重叠，同时只能有一条在监听",
                if other.note.is_empty() {
                    &other.id
                } else {
                    &other.note
                }
            ));
        }
        seen.push(r);
    }
    Ok(())
}

/// 只放行主机名 / IPv4 / IPv6 / 完整 `*` 的字符：参数直接进 ssh 命令行，空格、引号一类必须拒掉。
/// `*` 只作为完整通配符（监听所有地址）放行；当普通字符放行会让 `12*3` 这类假
/// 主机名一路走到 ssh 命令行才失败。
fn host_ok(h: &str) -> bool {
    h == "*"
        || (!h.is_empty()
            && h.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':')))
}

fn spec_host(h: &str) -> String {
    if h.contains(':') {
        format!("[{h}]")
    } else {
        h.to_string()
    }
}

pub fn forward_args(rules: &[ForwardRule]) -> Vec<String> {
    let mut v = Vec::new();
    for r in rules.iter().filter(|r| r.enabled) {
        let listen = format!("{}:{}", spec_host(&r.listen_host), r.listen_port);
        let target = format!("{}:{}", spec_host(&r.target_host), r.target_port);
        match r.kind {
            ForwardKind::Local => v.extend(["-L".into(), format!("{listen}:{target}")]),
            ForwardKind::Remote => v.extend(["-R".into(), format!("{listen}:{target}")]),
            ForwardKind::Dynamic => v.extend(["-D".into(), listen]),
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kind: ForwardKind, listen_port: u16, target_port: u16) -> ForwardRule {
        ForwardRule {
            id: format!("{kind:?}-{listen_port}"),
            kind,
            listen_port,
            target_port,
            ..Default::default()
        }
    }

    fn status(rules: &[ForwardRule]) -> TunnelStatus {
        TunnelStatus::new("c".into(), rules)
    }

    #[test]
    fn retry_progress_preserves_outage_and_failure_until_the_route_is_ready() {
        let mut s = status(&[rule(ForwardKind::Remote, 5000, 7823)]);
        s.require_guard();
        s.begin_attempt();
        assert_eq!(s.attempt, 1);
        s.wait_for_retry("Connection timed out".into(), 10_000, 8_000);
        assert_eq!(s.retry_at, Some(18_000));
        assert!(s.request_retry(11_000));
        assert!(!s.request_retry(11_001));
        assert_eq!(s.retry_at, Some(11_000));
        s.begin_attempt();
        assert_eq!(s.attempt, 2);
        assert_eq!(s.disconnected_at, Some(10_000));
        assert_eq!(s.last_failure.as_deref(), Some("Connection timed out"));
        assert_eq!(s.retry_at, None);
        assert_eq!(s.phase, "ssh");
        assert!(s.apply_line("debug1: Connection established."));
        assert_eq!(s.phase, "auth");
        assert!(s.apply_line("Authenticated to server ([127.0.0.1]:22) using publickey."));
        assert_eq!(s.phase, "forward");
        assert!(s.apply_line(
            "debug1: remote forward success for: listen 127.0.0.1:5000, connect 127.0.0.1:7823"
        ));
        assert_eq!(s.phase, "confirm");
        assert_eq!(s.state, TunnelState::Connecting);
        assert!(s.guard_started());
        assert_eq!(s.phase, "ready");
        assert_eq!(s.state, TunnelState::Up);
        assert_eq!(s.disconnected_at, None);
        assert_eq!(s.last_failure, None);
        assert!(!s.request_retry(20_000));
    }

    #[test]
    fn repeated_failures_keep_original_outage_time_and_do_not_fake_progress() {
        let mut s = status(&[]);
        s.begin_attempt();
        assert!(!s.apply_line("debug1: Connecting to server [10.0.0.1] port 22."));
        assert_eq!(s.phase, "ssh");
        s.wait_for_retry("network unreachable".into(), 1_000, 2_000);
        s.begin_attempt();
        s.wait_for_retry("Connection timed out".into(), 5_000, 4_000);
        assert_eq!(s.disconnected_at, Some(1_000));
        assert_eq!(s.retry_at, Some(9_000));
        assert_eq!(s.attempt, 2);
    }

    #[test]
    fn builds_ssh_forward_specs() {
        let mut ipv6 = rule(ForwardKind::Local, 8080, 80);
        ipv6.listen_host = "::1".into();
        ipv6.target_host = "10.0.0.5".into();
        let mut off = rule(ForwardKind::Local, 9000, 90);
        off.enabled = false;
        let args = forward_args(&[
            ipv6,
            rule(ForwardKind::Remote, 5000, 3306),
            rule(ForwardKind::Dynamic, 1080, 0),
            off,
        ]);
        assert_eq!(
            args,
            [
                "-L",
                "[::1]:8080:10.0.0.5:80",
                "-R",
                "127.0.0.1:5000:127.0.0.1:3306",
                "-D",
                "127.0.0.1:1080"
            ]
        );
    }

    #[test]
    fn validation_rejects_bad_rules() {
        assert!(validate_rules(&[rule(ForwardKind::Remote, 0, 3306)]).is_ok());
        assert!(validate_rules(&[rule(ForwardKind::Dynamic, 1080, 0)]).is_ok());
        assert!(validate_rules(&[rule(ForwardKind::Local, 0, 80)]).is_err());
        assert!(validate_rules(&[rule(ForwardKind::Local, 8080, 0)]).is_err());
        let mut evil = rule(ForwardKind::Local, 8080, 80);
        evil.target_host = "x -oProxyCommand=calc".into();
        assert!(validate_rules(&[evil]).is_err());
        // 同方向重复不行，跨方向可以（一个在本机、一个在服务器）
        let dup = [
            rule(ForwardKind::Local, 8080, 80),
            rule(ForwardKind::Dynamic, 8080, 0),
        ];
        assert!(validate_rules(&dup).is_err());
        let cross = [
            rule(ForwardKind::Local, 8080, 80),
            rule(ForwardKind::Remote, 8080, 80),
        ];
        assert!(validate_rules(&cross).is_ok());
    }

    /// 同端口不同监听地址也必须拒：`0.0.0.0` / `*` 是通配，会把另一条的绑定抢掉。
    #[test]
    fn validation_rejects_overlapping_listen_hosts() {
        let wildcard = [rule(ForwardKind::Local, 8080, 80), {
            let mut r = rule(ForwardKind::Local, 8080, 81);
            r.listen_host = "0.0.0.0".into();
            r
        }];
        assert!(validate_rules(&wildcard).is_err());
        let star = [rule(ForwardKind::Local, 8080, 80), {
            let mut r = rule(ForwardKind::Local, 8080, 81);
            r.listen_host = "*".into();
            r
        }];
        assert!(validate_rules(&star).is_err());
        // 回环家族（localhost / 127.x / ::1）互相重叠
        let loopbacks = [rule(ForwardKind::Local, 8080, 80), {
            let mut r = rule(ForwardKind::Local, 8080, 81);
            r.listen_host = "localhost".into();
            r
        }];
        assert!(validate_rules(&loopbacks).is_err());
        // 端口不同不冲突
        let apart = [rule(ForwardKind::Local, 8080, 80), {
            let mut r = rule(ForwardKind::Local, 8081, 81);
            r.listen_host = "0.0.0.0".into();
            r
        }];
        assert!(validate_rules(&apart).is_ok());
        // 通配符只作为完整 `*` 放行，不能混进主机名
        let mut evil = rule(ForwardKind::Local, 8080, 80);
        evil.listen_host = "12*3".into();
        assert!(validate_rules(&[evil]).is_err());
    }

    #[test]
    fn local_and_dynamic_listen_lines() {
        let mut s = status(&[
            rule(ForwardKind::Local, 8080, 80),
            rule(ForwardKind::Dynamic, 1080, 0),
        ]);
        assert!(s.apply_line("Authenticated to host ([1.2.3.4]:22) using \"password\"."));
        assert_eq!(s.state, TunnelState::Up);
        assert!(s.apply_line("debug1: Local forwarding listening on 127.0.0.1 port 8080."));
        assert!(s.apply_line("debug1: Local forwarding listening on 127.0.0.1 port 1080."));
        assert!(s.rules.iter().all(|r| r.state == RuleState::Listening));
    }

    /// 实测 OpenSSH_for_Windows_9.5p2 的顺序：「listening on」在 bind 之前就打出来了，
    /// 失败行紧随其后——最终状态必须以失败为准。
    #[test]
    fn local_bind_failure_after_listening_line() {
        let mut s = status(&[rule(ForwardKind::Local, 18090, 80)]);
        s.apply_line("debug1: Local forwarding listening on 10.255.255.1 port 18090.");
        assert!(!s.apply_line("bind [10.255.255.1]:18090: Unknown error"));
        assert!(s.apply_line("channel_setup_fwd_listener_tcpip: cannot listen to port: 18090"));
        s.apply_line("Could not request local forwarding.");
        assert_eq!(s.rules[0].state, RuleState::Failed);
        assert_eq!(
            s.rules[0].message.as_deref(),
            Some("bind [10.255.255.1]:18090: Unknown error")
        );
    }

    #[test]
    fn remote_success_failure_and_allocation() {
        let mut s = status(&[
            rule(ForwardKind::Remote, 5000, 3306),
            rule(ForwardKind::Remote, 6000, 22),
            rule(ForwardKind::Remote, 0, 3389),
        ]);
        assert!(s.apply_line(
            "debug1: remote forward success for: listen 127.0.0.1:5000, connect 127.0.0.1:3306"
        ));
        assert!(s.apply_line("Warning: remote port forwarding failed for listen port 6000"));
        // 实测 9.5p2 的 listen 字段带主机：`listen 127.0.0.1:0`
        assert!(s.apply_line(
            "debug1: remote forward success for: listen 127.0.0.1:0, connect 127.0.0.1:3389"
        ));
        assert!(s.apply_line("Allocated port 34567 for remote forward to 127.0.0.1:3389"));
        assert_eq!(s.rules[0].state, RuleState::Listening);
        assert_eq!(s.rules[1].state, RuleState::Failed);
        assert_eq!(s.rules[2].state, RuleState::Listening);
        assert_eq!(s.rules[2].bound_port, Some(34567));
    }

    #[test]
    fn remembers_last_human_line_and_resets_per_attempt() {
        let mut s = status(&[rule(ForwardKind::Local, 8080, 80)]);
        s.apply_line("OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2");
        s.apply_line("debug1: Connecting to h [1.2.3.4] port 22.");
        assert_eq!(s.last_error, None);
        s.apply_line("ssh: connect to host h port 22: Connection refused");
        assert_eq!(
            s.last_error.as_deref(),
            Some("ssh: connect to host h port 22: Connection refused")
        );
        s.apply_line("debug1: Local forwarding listening on 127.0.0.1 port 8080.");
        s.begin_attempt();
        assert_eq!(s.last_error, None);
        assert_eq!(s.rules[0].state, RuleState::Pending);
    }

    #[test]
    fn fatal_reasons() {
        assert!(is_fatal(
            "61706@127.0.0.1: Permission denied (publickey,keyboard-interactive)."
        ));
        assert!(is_fatal("Host key verification failed."));
        assert!(!is_fatal(
            "ssh: connect to host h port 22: Connection timed out"
        ));
    }
}
