//! MCP 服务生命周期与网络相关的 IPC 命令：启停/重启服务、LAN 地址列举、
//! 选定出口 IP、重探 bash，以及全盘目录浏览。
//!
//! D19 方案 C 第 4 批。`browse_directory` 严格说不属于「服务生命周期」，但它在原文件里
//! 就紧邻这一组，且同样是「不碰配置、只读系统状态」的轻量命令，故一并放此，保持原顺序。
//! 注意它**不受白名单限制**（供目录选择器用），这一点在 `crate::browse` 里有说明。
//!
//! 本文件是**纯搬动**：函数体逐字节未改。

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::browse;
use crate::config::save_config_field;
use crate::network;
use crate::state::AppState;

#[tauri::command]
pub async fn browse_directory(path: Option<String>) -> Result<browse::BrowseResult, String> {
    browse::browse_directory(path.as_deref()).await
}

#[tauri::command]
pub async fn restart_mcp_server(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    crate::mcp::http::restart_server(state.inner()).await;
    Ok(())
}

/// 停止 MCP 服务：abort 监听任务并释放端口。UI 显示「已停止」。
#[tauri::command]
pub async fn stop_mcp_server(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    let mut handle = state.mcp_server_handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
    }
    // 立即置停止态，不必等 serve 协程感知 abort（其也会置 false，幂等）。
    state
        .mcp_running
        .store(false, std::sync::atomic::Ordering::Relaxed);
    // 即时通知托盘刷新图标/tooltip
    let _ = app.emit("mcp-status-changed", ());
    Ok(())
}

/// 启动（或重启）MCP 服务。若已在运行先 abort 旧任务，避免端口占用。
#[tauri::command]
pub async fn start_mcp_server(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    crate::mcp::http::restart_server(state.inner()).await;

    // 乐观置运行态并即时通知托盘（serve 失败会在 http.rs 回退 false）
    state
        .mcp_running
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit("mcp-status-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn get_lan_ips() -> Result<Vec<String>, String> {
    Ok(network::get_lan_ips())
}

/// 单个本机网卡地址对 port 的 TCP 连通探测结论。
/// state 三态诚实兜底：ok / fail / unknown（unknown 不谎报通或不通）。
#[derive(Debug, Serialize)]
pub struct LanProbeResult {
    pub ip: String,
    pub state: String,
    /// 探测耗时（毫秒），前端 IP 卡 hover title 展示。
    pub ms: u64,
}

/// 评审修复 ④：对本机每个网卡 IPv4 的 `port` 做 TCP 连通探测（800ms 超时，并发执行）。
///
/// 「占位即算通」——TCP 能建立就说明该地址的桥端口可达，无需真发 HTTP。
/// **目标仅限本机网卡地址**（`network::get_lan_ips`），不新增任何外部连接面。
///
/// 三态语义：ok = 端口可达；fail = 明确被拒（RST，如服务未监听该地址）；
/// unknown = 超时或其它错误（如宿主机防火墙拦本机自连）——诚实返回未知，
/// 前端据此退回「默认」推荐而不是瞎猜。结果顺序与 get_lan_ips 一致。
#[tauri::command]
pub async fn probe_lan_ips(port: u16) -> Result<Vec<LanProbeResult>, String> {
    let ips = network::get_lan_ips();
    let tasks: Vec<_> = ips
        .into_iter()
        .map(|ip| {
            tokio::spawn(async move {
                let started = Instant::now();
                let state = match timeout(
                    Duration::from_millis(800),
                    TcpStream::connect((ip.as_str(), port)),
                )
                .await
                {
                    Ok(Ok(_)) => "ok",
                    Ok(Err(_)) => "fail",
                    Err(_) => "unknown",
                };
                LanProbeResult {
                    ip,
                    state: state.to_string(),
                    ms: started.elapsed().as_millis() as u64,
                }
            })
        })
        .collect();
    // 按提交顺序收集，保持与 get_lan_ips 相同的排列（默认路由网卡第一）。
    let mut out = Vec::new();
    for t in tasks {
        // join 失败（探测任务 panic）极少见：跳过该条，不让单点异常拖垮整次探测。
        if let Ok(r) = t.await {
            out.push(r);
        }
    }
    Ok(out)
}

/// 强制重新探测 Git Bash（供设置页「刷新检测」按钮调用）。
/// 返回是否检测到 bash.exe。
#[tauri::command]
pub async fn refresh_bash_detection() -> Result<bool, String> {
    Ok(crate::mcp::tools::shell::refresh_bash_detection().is_some())
}

/// 用户在 Connect 页选中（或自动默认选中，或点击变更提示 banner 的"标记已处理"）时落盘，
/// 作为下次判断"地址是否变化"的基线。
#[tauri::command]
pub async fn set_selected_ip(state: State<'_, Arc<AppState>>, ip: String) -> Result<(), String> {
    let db = state.db.lock().await;
    save_config_field(&db, "last_selected_ip", &serde_json::to_value(&ip).unwrap())?;
    let mut config = state.config.write().await;
    config.last_selected_ip = Some(ip);
    Ok(())
}
