//! One current-access summary and copy policy for the page, palette, and native tray.
use crate::config::BridgeConfig;
use crate::network::{self, ConnectTarget, IpUpdateTarget};
use crate::stable_connect::{self as stable, StableRecord};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectAccess {
    pub client: String,
    pub address: String,
    pub scope: String,
    pub project_path: String,
    pub fingerprint: String,
    #[serde(default)]
    pub token_fingerprint: String,
    #[serde(default = "default_entry")]
    pub entry_name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issued_addresses: Vec<String>,
}
fn default_entry() -> String {
    "cc-bridge".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAccess {
    pub method: String,
    pub server_name: String,
    pub connection_id: Option<String>,
    pub address: String,
    pub previous_address: Option<String>,
    pub scope: String,
    pub project_path: String,
    pub entry_name: String,
    pub target_id: Option<String>,
    pub target_key: String,
    pub configured: bool,
    pub config_matches: bool,
    pub configuration_verified: bool,
    pub verified_at: Option<u64>,
    pub channel_ready: bool,
    pub channel_detail: String,
    pub channel_phase: String,
    pub state: String,
    pub tone: String,
    pub title: String,
    pub detail: String,
    pub short: String,
    pub action: String,
    pub selection_pending: bool,
    pub can_copy_address: bool,
    pub can_copy_command: bool,
    pub can_update_ip: bool,
    pub can_confirm_update: bool,
    pub token_update_pending: bool,
    pub source_scope: String,
    pub source_project_path: String,
    pub update_command: String,
}

pub fn uses_tunnel(config: &BridgeConfig) -> bool {
    stable::method(config) == "stable"
        && config.connect_client.as_deref().unwrap_or("claude-code") == "claude-code"
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn token_fingerprint(config: &BridgeConfig) -> String {
    format!("{:x}", Sha256::digest(config.token.as_bytes()))
}

/// Shared last local observation; it never represents a remote Claude Code connection.
pub fn cached_local_probe(
    state: &crate::state::AppState,
    config: &BridgeConfig,
    ips: &[String],
) -> Option<bool> {
    let host = network::resolve_display_host(&config.host, ips, config.last_selected_ip.as_deref());
    state
        .local_access_probe
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .filter(|(target, port, _)| *target == host && *port == config.port)
        .map(|(_, _, reachable)| *reachable)
}

pub fn firewall_blocked(state: &crate::state::AppState) -> bool {
    let cache = state
        .firewall_cache
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    cache.enabled == Some(true) && cache.port_open == Some(false)
}

fn scope(config: &BridgeConfig) -> &str {
    if config.connect_client.as_deref().unwrap_or("claude-code") != "claude-code"
        || config.multi_device_mode
    {
        "user"
    } else {
        config.scope.as_deref().unwrap_or(if config.has_onboarded {
            "project"
        } else {
            "user"
        })
    }
}

pub fn direct_access(config: &BridgeConfig, ips: &[String]) -> DirectAccess {
    let host = network::resolve_display_host(&config.host, ips, config.last_selected_ip.as_deref());
    let address = format!(
        "{}://{}:{}{}",
        if config.remote_tls_enabled {
            "https"
        } else {
            "http"
        },
        host,
        config.port,
        if config.transport == "sse" {
            "/mcp/sse"
        } else {
            "/mcp"
        }
    );
    let project_path = if scope(config) == "user" {
        ""
    } else {
        config.project_path.as_deref().unwrap_or("").trim()
    };
    let client = config.connect_client.as_deref().unwrap_or("claude-code");
    let identity = serde_json::json!([
        client,
        address,
        scope(config),
        project_path,
        config.token,
        config.multi_device_mode,
        config.device_id
    ]);
    DirectAccess {
        client: client.into(),
        address,
        scope: scope(config).into(),
        project_path: project_path.into(),
        fingerprint: format!("{:x}", Sha256::digest(identity.to_string().as_bytes())),
        token_fingerprint: token_fingerprint(config),
        entry_name: if config.multi_device_mode {
            format!("cc-bridge-{}", config.device_id)
        } else {
            default_entry()
        },
        issued_addresses: Vec::new(),
    }
}

pub fn update_direct_receipt(
    config: &BridgeConfig,
    ips: &[String],
    target_key: &str,
    confirmed: bool,
) -> Result<Option<DirectAccess>, String> {
    let next = direct_access(config, ips);
    if uses_tunnel(config) || next.fingerprint != target_key {
        return Err("接入目标已变化，请重新查看当前接入。".into());
    }
    let Some(mut receipt) = config
        .stable_connect
        .direct
        .clone()
        .filter(|r| r.client == "claude-code" && r.client == next.client)
    else {
        return Ok(None);
    };
    if confirmed {
        // The update command edits the original entry, even if the form now points elsewhere.
        if (&receipt.scope, &receipt.project_path, &receipt.entry_name)
            == (&next.scope, &next.project_path, &next.entry_name)
        {
            return Ok(Some(next));
        }
        receipt.address = next.address;
        receipt.token_fingerprint = next.token_fingerprint;
        receipt.issued_addresses.clear();
    } else {
        if receipt.address == next.address || receipt.issued_addresses.contains(&next.address) {
            return Ok(None);
        }
        // Copying is not confirmation, but the next repair may safely recognize a previously issued address.
        const MAX_ISSUED_ADDRESSES: usize = 8;
        if receipt.issued_addresses.len() >= MAX_ISSUED_ADDRESSES {
            let expired = receipt.issued_addresses.len() + 1 - MAX_ISSUED_ADDRESSES;
            receipt.issued_addresses.drain(..expired);
        }
        receipt.issued_addresses.push(next.address);
    }
    Ok(Some(receipt))
}

/// A copied command is a receipt, never proof that a remote file or client changed.
pub fn summary(
    config: &BridgeConfig,
    records: &[StableRecord],
    ips: &[String],
    running: bool,
    local_reachable: Option<bool>,
    startup_error: Option<&str>,
    firewall_blocked: bool,
) -> ConnectionAccess {
    let tunnel = uses_tunnel(config);
    let direct = direct_access(config, ips);
    let receipt = config
        .stable_connect
        .direct
        .as_ref()
        .filter(|r| r.client == direct.client);
    let selected = config.stable_connect.selected_connection_id.as_ref();
    let record = records.iter().find(|r| Some(&r.connection_id) == selected);
    let server = config
        .ssh_connections
        .iter()
        .find(|s| Some(&s.id) == selected);
    let configured = if tunnel {
        record.is_some_and(|r| r.configured)
    } else {
        receipt.is_some()
    };
    let matches = if tunnel {
        record.is_some_and(|r| r.config_matches)
    } else {
        receipt.is_some_and(|r| r.fingerprint == direct.fingerprint)
    };
    let address = if tunnel {
        record
            .filter(|r| r.configured)
            .map(|r| format!("http://127.0.0.1:{}/mcp", r.port))
            .unwrap_or_default()
    } else {
        direct.address.clone()
    };
    let target = record.and_then(|r| r.target.as_ref());
    let scope = if tunnel {
        target
            .map(|t| t.scope.as_str())
            .or(record.map(|r| r.scope.as_str()))
            .unwrap_or("project")
    } else {
        direct.scope.as_str()
    };
    let path = if tunnel {
        target
            .map(|t| t.project_path.as_str())
            .or(record.map(|r| r.project_path.as_str()))
            .unwrap_or("")
    } else {
        direct.project_path.as_str()
    };
    let ip_changed = config
        .last_selected_ip
        .as_ref()
        .is_some_and(|ip| !ips.contains(ip))
        || config.host != "0.0.0.0"
            && !network::is_loopback_host(&config.host)
            && !ips.iter().any(|ip| ip == &config.host)
        || !tunnel && receipt.is_some_and(|r| r.address != direct.address);
    let phase = record.map_or("idle", |r| r.phase.as_str());
    let supported = !config.remote_tls_enabled && config.transport == "http";
    let channel_ready = running
        && if tunnel {
            phase == "ready" && supported
        } else {
            !ip_changed && !firewall_blocked && local_reachable == Some(true)
        };
    let token_update_pending = if tunnel {
        config
            .stable_connect
            .connections
            .iter()
            .find(|s| Some(&s.connection_id) == selected)
            .is_some_and(|s| {
                if s.token_fingerprint.is_empty() {
                    !matches
                } else {
                    s.token_fingerprint != token_fingerprint(config)
                }
            })
    } else {
        receipt.is_some_and(|r| {
            if r.token_fingerprint.is_empty() {
                !matches
            } else {
                r.token_fingerprint != token_fingerprint(config)
            }
        })
    };
    let mut access = ConnectionAccess {
        method: if tunnel { "stable" } else { "direct" }.into(),
        server_name: if tunnel {
            server
                .map(|s| s.name.clone())
                .unwrap_or_else(|| "选择服务器".into())
        } else {
            "本机直连".into()
        },
        connection_id: if tunnel { selected.cloned() } else { None },
        address,
        previous_address: if tunnel {
            target.map(|t| t.url.clone())
        } else {
            receipt.map(|r| r.address.clone())
        },
        scope: scope.into(),
        project_path: path.into(),
        entry_name: if tunnel {
            target
                .map(|t| t.name.clone())
                .unwrap_or_else(|| "cc-bridge".into())
        } else if config.multi_device_mode {
            format!("cc-bridge-{}", config.device_id)
        } else {
            "cc-bridge".into()
        },
        target_id: if tunnel {
            target.map(|t| t.id.clone())
        } else {
            None
        },
        target_key: if tunnel {
            format!(
                "{}:{}:{}:{}:{}",
                selected.map_or("", String::as_str),
                stable::fingerprint(config, selected.map_or("", String::as_str)),
                scope,
                path,
                target.map_or("", |t| t.id.as_str())
            )
        } else {
            direct.fingerprint
        },
        configured,
        config_matches: matches,
        configuration_verified: tunnel
            && matches
            && target.is_some()
            && phase != "error"
            && phase != "running",
        verified_at: if tunnel {
            record.and_then(|r| r.verified_at)
        } else {
            None
        },
        channel_ready,
        channel_detail: if tunnel {
            "已连通"
        } else if local_reachable == Some(true) {
            "本机已绑定"
        } else {
            "本机检查待确认"
        }
        .into(),
        channel_phase: if tunnel {
            phase
        } else if local_reachable == Some(true) {
            "ready"
        } else {
            "unknown"
        }
        .into(),
        state: "waiting".into(),
        tone: "live".into(),
        title: if tunnel {
            "隧道已连通，等待 Claude Code"
        } else {
            "本机已就绪，接入待验证"
        }
        .into(),
        detail: if tunnel {
            "请重新打开服务器上的 Claude Code，加载接入配置。"
        } else {
            "在服务器执行接入命令后，打开 Claude Code 并查看 /mcp。"
        }
        .into(),
        short: "接入待验证".into(),
        action: "检查接入".into(),
        selection_pending: if tunnel {
            !configured && config.has_onboarded
        } else {
            receipt.is_none() && !config.stable_connect.connections.is_empty()
        },
        can_copy_address: true,
        can_copy_command: !tunnel || configured && matches && supported && phase != "running",
        can_update_ip: !tunnel,
        can_confirm_update: !tunnel
            && direct.client == "claude-code"
            && receipt.is_some_and(|r| r.address != direct.address || token_update_pending),
        token_update_pending,
        source_scope: if tunnel {
            scope
        } else {
            receipt.map_or(scope, |r| r.scope.as_str())
        }
        .into(),
        source_project_path: if tunnel {
            path
        } else {
            receipt.map_or(path, |r| r.project_path.as_str())
        }
        .into(),
        update_command: if tunnel {
            String::new()
        } else {
            ip_update_command(config, ips)
                .map(|r| r.0)
                .unwrap_or_default()
        },
    };
    if access.previous_address.as_ref() == Some(&access.address) {
        access.previous_address = None;
    }
    access.can_copy_address = !access.address.is_empty();
    let state = if !running && startup_error.is_some() {
        Some((
            "service-error",
            "error",
            "本机服务无法启动",
            startup_error.unwrap_or_default(),
            "启动失败",
            "查看本机服务设置",
            "等待服务",
        ))
    } else if !running {
        Some((
            "service-stopped",
            "stopped",
            "本机服务已停止",
            "启动本机服务后，全部接入才能继续使用。",
            "本机服务已停止",
            "启动本机服务",
            "等待服务",
        ))
    } else if tunnel && !supported {
        Some((
            "unsupported",
            "warn",
            "隧道接入设置需要调整",
            "自动接入需要 HTTP 且未启用 HTTPS；请前往现有网络设置调整。",
            "设置待调整",
            "查看网络设置",
            "等待调整",
        ))
    } else if tunnel && phase == "running" {
        Some((
            "applying",
            "live",
            "正在配置隧道连接",
            "配置完成后，请重新打开服务器上的 Claude Code。",
            "正在接入",
            "查看接入进度",
            "连接中",
        ))
    } else if tunnel && !configured {
        Some((
            "setup",
            "live",
            "隧道连接尚未配置",
            "选择服务器和项目，一次完成隧道与接入配置。",
            "待配置",
            "一键接入",
            "待配置",
        ))
    } else if tunnel && record.is_some_and(|r| r.needs_secret) {
        Some((
            "login",
            "warn",
            "需要重新登录服务器",
            "补充登录信息后继续连接，固定地址和项目配置已保留。",
            "需要登录",
            "重新登录",
            "等待登录",
        ))
    } else if tunnel && phase == "reconnecting" {
        Some((
            "recovery",
            "warn",
            "正在重连，固定地址不变",
            "正在自动恢复连接，继续使用原来的 MCP 地址。",
            "正在重连",
            "查看连接状态",
            "正在重连",
        ))
    } else if tunnel && phase == "error" {
        Some((
            "error",
            "warn",
            "隧道连接需要处理",
            "查看当前原因，处理后重新连接。",
            "连接异常",
            "处理连接问题",
            "等待处理",
        ))
    } else if tunnel && !matches {
        Some((
            "changed",
            "warn",
            "隧道连接配置待应用",
            "检查并更新原有接入，继续沿用原名称、固定地址和范围。",
            "待应用",
            "检查并更新原接入",
            "配置待更新",
        ))
    } else if tunnel && phase == "stopped" {
        Some((
            "paused",
            "stopped",
            "隧道已暂停，配置已保留",
            "恢复当前隧道后继续使用，无需再次添加 MCP。",
            "已暂停",
            "恢复隧道",
            "已暂停",
        ))
    } else if !tunnel && ip_changed {
        Some((
            "ip-changed",
            "warn",
            "直连地址已变化，原接入待更新",
            "复制地址更新命令，在原接入位置执行，无需重新添加 MCP。",
            "地址待更新",
            "复制 IP 替换命令",
            "地址待更新",
        ))
    } else if !tunnel && local_reachable == Some(false) {
        Some((
            "direct-unreachable",
            "warn",
            "本机直连地址暂不可用",
            "检查本机监听地址和网络，在服务器上验证能否访问。",
            "地址待检查",
            "检查直连地址",
            "本机未绑定",
        ))
    } else if !tunnel && firewall_blocked {
        Some((
            "direct-blocked",
            "warn",
            "直连接入的入站放行待处理",
            "本机防火墙可能拦截服务器访问，请检查入站规则后在服务器验证。",
            "入站待放行",
            "检查直连地址",
            "入站待放行",
        ))
    } else if !tunnel && receipt.is_some() && !matches {
        Some((
            "changed",
            "warn",
            "IP 直连配置待应用",
            "配置有变化；更新命令使用原接入位置，请在服务器执行后验证。",
            "待应用",
            "查看接入配置",
            "本机已绑定",
        ))
    } else {
        None
    };
    if let Some((state, tone, title, detail, short, action, channel)) = state {
        access.state = state.into();
        access.tone = tone.into();
        access.title = title.into();
        access.detail = detail.into();
        access.short = short.into();
        access.action = action.into();
        access.channel_detail = channel.into();
    }
    access
}

pub fn connect_command(config: &BridgeConfig, ips: &[String]) -> Result<String, String> {
    if uses_tunnel(config) {
        let saved = stable::selected_saved(config)
            .ok_or("隧道连接尚未配置，请在接入卡片中完成一键接入。")?;
        if saved.fingerprint != stable::fingerprint(config, &saved.connection_id)
            || config.remote_tls_enabled
            || config.transport != "http"
        {
            return Err("隧道连接配置待更新，请检查并应用原接入配置。".into());
        }
        return Ok(stable::manual_command(config, saved));
    }
    let client = config.connect_client.as_deref().unwrap_or("claude-code");
    let mut command = if config.multi_device_mode && client == "claude-code" {
        let host =
            network::resolve_display_host(&config.host, ips, config.last_selected_ip.as_deref());
        network::build_multi_device_command(
            config.port,
            &host,
            &config.token,
            &config.transport,
            config.remote_tls_enabled,
            &config.device_id,
        )
    } else {
        network::build_connect_command(ConnectTarget {
            host: &config.host,
            port: config.port,
            token: &config.token,
            transport: &config.transport,
            tls: config.remote_tls_enabled,
            client,
            lan_ips: ips,
            selected_ip: config.last_selected_ip.as_deref(),
            multi_device: config.multi_device_mode,
            device_id: &config.device_id,
        })
    };
    if client == "claude-code" && !config.multi_device_mode {
        command = command.replacen(
            "claude mcp add",
            &format!("claude mcp add --scope {}", scope(config)),
            1,
        );
        if scope(config) == "project"
            && !config
                .project_path
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
        {
            command = format!(
                "cd {} && {command}",
                network::quote_remote_path(config.project_path.as_deref().unwrap_or("").trim())
            );
        }
    }
    Ok(command)
}

pub fn ip_update_command(
    config: &BridgeConfig,
    ips: &[String],
) -> Result<(String, String), String> {
    if uses_tunnel(config) {
        return Err("隧道连接使用固定 MCP 地址，无需替换 IP。请前往接入卡片检查隧道。".into());
    }
    let receipt = config
        .stable_connect
        .direct
        .as_ref()
        .filter(|r| r.client == config.connect_client.as_deref().unwrap_or("claude-code"));
    if let Some(receipt) = receipt.filter(|r| r.client == "claude-code") {
        let next = direct_access(config, ips);
        return Ok((
            direct_update_command(config, receipt, &next.address),
            if receipt.scope == "user" {
                "全局模式"
            } else {
                "原项目级接入"
            }
            .into(),
        ));
    }
    Ok(network::ip_update_command_for(
        IpUpdateTarget {
            host: &config.host,
            port: config.port,
            token: &config.token,
            transport: &config.transport,
            last_selected_ip: config.last_selected_ip.as_deref(),
            scope: receipt
                .map(|r| r.scope.as_str())
                .or(config.scope.as_deref()),
            project_path: receipt
                .map(|r| r.project_path.as_str())
                .or(config.project_path.as_deref()),
            tls: config.remote_tls_enabled,
            client: config.connect_client.as_deref().unwrap_or("claude-code"),
            multi_device: config.multi_device_mode,
            device_id: &config.device_id,
        },
        ips,
    ))
}

/// Update one existing entry instead of replacing all URLs in a shared MCP file.
fn direct_update_command(config: &BridgeConfig, receipt: &DirectAccess, address: &str) -> String {
    let payload = serde_json::json!([
        receipt.scope,
        receipt.entry_name,
        std::iter::once(&receipt.address)
            .chain(
                receipt
                    .issued_addresses
                    .iter()
                    .filter(|issued| *issued != address)
            )
            .collect::<Vec<_>>(),
        address,
        config.transport,
        config.token
    ]);
    let command = format!(
        "python3 -c {} {}",
        stable::shell_quote(include_str!("direct_access_update.py")),
        stable::shell_quote(&payload.to_string())
    );
    if receipt.scope == "project" && !receipt.project_path.is_empty() {
        format!(
            "cd {} && {command}",
            network::quote_remote_path(&receipt.project_path)
        )
    } else {
        command
    }
}

#[cfg(test)]
#[path = "connection_access_tests.rs"]
mod tests;
