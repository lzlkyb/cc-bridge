use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::firewall_diag::{self, FirewallDiagnosis, Issue};
use crate::state::AppState;

/// 子进程无控制台窗口标志（Windows）。仅去掉 netsh/powershell 子进程闪一下的黑框，
/// 不影响标准 I/O（我们仍读 stdout）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 防火墙状态查询结果：(防火墙是否启用, 7823 入站是否放行)。
/// 两者均为 `Option<bool>`：`None` 表示「无法判断」（非 Windows 平台 / 查询命令失败 / 解析失败）。
pub type FirewallState = (Option<bool>, Option<bool>);

#[cfg(windows)]
pub fn query_firewall_state(port: u16) -> FirewallState {
    let enabled = query_firewall_enabled();
    // 防火墙已确认关闭 → 端口必然可达，跳过规则枚举（关了任何规则都不挡）。
    // 否则才去 netsh 枚举全部规则判断放行与否——这一步在关闭场景完全多余。
    let port_open = if enabled == Some(false) {
        Some(true)
    } else {
        query_port_allowed(port)
    };
    (enabled, port_open)
}

#[cfg(not(windows))]
pub fn query_firewall_state(_port: u16) -> FirewallState {
    (None, None)
}

/// 抑制子进程（如 netsh）初始化失败时的「应用程序错误」硬弹窗（0xc0000142）。
///
/// `0xc0000142` 是 `netsh.exe` 在**进程创建 / DLL 初始化阶段**就崩了，该错误框由 Windows
/// 在子进程层面弹出，早于父进程拿到 `.output()` 的失败结果，因此 `try/catch` 兜不住。
/// 必须在 spawn 任何 netsh **之前**于主进程调用一次 `SetErrorMode`：错误模式会被其后创建的
/// 子进程继承，Windows 不再为子进程的初始化失败弹窗，而是让进程静默失败（父进程拿到错误）。
/// 这是消除「netsh 损坏时反复弹应用程序错误」的直接手段，零额外依赖。
#[cfg(windows)]
pub fn suppress_child_error_dialogs() {
    extern "system" {
        fn SetErrorMode(u_mode: u32) -> u32;
    }
    const SEM_FAILCRITICALERRORS: u32 = 0x0001;
    const SEM_NOGPFAULTERRORBOX: u32 = 0x0002;
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    }
}

/// 启动探测：跑一次 `netsh advfirewall show allprofiles state`，判断系统 netsh 是否可用。
///
/// 返回 `false` 表示 netsh 进程启动即崩 / 退出非 0（典型即 `0xc0000142` 损坏场景）。
/// 不可用时由调用方把 `AppState.firewall_available` 置 `false`，此后停止后台与手动查询，
/// 避免 netsh 损坏时反复 spawn 失败进程、且不再触发弹窗。
#[cfg(windows)]
pub fn probe_netsh_available() -> bool {
    Command::new("netsh")
        .args(["advfirewall", "show", "allprofiles", "state"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 当前可执行文件路径（规则 `program=` 的比对基准）。取不到时返回空串，
/// 此时诊断会把所有带 program= 的规则当成「不匹配」，宁可多报不漏报。
pub fn current_exe_string() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 完整查询：优先 PowerShell 结构化诊断，不可用时回退 netsh 文本解析。
///
/// 回退路径只能得到粗粒度结论（有没有一条命中端口的 allow 规则），拿不到配置文件覆盖
/// 与阻止规则信息，因此 `source` 会标为 `netsh`，前端据此提示「诊断能力受限」。
pub fn query_full(port: u16) -> FirewallDiagnosis {
    let exe = current_exe_string();
    if let Some(d) = firewall_diag::query_diagnosis(port, &exe) {
        return d;
    }
    let (enabled, port_open) = query_firewall_state(port);
    let mut issues: Vec<Issue> = Vec::new();
    let source = if enabled.is_none() && port_open.is_none() {
        issues.push(Issue {
            code: "probeUnavailable".into(),
            detail: "无法读取本机防火墙状态（PowerShell 与 netsh 均不可用）。请用下方手动命令在管理员终端自行添加规则。".into(),
            fixable: false,
        });
        "unavailable"
    } else {
        if port_open == Some(false) {
            issues.push(Issue {
                code: "noRule".into(),
                detail: format!("未找到放行 {port}/TCP 入站的规则。"),
                fixable: true,
            });
        }
        "netsh"
    };
    FirewallDiagnosis {
        port,
        exe,
        enabled,
        port_open,
        issues,
        source: source.into(),
        ..Default::default()
    }
}

/// 后台定时（每 5 分钟）与按需（修复成功后 / 前端「重新检查」）刷新缓存。
/// 探测不可用（启动探测失败）时跳过查询，保持 unknown（不再 spawn 失败进程、不再弹窗）。
pub async fn refresh_cache(state: &Arc<AppState>, port: u16) {
    if !*state.firewall_available.lock().unwrap() {
        // 探测不可用：仅刷新时间戳（避免每 5 分钟都重判），状态保留为 unknown。
        let mut cache = state.firewall_cache.lock().unwrap();
        cache.checked_at = Some(Instant::now());
        return;
    }
    // PowerShell 冷启动 + 三次全量规则查询约 1s，放到阻塞线程，不占用 async 工作线程。
    let diag = tauri::async_runtime::spawn_blocking(move || query_full(port))
        .await
        .ok();
    let mut cache = state.firewall_cache.lock().unwrap();
    if let Some(d) = diag {
        cache.enabled = d.enabled;
        cache.port_open = d.port_open;
        cache.diagnosis = Some(d);
    }
    cache.checked_at = Some(Instant::now());
}

#[cfg(windows)]
fn query_firewall_enabled() -> Option<bool> {
    // 普通权限即可读取（无需管理员），实测 Windows 家庭版/专业版均可。
    let out = Command::new("netsh")
        .args(["advfirewall", "show", "allprofiles", "state"])
        .creation_flags(CREATE_NO_WINDOW)
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
        .creation_flags(CREATE_NO_WINDOW)
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
    // Windows netsh 输出为 CRLF（\r\n\r\n）换行，先规整为 LF 再按空行分块，
    // 否则 split("\n\n") 在 CRLF 下不分割、所有规则混为一 block、字段被覆盖。
    let text = text.replace("\r\n", "\n");
    for block in text.split("\n\n") {
        let mut direction = String::new();
        let mut action = String::new();
        let mut proto = String::new();
        let mut localport = String::new();
        for line in block.lines() {
            if let Some((k, v)) = split_kv(line) {
                // 同时兑配中文与英文 netsh 键名（英文系统上为 Direction/Action/Protocol/Local Port，
                // 旧实现只匹配中文键名，英文 locale 下所有字段解不出来、恒判“未放行”）。
                let kn = k.to_lowercase().replace(' ', "");
                match k.as_str() {
                    "方向" => direction = v,
                    "操作" => action = v,
                    "协议" => proto = v,
                    "本地端口" => localport = v,
                    _ => match kn.as_str() {
                        "direction" => direction = v,
                        "action" => action = v,
                        "protocol" => proto = v,
                        "localport" => localport = v,
                        _ => {}
                    },
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

/// 启动探测：只要 PowerShell 或 netsh 有一个能用，防火墙功能就可用。
/// 两者都不可用才把 `firewall_available` 置 false（停用后续查询）。
#[cfg(windows)]
pub fn probe_available() -> bool {
    firewall_diag::probe_powershell_available() || probe_netsh_available()
}

/// 提权执行一段批处理脚本（一次 UAC 弹窗完成全部 netsh 动作）。
///
/// 为什么不直接提权单条 netsh：修复需要「先删旧规则再建新规则」多个步骤，
/// 逐条提权会让用户连续点好几次 UAC。写成一个临时 .cmd 只需一次授权。
///
/// 路径通过环境变量传给 PowerShell 并在 PS 内部拼引号，避开了旧实现那种
/// `@'`n...`n'@` here-string 写法：单引号 here-string 要求 `@'` 后紧跟真正的换行，
/// 字面 `` `n `` 不会被当换行处理，在部分环境下会直接报解析错误。
/// `-WindowStyle Hidden` 避免提权 cmd 闪黑框；`-PassThru` + `exit $p.ExitCode`
/// 把真实退出码带回来，因此「修复成功」的判据是 netsh add rule 真的成功了。
pub fn elevate_cmd_script(script: &str) -> Result<(), String> {
    let path = std::env::temp_dir().join(format!("cc-bridge-fw-fix-{}.cmd", std::process::id()));
    std::fs::write(&path, script).map_err(|e| format!("写入修复脚本失败：{e}"))?;

    let ps = "$ErrorActionPreference='Stop'; \
         $arg = '/c \"' + $env:CCB_FIX_SCRIPT + '\"'; \
         $p = Start-Process -FilePath cmd.exe -ArgumentList $arg -Verb RunAs -Wait -PassThru -WindowStyle Hidden; \
         exit $p.ExitCode";
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", ps])
        .env("CCB_FIX_SCRIPT", &path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| format!("启动提权失败：{e}"));
    let _ = std::fs::remove_file(&path);
    let out = out?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        let msg = msg.trim();
        if msg.is_empty() {
            return Err("写入防火墙规则被取消或未授权".into());
        }
        return Err(format!("写入防火墙规则失败：{msg}"));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn parse_inbound_allow_recognizes_crlf_multi_rule() {
        // Windows netsh 输出为 CRLF；多个规则以 \r\n\r\n 分隔。
        // 修复前 split("\n\n") 在 CRLF 下不分割 → 多规则字段互相覆盖 → 误判“未放行”。
        let text = "规则名称: rule-allow\r\n方向: 入站\r\n操作: 允许\r\n协议: TCP\r\n本地端口: 7823\r\n\r\n规则名称: rule-other\r\n方向: 入站\r\n操作: 允许\r\n协议: TCP\r\n本地端口: 9999";
        assert!(
            parse_inbound_allow(text, "7823"),
            "CRLF 多规则下应识别放行规则"
        );
    }

    #[test]
    fn parse_inbound_allow_crlf_no_match() {
        let text =
            "规则名称: rule-allow\r\n方向: 入站\r\n操作: 允许\r\n协议: TCP\r\n本地端口: 9999";
        assert!(!parse_inbound_allow(text, "7823"), "端口不匹配应判未放行");
    }
}
