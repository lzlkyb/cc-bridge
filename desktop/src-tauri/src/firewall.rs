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

/// 完整查询：只采信结构化诊断（PowerShell 的 NetSecurity cmdlet）。
///
/// 🔴 为什么不再用 netsh 文本解析兜底（2026-10-20）：那份解析只能看到
/// 「方向 / 操作 / 协议 / 本地端口」，看不到 `Program` / `Profiles` / `Enabled`。
/// 于是一条 `program=` 指向不存在文件的废规则（安装器写错 exe 名的典型产物）会被
/// 判成「已放行」，而结构化诊断判它未放行 —— 连接页链路图与告警块各说一套，
/// 而绿色的那个是错的。用户看到「防火墙已放行」却连不上，正是这个假绿。
///
/// 拿不到结构化事实时**不给结论**（`port_open = None`），前端显示「无法检测」。
/// 宁可不说话，也不谎报放行。
pub fn query_full(port: u16) -> FirewallDiagnosis {
    let exe = current_exe_string();
    if let Some(d) = firewall_diag::query_diagnosis(port, &exe) {
        return d;
    }
    // 防火墙开关本身可以安全读取（只读 allprofiles state，不做规则匹配），保留它对用户
    // 仍有信息量；端口是否放行则必须是 unknown —— 没有规则明细就没资格下这个结论。
    #[cfg(windows)]
    let enabled = query_firewall_enabled();
    #[cfg(not(windows))]
    let enabled = None;
    FirewallDiagnosis {
        port,
        exe,
        enabled,
        port_open: None,
        issues: vec![Issue {
            code: "probeUnavailable".into(),
            detail: format!(
                "无法读取 {port}/TCP 的规则明细（结构化诊断不可用），因此不判断是否已放行。\
                 可在下方复制手动命令到管理员终端核对，或直接点「一键修复」。"
            ),
            fixable: false,
        }],
        source: "unavailable".into(),
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
