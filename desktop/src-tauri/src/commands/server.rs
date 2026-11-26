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
pub async fn browse_directory(
    path: Option<String>,
    // @引用补全面板要文件；目录选择器（DirectoryBrowser 等）不传，行为不变。
    include_files: Option<bool>,
) -> Result<browse::BrowseResult, String> {
    tokio::task::spawn_blocking(move || {
        browse::browse_directory(path.as_deref(), include_files.unwrap_or(false))
    })
    .await
    .map_err(|error| format!("目录读取任务失败：{error}"))?
}

#[tauri::command]
pub async fn restart_mcp_server(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    super::control_service(state.inner(), &app, "restart").await
}

/// 停止 MCP 服务：abort 监听任务并释放端口。UI 显示「已停止」。
#[tauri::command]
pub async fn stop_mcp_server(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    super::control_service(state.inner(), &app, "stop").await
}

/// 启动（或重启）MCP 服务。若已在运行先 abort 旧任务，避免端口占用。
#[tauri::command]
pub async fn start_mcp_server(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    super::control_service(state.inner(), &app, "start").await
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
    let mut config = state.config.write().await;
    // Hidden direct-IP UI effects must not acknowledge an address while tunnel mode is selected.
    if crate::connection_access::uses_tunnel(&config) {
        return Err("当前使用隧道连接，无需更改直连地址。".into());
    }
    if !state.cached_lan_ips().contains(&ip) && ip != config.host {
        return Err("该地址已不在本机网卡中，请刷新后重新选择。".into());
    }
    save_config_field(&db, "last_selected_ip", &serde_json::to_value(&ip).unwrap())?;
    config.last_selected_ip = Some(ip);
    Ok(())
}

/// 「IP 替换命令」的生成结果（前端自行写剪贴板，本命令只读不写，保持可测）。
#[derive(Debug, Serialize)]
pub struct IpSedCommandResult {
    /// 通用 MCP 工具无约定路径时为空串——调用方给「手动更新」提示。
    pub cmd: String,
    #[serde(rename = "scopeLabel")]
    pub scope_label: String,
}

/// 原地更新接入的命令（2026-10-17）：托盘「复制IP替换命令」的同源只读版，
/// 生成逻辑单一真源在 `network::ip_update_command`。供前端任意页入口（S3 横幅 /
/// 命令面板）复用——两处此前只能让托盘能复制，关掉 banner 后用户无处拿命令。
/// 多设备模式（opt-in）开启时产物自动换条目级命令（同一真源内分流）。
#[tauri::command]
pub async fn get_ip_sed_command(
    state: State<'_, Arc<AppState>>,
) -> Result<IpSedCommandResult, String> {
    let cfg = state.config.read().await;
    let (cmd, scope_label) =
        crate::connection_access::ip_update_command(&cfg, &state.cached_lan_ips())?;
    Ok(IpSedCommandResult { cmd, scope_label })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCopy {
    pub text: String,
    pub target_key: String,
}

/// All shortcut copies are resolved against the current saved target at the moment of copying.
#[tauri::command]
pub async fn get_connection_copy(
    state: State<'_, Arc<AppState>>,
    kind: String,
) -> Result<ConnectionCopy, String> {
    resolve_connection_copy(&state, &kind).await
}

pub async fn resolve_connection_copy(
    state: &AppState,
    kind: &str,
) -> Result<ConnectionCopy, String> {
    let config = state.config.read().await;
    let ips = state.cached_lan_ips();
    let access = crate::connection_access::summary_with_client(
        &config,
        &super::stable_connect_cmds::stable_records(&config, state),
        &ips,
        state.mcp_running.load(std::sync::atomic::Ordering::Relaxed),
        crate::connection_access::cached_local_probe(state, &config, &ips),
        None,
        crate::connection_access::firewall_blocked(state),
        state.client_hit().filter(|h| h.loopback).map(|h| h.at_ms),
    );
    let text = match kind {
        "address" if access.can_copy_address => access.address,
        "command" if access.can_copy_command => {
            crate::connection_access::connect_command(&config, &ips)?
        }
        "ip-update" | "token-update" => {
            crate::connection_access::ip_update_command(&config, &ips)?.0
        }
        _ => return Err("当前接入尚未配置，请前往接入卡片。".into()),
    };
    Ok(ConnectionCopy {
        text,
        target_key: access.target_key,
    })
}

#[tauri::command]
pub fn take_connection_navigation(state: State<'_, Arc<AppState>>) -> bool {
    state
        .pending_connection_navigation
        .swap(false, std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
pub async fn connection_command_copied(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    target_key: String,
) -> Result<(), String> {
    record_connection_copy(&state, &app, &target_key).await
}

#[tauri::command]
pub async fn connection_update_copied(
    state: State<'_, Arc<AppState>>,
    target_key: String,
) -> Result<(), String> {
    record_direct_update(&state, &target_key, false).await
}

#[tauri::command]
pub async fn confirm_connection_update(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    target_key: String,
) -> Result<(), String> {
    record_direct_update(&state, &target_key, true).await?;
    let _ = app.emit("stable_connect_changed", ());
    Ok(())
}

pub async fn record_direct_update(
    state: &AppState,
    target_key: &str,
    confirmed: bool,
) -> Result<(), String> {
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    let ips = state.cached_lan_ips();
    let Some(receipt) =
        crate::connection_access::update_direct_receipt(&config, &ips, target_key, confirmed)?
    else {
        return if confirmed {
            Err("没有可确认的原有直连接入。".into())
        } else {
            Ok(())
        };
    };
    let mut next = config.stable_connect.clone();
    next.direct = Some(receipt);
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    save_config_field(
        &tx,
        "stable_connect",
        &serde_json::to_value(&next).map_err(|e| e.to_string())?,
    )?;
    let selected_ip = (confirmed && config.host == "0.0.0.0")
        .then(|| {
            crate::network::resolve_display_host(
                &config.host,
                &ips,
                config.last_selected_ip.as_deref(),
            )
        })
        .filter(|ip| ips.contains(ip));
    if let Some(ip) = &selected_ip {
        save_config_field(&tx, "last_selected_ip", &serde_json::json!(ip))?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    config.stable_connect = next;
    if let Some(ip) = selected_ip {
        config.last_selected_ip = Some(ip);
    }
    Ok(())
}

pub async fn record_connection_copy(
    state: &AppState,
    app: &AppHandle,
    target_key: &str,
) -> Result<(), String> {
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    if crate::connection_access::uses_tunnel(&config) {
        return Ok(());
    }
    let receipt = crate::connection_access::direct_access(&config, &state.cached_lan_ips());
    if receipt.fingerprint != target_key {
        return Ok(());
    }
    let mut next = config.stable_connect.clone();
    next.direct = Some(receipt);
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    save_config_field(
        &tx,
        "stable_connect",
        &serde_json::to_value(&next).map_err(|e| e.to_string())?,
    )?;
    save_config_field(&tx, "has_onboarded", &serde_json::json!(true))?;
    if config.scope.is_none() {
        save_config_field(
            &tx,
            "scope",
            &serde_json::to_value(next.direct.as_ref().unwrap().scope.clone())
                .map_err(|e| e.to_string())?,
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    config.stable_connect = next;
    if config.scope.is_none() {
        config.scope = config
            .stable_connect
            .direct
            .as_ref()
            .map(|r| r.scope.clone());
    }
    config.has_onboarded = true;
    let _ = app.emit("stable_connect_changed", ());
    Ok(())
}
