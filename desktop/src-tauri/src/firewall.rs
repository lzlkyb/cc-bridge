use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use crate::state::AppState;

/// 防火墙状态查询结果：(防火墙是否启用, 7823 入站是否放行)。
/// 两者均为 `Option<bool>`：`None` 表示「无法判断」（非 Windows 平台 / 查询命令失败 / 解析失败）。
pub type FirewallState = (Option<bool>, Option<bool>);

#[cfg(windows)]
pub fn query_firewall_state(port: u16) -> FirewallState {
    let enabled = query_firewall_enabled();
    let port_open = query_port_allowed(port);
    (enabled, port_open)
}

#[cfg(not(windows))]
pub fn query_firewall_state(_port: u16) -> FirewallState {
    (None, None)
}

/// 后台定时（每 5 分钟）与按需（open_firewall_port 成功后 / 前端「重新检查」）刷新缓存。
pub async fn refresh_cache(state: &Arc<AppState>, port: u16) {
    let (enabled, port_open) = query_firewall_state(port);
    let mut cache = state.firewall_cache.lock().unwrap();
    cache.enabled = enabled;
    cache.port_open = port_open;
    cache.checked_at = Some(Instant::now());
}

#[cfg(windows)]
fn query_firewall_enabled() -> Option<bool> {
    // 普通权限即可读取（无需管理员），实测 Windows 家庭版/专业版均可。
    let out = Command::new("netsh")
        .args(["advfirewall", "show", "allprofiles", "state"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    if text.contains("已启用") || text.contains("enabled") {
        Some(true)
    } else if text.contains("已关闭") || text.contains("disabled") || text.contains("off") {
        Some(false)
    } else {
        None
    }
}

#[cfg(windows)]
fn query_port_allowed(port: u16) -> Option<bool> {
    let out = Command::new("netsh")
        .args(["advfirewall", "firewall", "show", "rule", "name=all"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let port_str = port.to_string();
    // 解析失败（netsh 异常）时回退 unknown，避免误报「已放行」。
    Some(parse_inbound_allow(&text, &port_str))
}

/// 解析 netsh 规则列表，判断是否存在「入站 + 允许 + TCP + 本地端口==port」的规则。
#[cfg(windows)]
fn parse_inbound_allow(text: &str, port: &str) -> bool {
    for block in text.split("\n\n") {
        let mut direction = String::new();
        let mut action = String::new();
        let mut proto = String::new();
        let mut localport = String::new();
        for line in block.lines() {
            if let Some((k, v)) = split_kv(line) {
                match k.as_str() {
                    "方向" => direction = v,
                    "操作" => action = v,
                    "协议" => proto = v,
                    "本地端口" => localport = v,
                    _ => {}
                }
            }
        }
        let dir_ok = direction.contains("入站") || direction.to_lowercase().contains("in");
        let act_ok = action.contains("允许") || action.to_lowercase().contains("allow");
        let proto_ok = proto.is_empty() || proto.to_uppercase().contains("TCP");
        let port_ok = localport == port || localport.split(',').any(|p| p.trim() == port);
        if dir_ok && act_ok && proto_ok && port_ok {
            return true;
        }
    }
    false
}

/// 按首个冒号（ASCII 或全角）切分 "键: 值"，返回 (键, 去空格值)。
#[cfg(windows)]
fn split_kv(line: &str) -> Option<(String, String)> {
    let idx = line.find(':')?;
    let key = line[..idx].trim().to_string();
    let val = line[idx + 1..].trim().to_string();
    if key.is_empty() {
        return None;
    }
    Some((key, val))
}

/// 通过 PowerShell 的 `Start-Process -Verb RunAs` 触发 UAC 提权执行 netsh，
/// 写入 7823/TCP 入站允许规则。`-Wait` 等待提权进程结束（用户取消则非 0 退出）。
///
/// 不引入任何 Rust 依赖——复用系统 netsh + PowerShell，零二进制体积增加（守规则8）。
/// 用单引号 here-string 包裹参数，避免路径中的空格/反斜杠被 PowerShell 二次解析。
pub fn elevate_netsh(params: &str) -> Result<(), String> {
    let ps = format!(
        "Start-Process -FilePath netsh.exe -ArgumentList @'`n{params}`n'@ -Verb RunAs -Wait",
    );
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .output()
        .map_err(|e| format!("启动提权失败: {e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        let msg = msg.trim();
        if msg.is_empty() {
            return Err("开放防火墙端口被取消或未授权".into());
        }
        return Err(format!("开放防火墙端口失败：{msg}"));
    }
    Ok(())
}
