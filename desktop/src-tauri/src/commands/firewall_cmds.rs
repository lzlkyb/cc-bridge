//! 防火墙相关的 IPC 命令：刷新状态缓存、一键放行、诊断。
//!
//! D19 方案 C 第 3 批。**为何叫 `firewall_cmds` 而不是 `firewall`**：`crate::firewall`
//! 与 `crate::firewall_diag`（`src/firewall.rs` / `src/firewall_diag.rs`）都已存在，
//! 子模块同名会冲突——与第 2 批 `backup_cmds` 同一个理由。
//!
//! 这三个命令是 **Windows 专属能力**，但函数本身不带 `cfg`：平台差异在
//! `crate::firewall` / `firewall_diag` 内部处理，前端则按 `platform` 字段隐藏整张卡片
//! （见清单 N4）。所以这里搬动时无需关心 cfg 分支。
//!
//! 本文件是**纯搬动**：函数体逐字节未改，可用 `tools/fingerprint.py` 比对哈希验证。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

/// 手动/定点刷新防火墙状态缓存（前端「重新检查」按钮调用）。
/// 立即重跑 netsh 查询并回写缓存，下次 get_status 即返回最新结果。
#[tauri::command]
pub async fn refresh_firewall(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let port = state.config.read().await.port;
    crate::firewall::refresh_cache(&state, port).await;
    Ok(())
}

/// 一键开放 / 修复防火墙规则（仅 Windows 有意义）。
///
/// 与旧版的差异在于它不只「加一条规则」，而是一次 UAC 授权内完成：
/// 1. 删除旧版固定名规则与同名旧规则（幂等，不再重复堆积）；
/// 2. 删除上次诊断识别出的阻止规则（Block 优先于 Allow，不删就永远不通）
///    与指向旧安装路径的废规则（会让状态检测假绿）；
/// 3. 写入带 `profile=any enable=yes` 的正确规则——旧版省略 profile，实测只落到
///    Public，当前网络是域/专用时规则完全不生效，这是「必须关防火墙才能用」的根因。
///
/// 仍不引入任何 Rust 依赖（守规则8）：复用系统 netsh + PowerShell。
#[tauri::command]
pub async fn open_firewall_port(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let port = state.config.read().await.port;
        let exe = std::env::current_exe()
            .map_err(|e| format!("无法定位自身路径: {e}"))?
            .to_string_lossy()
            .into_owned();
        // 清理清单取自最近一次诊断。诊断还没跑过（刚启动）时清单为空，
        // 仅做「删旧同名 + 写新规则」，仍然是幂等的。
        let remove = state
            .firewall_cache
            .lock()
            .unwrap()
            .diagnosis
            .as_ref()
            .map(|d| d.removable_rule_names())
            .unwrap_or_default();
        let script = crate::firewall_diag::build_repair_script(port, &exe, &remove);
        // 提权过程可能长时间挂起（用户未处理 UAC 弹窗），放到阻塞线程避免占用 async 工作线程
        let res = tauri::async_runtime::spawn_blocking(move || {
            crate::firewall::elevate_cmd_script(&script)
        })
        .await
        .map_err(|e| format!("开放防火墙端口任务异常: {e}"))?;
        res?;
        crate::firewall::refresh_cache(&state, port).await;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = &state;
        Ok(())
    }
}

/// 防火墙诊断回传体。前端「防火墙」卡片/告警块据此渲染具体原因与可用动作。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallDiagnosisResponse {
    /// 结构化诊断；None = 尚未完成首次检查（前端显示「检测中」）。
    pub diagnosis: Option<crate::firewall_diag::FirewallDiagnosis>,
    /// 探测能力是否可用（PowerShell 与 netsh 都不可用时为 false，只能给手动命令）。
    pub available: bool,
    /// 等价手动命令（管理员终端执行），已带 profile=any。
    pub manual_command: String,
    /// 我们写入的规则名，便于用户在「高级安全 Windows Defender 防火墙」里自查。
    pub rule_name: String,
    /// 距上次检查的秒数；None = 尚未检查过。
    pub checked_seconds_ago: Option<u64>,
}

/// 读取缓存的防火墙诊断（不触发查询，要重查请先调 `refresh_firewall`）。
#[tauri::command]
pub async fn get_firewall_diagnosis(
    state: State<'_, Arc<AppState>>,
) -> Result<FirewallDiagnosisResponse, String> {
    let port = state.config.read().await.port;
    let available = *state.firewall_available.lock().unwrap();
    let (diagnosis, checked_seconds_ago) = {
        let cache = state.firewall_cache.lock().unwrap();
        (
            cache.diagnosis.clone(),
            cache.checked_at.map(|t| t.elapsed().as_secs()),
        )
    };
    let exe = std::env::current_exe()
        .map_err(|e| format!("无法定位自身路径: {e}"))?
        .to_string_lossy()
        .into_owned();
    Ok(FirewallDiagnosisResponse {
        diagnosis,
        available,
        manual_command: crate::firewall_diag::manual_command(port, &exe),
        rule_name: crate::firewall_diag::rule_name(port),
        checked_seconds_ago,
    })
}
