//! Claude access owns its listener even while paused; legacy rules must not restart it.
use crate::config::{ForwardAuto, ForwardKind, ForwardRule, SshConnection};
use serde::Serialize;
use std::net::IpAddr;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedForward {
    pub connection_id: String,
    pub rule: ForwardRule,
    pub phase: String,
    pub enabled: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardConflict {
    pub rule_id: String,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardContext {
    pub connection_id: String,
    pub forward_auto: ForwardAuto,
    pub managed: Vec<ManagedForward>,
    pub manual_rules: Vec<ForwardRule>,
    pub managed_rule_ids: Vec<String>,
    pub conflicts: Vec<ForwardConflict>,
    pub manual_status: Option<crate::ssh_tunnel::TunnelStatus>,
}

pub fn host_key(host: &str) -> String {
    let host = host.trim().trim_matches(['[', ']']);
    host.parse::<IpAddr>()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| host.to_ascii_lowercase())
}

pub fn same_server(a: &SshConnection, b: &SshConnection) -> bool {
    a.id == b.id
        || (host_key(&a.host) == host_key(&b.host)
            && a.port == b.port
            && a.proxy_jump_id == b.proxy_jump_id)
}

pub fn same_route(a: &ForwardRule, b: &ForwardRule) -> bool {
    a.kind == b.kind
        && host_key(&a.listen_host) == host_key(&b.listen_host)
        && a.listen_port == b.listen_port
        && host_key(&a.target_host) == host_key(&b.target_host)
        && a.target_port == b.target_port
}

fn hosts_overlap(a: &str, b: &str) -> bool {
    let a = host_key(a);
    let b = host_key(b);
    if a == b || ["", "*", "::"].contains(&a.as_str()) || ["", "*", "::"].contains(&b.as_str()) {
        return true;
    }
    let loopback =
        |h: &str| h == "localhost" || h.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if (a == "localhost" || b == "localhost") && loopback(&a) && loopback(&b) {
        return true;
    }
    let ipv4 = |h: &str| h == "localhost" || h.parse::<IpAddr>().is_ok_and(|ip| ip.is_ipv4());
    (a == "0.0.0.0" && ipv4(&b)) || (b == "0.0.0.0" && ipv4(&a))
}

pub fn listeners_overlap(a: &ForwardRule, b: &ForwardRule) -> bool {
    // A remote port of zero requests a fresh allocation and cannot duplicate a fixed listener.
    a.listen_port != 0
        && a.listen_port == b.listen_port
        && (a.kind == ForwardKind::Remote) == (b.kind == ForwardKind::Remote)
        && hosts_overlap(&a.listen_host, &b.listen_host)
}

pub fn context(
    connection: &SshConnection,
    rules: &[ForwardRule],
    managed: Vec<ManagedForward>,
) -> ForwardContext {
    let mut result = ForwardContext {
        connection_id: connection.id.clone(),
        forward_auto: connection.forward_auto,
        managed,
        manual_rules: Vec::new(),
        managed_rule_ids: Vec::new(),
        conflicts: Vec::new(),
        manual_status: None,
    };
    for rule in rules {
        if result.managed.iter().any(|m| same_route(rule, &m.rule)) {
            result.managed_rule_ids.push(rule.id.clone());
            continue;
        }
        if rule.enabled
            && result
                .managed
                .iter()
                .any(|m| listeners_overlap(rule, &m.rule))
        {
            result.conflicts.push(ForwardConflict {
                rule_id: rule.id.clone(),
                message: format!(
                    "规则「{}」使用的端口 {} 已由 Claude Code 隧道管理，但转发目标或监听地址不同。请修改这条规则的端口或停用它。",
                    if rule.note.is_empty() { &rule.id } else { &rule.note },
                    rule.listen_port
                ),
            });
        }
        result.manual_rules.push(rule.clone());
    }
    result
}

#[cfg(test)]
#[path = "forward_ownership_tests.rs"]
mod tests;
