use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use similar::TextDiff;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::audit;
use crate::backup;
use crate::browse;
use crate::config::save_config_field;
use crate::network;
use crate::security::auth;
use crate::security::path;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub version: String,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: u64,
    #[serde(rename = "allowedRoots")]
    pub allowed_roots: Vec<String>,
    #[serde(rename = "allowedExtensions")]
    pub allowed_extensions: Vec<String>,
    #[serde(rename = "maxFileSizeBytes")]
    pub max_file_size_bytes: u64,
    #[serde(rename = "rateLimit")]
    pub rate_limit: RateLimitInfo,
    #[serde(rename = "backupDir")]
    pub backup_dir: String,
    #[serde(rename = "backupDirAbs")]
    pub backup_dir_abs: String,
    #[serde(rename = "backupCount")]
    pub backup_count: u32,
    #[serde(rename = "backupTotalBytes")]
    pub backup_total_bytes: u64,
    #[serde(rename = "backupRetention")]
    pub backup_retention: u32,
    #[serde(rename = "auditRetentionDays")]
    pub audit_retention_days: u32,
    /// 后台命令结束后保留时长（秒），默认 120（2 分钟），可配置。
    #[serde(rename = "commandCleanupSecs")]
    pub command_cleanup_secs: u64,
    pub host: String,
    pub port: u16,
    pub stats: StatsInfo,
    #[serde(rename = "connectCommand")]
    pub connect_command: String,
    pub token: String,
    // ── 功能开关 + 运行状态（v2.1）──
    #[serde(rename = "whitelistEnabled")]
    pub whitelist_enabled: bool,
    #[serde(rename = "readonlyMode")]
    pub readonly_mode: bool,
    #[serde(rename = "backupEnabled")]
    pub backup_enabled: bool,
    #[serde(rename = "auditEnabled")]
    pub audit_enabled: bool,
    #[serde(rename = "rateLimitEnabled")]
    pub rate_limit_enabled: bool,
    #[serde(rename = "encodingDetectEnabled")]
    pub encoding_detect_enabled: bool,
    #[serde(rename = "shellEnabled")]
    pub shell_enabled: bool,
    /// 命令执行壳层：cmd（默认）或 bash（Git Bash）。前端「命令执行壳层」分段控件读写。
    #[serde(rename = "shellType")]
    pub shell_type: String,
    /// MCP 传输协议：http（默认）或 sse。设置页「MCP 传输协议」分段控件读写。
    pub transport: String,
    /// 本机是否检测到 Git Bash（bash.exe）。false 时前端「命令执行壳层」的 bash 选项置灰，
    /// 点击不保存并提示用户先安装 Git for Windows。
    #[serde(rename = "bashAvailable")]
    pub bash_available: bool,
    pub running: bool,
    // ── 本机地址变更检测 ──
    #[serde(rename = "lanIps")]
    pub lan_ips: Vec<String>,
    #[serde(rename = "lastSelectedIp")]
    pub last_selected_ip: Option<String>,
    #[serde(rename = "ipChanged")]
    pub ip_changed: bool,
    /// S1: 远程链路可达性探针。对「远程客户端应当连接的展示地址:port」做 TCP 探测
    /// （超时 200ms）。running 为 false 时直接 false（服务都没跑，谈不上可达）。
    /// 这是「远程连接中断」状态机的真实信号源，区别于 ip_changed（仅文本地址变化）。
    #[serde(rename = "remoteReachable")]
    pub remote_reachable: bool,
    /// 用户上次接入确认的作用域（user/project），由首次接入复制命令时落盘。
    /// IP 变化 banner / Token 重生成据此生成精确 sed 命令。None 表示旧数据未记录。
    #[serde(rename = "scope")]
    pub scope: Option<String>,
    /// A3 修复：启动期错误（如端口被占用）。None 表示启动正常。
    #[serde(rename = "startupError")]
    pub startup_error: Option<String>,
    /// 防火墙状态（仅 Windows 真实查询，其它平台为 None）。
    /// firewall_enabled：防火墙是否开启（任一配置文件启用即 true）。
    /// firewall_port_open：7823/TCP 入站是否被放行（存在 allow 规则即 true）。
    /// 两者均为 None 表示无法判断（非 Windows / 查询失败 / netsh 不可用）。
    /// 这是「远程未确认连接」状态机的信号源——诚实暴露本机探针对远程入站拦截的盲点。
    #[serde(rename = "firewallEnabled")]
    pub firewall_enabled: Option<bool>,
    #[serde(rename = "firewallPortOpen")]
    pub firewall_port_open: Option<bool>,
    /// 系统 netsh 是否可用（仅 Windows 有意义）。Some(true)=可用；Some(false)=netsh 异常
    /// （已停用查询，状态恒为 unknown）；None=非 Windows。前端据此在 netsh 损坏时给出温和
    /// 提示，而非让用户反复看到「应用程序错误」弹窗。
    #[serde(rename = "firewallAvailable")]
    pub firewall_available: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct RateLimitInfo {
    #[serde(rename = "maxRequests")]
    pub max_requests: u32,
    #[serde(rename = "windowMs")]
    pub window_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct StatsInfo {
    #[serde(rename = "totalRequests")]
    pub total_requests: u64,
    #[serde(rename = "totalErrors")]
    pub total_errors: u64,
    /// 实时成功率（%），累计 = (total-errors)/total*100。
    #[serde(rename = "successRate")]
    pub success_rate: f64,
    /// 请求速率（近 60s 窗口内请求数）。
    #[serde(rename = "requestsPerMin")]
    pub requests_per_min: u64,
    /// 平均耗时（ms），累计和/计数。
    #[serde(rename = "avgLatencyMs")]
    pub avg_latency_ms: u64,
    /// P95 耗时（ms），最近样本环形缓冲分位。
    #[serde(rename = "p95LatencyMs")]
    pub p95_latency_ms: u64,
    /// 限流命中次数（429）。
    #[serde(rename = "rateLimitHits")]
    pub rate_limit_hits: u64,
    /// 鉴权拒绝次数（401）。
    #[serde(rename = "authDenies")]
    pub auth_denies: u64,
    /// 审计落盘条数。
    #[serde(rename = "auditCount")]
    pub audit_count: u64,
    /// 当前活跃后台命令数（exit_code 仍为 None）。
    #[serde(rename = "activeCommands")]
    pub active_commands: u64,
    /// 热门工具 Top3（按累计调用次数降序）。
    #[serde(rename = "topTools")]
    pub top_tools: Vec<ToolCount>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ToolCount {
    pub name: String,
    #[serde(rename = "count")]
    pub count: u64,
}

#[tauri::command]
pub async fn get_status(state: State<'_, Arc<AppState>>) -> Result<StatusResponse, String> {
    let config = state.config.read().await;
    let stats = state.stats.read().await;
    let uptime = state.uptime_seconds().await;
    let running = state.mcp_running.load(std::sync::atomic::Ordering::Relaxed);
    let startup_error = state.startup_error.lock().unwrap().clone();
    let lan_ips = state.cached_lan_ips();

    // 防火墙状态：优先读缓存（后台定时刷新）。缓存尚未初始化时做一次同步查询，
    // 保证首屏即可拿到真实状态，避免前几次轮询都返回 unknown。
    // netsh 不可用时（启动探测失败）跳过查询，状态保持 unknown（不再弹窗 / 反复 spawn）。
    let (firewall_enabled, firewall_port_open) = {
        let mut cache = state.firewall_cache.lock().unwrap();
        if cache.checked_at.is_none() {
            #[cfg(windows)]
            let available = *state.firewall_available.lock().unwrap();
            #[cfg(not(windows))]
            let available = true;
            if available {
                let (e, p) = crate::firewall::query_firewall_state(config.port);
                cache.enabled = e;
                cache.port_open = p;
            }
            cache.checked_at = Some(Instant::now());
        }
        (cache.enabled, cache.port_open)
    };
    // netsh 可用性：仅 Windows 有意义（非 Windows 为 None）。
    let firewall_available: Option<bool> = {
        #[cfg(windows)]
        {
            Some(*state.firewall_available.lock().unwrap())
        }
        #[cfg(not(windows))]
        {
            None
        }
    };
    // 地址变化检测:
    // 1) 监听全部网卡时,以用户上次确认的 IP 是否仍在网卡列表为准;
    // 2) 指定具体 host(非 127.0.0.1 本地回环)且该地址已不在网卡列表,也视为变化(O4)。
    let ip_changed = config
        .last_selected_ip
        .as_ref()
        .is_some_and(|ip| !lan_ips.contains(ip))
        || (config.host != "0.0.0.0"
            && config.host != "127.0.0.1"
            && !lan_ips.contains(&config.host));
    let connect_cmd = network::build_connect_command(
        &config.host,
        config.port,
        &config.token,
        &lan_ips,
        config.last_selected_ip.as_deref(),
        &config.transport,
    );

    // S1: 远程链路可达性探针。解析远程客户端应当连接的展示地址（与连接命令一致），
    // 对该地址:port 做 TCP 探测（超时 200ms）。running 为 false 时不探测，直接不可达。
    // 这是「远程连接中断」状态机的真实信号源，区别于 ip_changed（仅文本地址变化）。
    let remote_reachable = if !running {
        false
    } else {
        let probe_host = network::resolve_display_host(
            &config.host,
            &lan_ips,
            config.last_selected_ip.as_deref(),
        );
        matches!(
            timeout(
                Duration::from_millis(200),
                TcpStream::connect((probe_host.as_str(), config.port)),
            )
            .await,
            Ok(Ok(_))
        )
    };

    // ── 方案 A 运行卡实时指标聚合（全做真，无伪造）──
    let total = stats.total_requests;
    let errs = stats.total_errors;
    let success_rate = if total > 0 {
        (total - errs) as f64 / total as f64 * 100.0
    } else {
        100.0
    };

    // rpm：按 60s 窗口滑动计数（就地 prune 旧时间戳，避免无界增长）。
    let requests_per_min = {
        let mut q = state.recent_requests.lock().unwrap();
        let cutoff = Instant::now() - Duration::from_secs(60);
        q.retain(|t| *t > cutoff);
        q.len() as u64
    };

    // avg / P95 耗时：avg = 累计和/计数；P95 = 最近样本环形缓冲分位。
    let (avg_latency_ms, p95_latency_ms) = {
        let sum = state.latency_sum_ms.load(Ordering::Relaxed);
        let cnt = state.latency_count.load(Ordering::Relaxed);
        let avg = sum.checked_div(cnt).unwrap_or(0);
        let q = state.latency_samples.lock().unwrap();
        let mut v: Vec<u64> = q.iter().copied().collect();
        drop(q);
        v.sort_unstable();
        let p95 = if v.is_empty() {
            0
        } else {
            let idx = ((v.len() as f64 * 0.95) as usize).min(v.len() - 1);
            v[idx]
        };
        (avg, p95)
    };

    let rate_limit_hits = state.rate_limit_hits.load(Ordering::Relaxed);
    let auth_denies = state.auth_denies.load(Ordering::Relaxed);
    let audit_count = state.audit_count.load(Ordering::Relaxed);

    // 活跃命令：注册表里 exit_code 仍 None 的条目。先克隆 Arc 再跨 await 锁，
    // 避免持有 DashMap Ref 跨 await（与 list_running_commands 同套路）。
    let active_commands = {
        let snapshot: Vec<_> = state
            .running_commands
            .iter()
            .map(|e| e.value().exit_code.clone())
            .collect();
        let mut n = 0u64;
        for arc in snapshot {
            if arc.lock().await.is_none() {
                n += 1;
            }
        }
        n
    };

    // 热门工具 Top3（按累计调用次数降序）。
    let top_tools: Vec<ToolCount> = {
        let mut v: Vec<ToolCount> = state
            .tool_counts
            .iter()
            .map(|e| ToolCount {
                name: e.key().clone(),
                count: *e.value(),
            })
            .collect();
        v.sort_by_key(|b| std::cmp::Reverse(b.count));
        v.truncate(3);
        v
    };

    // 备份目录绝对路径 + 统计（扫一次磁盘，供设置页展示）。
    let backup_dir_abs = state
        .data_dir
        .join(&config.backup_dir)
        .to_string_lossy()
        .into_owned();
    let (backup_count, backup_total_bytes) =
        backup::backup_stats(&state.data_dir, &config.backup_dir);

    Ok(StatusResponse {
        version: env!("CARGO_PKG_VERSION").into(),
        uptime_seconds: uptime,
        allowed_roots: config.allowed_roots.clone(),
        allowed_extensions: config.allowed_extensions.clone(),
        max_file_size_bytes: config.max_file_size_bytes,
        rate_limit: RateLimitInfo {
            max_requests: config.rate_limit_max_requests,
            window_ms: config.rate_limit_window_ms,
        },
        backup_dir: config.backup_dir.clone(),
        backup_dir_abs,
        backup_count,
        backup_total_bytes,
        backup_retention: config.backup_retention,
        audit_retention_days: config.audit_retention_days,
        command_cleanup_secs: config.command_cleanup_secs,
        host: config.host.clone(),
        port: config.port,
        stats: StatsInfo {
            total_requests: stats.total_requests,
            total_errors: stats.total_errors,
            success_rate,
            requests_per_min,
            avg_latency_ms,
            p95_latency_ms,
            rate_limit_hits,
            auth_denies,
            audit_count,
            active_commands,
            top_tools,
        },
        connect_command: connect_cmd,
        token: config.token.clone(),
        whitelist_enabled: config.whitelist_enabled,
        readonly_mode: config.readonly_mode,
        backup_enabled: config.backup_enabled,
        audit_enabled: config.audit_enabled,
        rate_limit_enabled: config.rate_limit_enabled,
        encoding_detect_enabled: config.encoding_detect_enabled,
        shell_enabled: config.shell_enabled,
        shell_type: config.shell_type.clone(),
        transport: config.transport.clone(),
        bash_available: crate::mcp::tools::shell::detect_bash_exe().is_some(),
        running,
        last_selected_ip: config.last_selected_ip.clone(),
        ip_changed,
        remote_reachable,
        scope: config.scope.clone(),
        startup_error,
        lan_ips,
        firewall_enabled,
        firewall_port_open,
        firewall_available,
    })
}

/// 手动/定点刷新防火墙状态缓存（前端「重新检查」按钮调用）。
/// 立即重跑 netsh 查询并回写缓存，下次 get_status 即返回最新结果。
#[tauri::command]
pub async fn refresh_firewall(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let port = state.config.read().await.port;
    crate::firewall::refresh_cache(&state, port).await;
    Ok(())
}

/// 一键开放防火墙端口（仅 Windows 有意义）。
/// 通过 UAC 提权（PowerShell Start-Process -Verb RunAs）写入 7823/TCP 入站允许规则，
/// 不引入任何 Rust 依赖（守规则8）。成功后立即刷新缓存并回写 get_status。
#[tauri::command]
pub async fn open_firewall_port(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let port = state.config.read().await.port;
        let exe = std::env::current_exe()
            .map_err(|e| format!("无法定位自身路径: {e}"))?
            .to_string_lossy()
            .into_owned();
        let params = format!(
            "advfirewall firewall add rule name=cc-bridge dir=in action=allow protocol=TCP localport={port} program=\"{exe}\""
        );
        // 提权过程可能长时间挂起（用户未处理 UAC 弹窗），放到阻塞线程避免占用 async 工作线程
        let res =
            tauri::async_runtime::spawn_blocking(move || crate::firewall::elevate_netsh(&params))
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

#[derive(Debug, Deserialize)]
pub struct ConfigPatch {
    #[serde(rename = "allowedRoots")]
    pub allowed_roots: Option<Vec<String>>,
    #[serde(rename = "allowedExtensions")]
    pub allowed_extensions: Option<Vec<String>>,
    #[serde(rename = "maxFileSizeBytes")]
    pub max_file_size_bytes: Option<u64>,
    #[serde(rename = "rateLimitMaxRequests")]
    pub rate_limit_max_requests: Option<u32>,
    #[serde(rename = "rateLimitWindowMs")]
    pub rate_limit_window_ms: Option<u64>,
    #[serde(rename = "backupDir")]
    pub backup_dir: Option<String>,
    #[serde(rename = "backupRetention")]
    pub backup_retention: Option<u32>,
    #[serde(rename = "auditRetentionDays")]
    pub audit_retention_days: Option<u32>,
    /// 后台命令结束后保留时长（秒），可调。
    #[serde(rename = "commandCleanupSecs")]
    pub command_cleanup_secs: Option<u64>,
    pub host: Option<String>,
    pub port: Option<u16>,
    #[serde(rename = "whitelistEnabled")]
    pub whitelist_enabled: Option<bool>,
    #[serde(rename = "readonlyMode")]
    pub readonly_mode: Option<bool>,
    #[serde(rename = "backupEnabled")]
    pub backup_enabled: Option<bool>,
    #[serde(rename = "auditEnabled")]
    pub audit_enabled: Option<bool>,
    #[serde(rename = "rateLimitEnabled")]
    pub rate_limit_enabled: Option<bool>,
    #[serde(rename = "encodingDetectEnabled")]
    pub encoding_detect_enabled: Option<bool>,
    #[serde(rename = "shellEnabled")]
    pub shell_enabled: Option<bool>,
    /// 命令执行壳层：cmd 或 bash。前端「命令执行壳层」分段控件写入。
    #[serde(rename = "shellType")]
    pub shell_type: Option<String>,
    /// MCP 传输协议：http 或 sse。前端「MCP 传输协议」分段控件写入。
    pub transport: Option<String>,
    /// 用户接入时确认的作用域（user/project）。仅首次接入复制命令时由前端写入。
    #[serde(rename = "scope")]
    pub scope: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConfigSaveResult {
    pub ok: bool,
    pub changed: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(rename = "restartRequired")]
    pub restart_required: bool,
}

#[tauri::command]
pub async fn save_config(
    state: State<'_, Arc<AppState>>,
    patch: ConfigPatch,
) -> Result<ConfigSaveResult, String> {
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    let mut changed = Vec::new();
    let mut restart_required = false;

    macro_rules! apply_field {
        ($field:ident, $key:expr, $val:expr) => {
            if let Some(v) = $val {
                config.$field = v.clone();
                save_config_field(&db, $key, &serde_json::to_value(&v).unwrap())?;
                changed.push($key.into());
            }
        };
    }

    apply_field!(allowed_roots, "allowed_roots", &patch.allowed_roots);
    apply_field!(
        allowed_extensions,
        "allowed_extensions",
        &patch.allowed_extensions
    );
    apply_field!(
        max_file_size_bytes,
        "max_file_size_bytes",
        &patch.max_file_size_bytes
    );
    apply_field!(
        rate_limit_max_requests,
        "rate_limit_max_requests",
        &patch.rate_limit_max_requests
    );
    apply_field!(
        rate_limit_window_ms,
        "rate_limit_window_ms",
        &patch.rate_limit_window_ms
    );
    apply_field!(backup_dir, "backup_dir", &patch.backup_dir);
    apply_field!(
        backup_retention,
        "backup_retention",
        &patch.backup_retention
    );
    apply_field!(
        audit_retention_days,
        "audit_retention_days",
        &patch.audit_retention_days
    );
    apply_field!(
        command_cleanup_secs,
        "command_cleanup_secs",
        &patch.command_cleanup_secs
    );
    apply_field!(
        whitelist_enabled,
        "whitelist_enabled",
        &patch.whitelist_enabled
    );
    apply_field!(readonly_mode, "readonly_mode", &patch.readonly_mode);
    apply_field!(backup_enabled, "backup_enabled", &patch.backup_enabled);
    apply_field!(audit_enabled, "audit_enabled", &patch.audit_enabled);
    apply_field!(
        rate_limit_enabled,
        "rate_limit_enabled",
        &patch.rate_limit_enabled
    );
    apply_field!(
        encoding_detect_enabled,
        "encoding_detect_enabled",
        &patch.encoding_detect_enabled
    );
    apply_field!(shell_enabled, "shell_enabled", &patch.shell_enabled);
    // 命令执行壳层：cmd（默认）/ bash。仅接受这两个值，其它值由 config.rs 解析时回退 cmd。
    apply_field!(shell_type, "shell_type", &patch.shell_type);
    apply_field!(transport, "transport", &patch.transport);
    // 首次接入复制命令时由前端写入，记录 cc-bridge 被注册到远程的作用域，
    // 供后续 IP 变化 / Token 重生成生成精确 sed 命令（方案 A）。
    // scope 在 config 中也是 Option<String>，与 apply_field! 宏的 "T vs Option<T>" 假设不符，故单独处理。
    if let Some(ref s) = patch.scope {
        config.scope = Some(s.clone());
        save_config_field(&db, "scope", &serde_json::to_value(s).unwrap())?;
        changed.push("scope".into());
    }

    if let Some(ref h) = patch.host {
        if *h != config.host {
            config.host = h.clone();
            save_config_field(&db, "host", &serde_json::to_value(h).unwrap())?;
            changed.push("host".into());
            restart_required = true;
        }
    }
    if let Some(p) = patch.port {
        if p != config.port {
            config.port = p;
            save_config_field(&db, "port", &serde_json::to_value(p).unwrap())?;
            changed.push("port".into());
            restart_required = true;
        }
    }

    // 白名单根目录缓存随配置刷新（性能优化）：先释放 config 写锁，避免下面读锁死等。
    drop(config);
    state.refresh_canonicalized_roots(&state.config.read().await.allowed_roots);

    Ok(ConfigSaveResult {
        ok: true,
        changed,
        warnings: vec![],
        restart_required,
    })
}

#[tauri::command]
pub async fn regenerate_token(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let new_token = auth::generate_token();
    let db = state.db.lock().await;
    save_config_field(&db, "token", &serde_json::to_value(&new_token).unwrap())?;
    let mut config = state.config.write().await;
    config.token = new_token.clone();
    Ok(new_token)
}

#[tauri::command]
pub async fn get_audit_log(
    state: State<'_, Arc<AppState>>,
    page: Option<u32>,
    page_size: Option<u32>,
    // 兼容旧前端：传 limit 等价于 (page=1, page_size=limit)
    limit: Option<u32>,
) -> Result<audit::AuditPage, String> {
    // 策略 A：页码分页。page 默认 1；page_size 默认 50；兼容旧 limit 参数。clamp 到 1..=500。
    let page = page.unwrap_or(1).max(1) as usize;
    let page_size = match (page_size, limit) {
        (Some(ps), _) => ps as usize,
        (None, Some(l)) => l as usize,
        (None, None) => 50,
    }
    .clamp(1, 500);
    audit::read_page(&state.data_dir, page, page_size)
}

#[tauri::command]
pub async fn clear_audit_log(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    audit::clear_all(&state.data_dir)
}

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

#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

/// 返回软件安装目录（即当前 exe 所在目录）。
/// 用于前端「安装位置」展示。发布版即安装目录；开发模式指向 target/debug。
#[tauri::command]
pub fn install_dir() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位自身路径: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "无法解析安装目录".to_string())?
        .to_string_lossy()
        .into_owned();
    Ok(dir)
}

/// 在系统文件管理器中打开（定位）安装目录。
/// 使用 tauri-plugin-opener 的 reveal_item_in_dir（Windows 底层 SHOpenFolderAndSelectItems），
/// 不产生子进程、不闪 cmd 窗口；项目已依赖并注册 opener 插件（Cargo.toml:18 / main.rs:137）。
/// 同时返回安装目录字符串，便于前端展示。
#[tauri::command]
pub fn reveal_install_dir() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位自身路径: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "无法解析安装目录".to_string())?
        .to_string_lossy()
        .into_owned();
    tauri_plugin_opener::reveal_item_in_dir(&dir).map_err(|e| format!("打开安装目录失败: {e}"))?;
    Ok(dir)
}

/// 在桌面创建（或覆盖）指向本程序 exe 的快捷方式。
/// 复用系统 WScript.Shell COM（零 Rust 依赖，守规则8），普通用户权限即可，
/// 桌面为当前用户可写目录，无需 UAC 提权。用户确认：已存在同名 lnk 直接覆盖。
/// 桌面路径优先取 USERPROFILE\Desktop，失败回退 Tauri desktop_dir()。
#[tauri::command]
pub fn create_desktop_shortcut(app: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位自身路径: {e}"))?;
    let exe_str = exe.to_string_lossy().into_owned();
    let dir_str = exe
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string();

    // 桌面路径：优先 USERPROFILE\Desktop（不依赖 Tauri path 插件，最稳）；
    // 失败则回退到 Tauri 的 desktop_dir() 解析。
    let desktop = std::env::var("USERPROFILE")
        .map(|u| std::path::Path::new(&u).join("Desktop"))
        .or_else(|_| {
            app.path()
                .desktop_dir()
                .map(|p| p.to_path_buf())
                .map_err(|e| format!("无法解析桌面目录: {e}"))
        })
        .map_err(|e| e.to_string())?;
    let lnk_path = desktop.join("cc-bridge.lnk");
    let lnk_str = lnk_path.to_string_lossy().into_owned();

    // 单引号 PowerShell 字符串：路径中的单引号转义为两个单引号（反斜杠在单引号中即字面量）。
    let ps = format!(
        "$ws=New-Object -ComObject WScript.Shell; \
         $lnk=$ws.CreateShortcut('{lnk}'); \
         $lnk.TargetPath='{exe}'; \
         $lnk.IconLocation='{exe},0'; \
         $lnk.Description='cc-bridge'; \
         $lnk.WorkingDirectory='{dir}'; \
         $lnk.Save()",
        lnk = lnk_str.replace('\'', "''"),
        exe = exe_str.replace('\'', "''"),
        dir = dir_str.replace('\'', "''"),
    );
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &ps,
        ])
        .output()
        .map_err(|e| format!("创建快捷方式失败: {e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if msg.is_empty() {
            "创建桌面快捷方式失败".into()
        } else {
            format!("创建桌面快捷方式失败：{msg}")
        });
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct RunningCommandInfo {
    pub handle: String,
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    pub running: bool,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    #[serde(rename = "elapsedSeconds")]
    pub elapsed_seconds: u64,
}

/// 供本机面板展示 run_command(background=true) 启动的后台命令，与远程 MCP 的
/// get_command_output 读的是同一份 `AppState.running_commands` 注册表。
#[tauri::command]
pub async fn list_running_commands(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<RunningCommandInfo>, String> {
    // 先克隆出快照再逐个 await 锁，避免持有 DashMap 的 Ref 跨 await。
    let snapshot: Vec<_> = state
        .running_commands
        .iter()
        .map(|entry| {
            let cmd = entry.value();
            (
                entry.key().clone(),
                cmd.pid,
                cmd.command.clone(),
                cmd.cwd.clone(),
                cmd.exit_code.clone(),
                cmd.finished_elapsed_secs.clone(),
                cmd.started_at.elapsed().as_secs(),
            )
        })
        .collect();

    let mut result = Vec::with_capacity(snapshot.len());
    for (handle, pid, command, cwd, exit_code_arc, finished_elapsed_arc, live_elapsed_seconds) in
        snapshot
    {
        let exit_code = *exit_code_arc.lock().await;
        // 修复：进程已结束时优先用 wait 线程写入的定格值，不再用 started_at.elapsed() 实时计算，
        // 避免面板里“已运行”在命令早已结束后还一直增长。
        let elapsed_seconds = match *finished_elapsed_arc.lock().await {
            Some(frozen) => frozen,
            None => live_elapsed_seconds,
        };
        result.push(RunningCommandInfo {
            handle,
            pid,
            command,
            cwd,
            running: exit_code.is_none(),
            exit_code,
            elapsed_seconds,
        });
    }
    Ok(result)
}

// G5: cleanup_finished_commands / evict_finished_commands moved to state.rs (AppState methods).

/// 本机面板的「终止」按钮：移除注册表条目后 drop 其中的 Job Object（kill-on-job-close）
/// 整树终止，不再需要 taskkill，逻辑与 MCP 的 stop_command 工具一致。
#[tauri::command]
pub async fn stop_running_command(
    state: State<'_, Arc<AppState>>,
    handle: String,
) -> Result<(), String> {
    let entry = state
        .running_commands
        .remove(&handle)
        .ok_or_else(|| format!("未知的 handle: {handle}"))?;
    drop(entry);
    Ok(())
}

/// 本机面板实时拉取后台命令（run_command background=true）的输出，与远程 MCP 的
/// get_command_output 读的是同一份 `AppState.running_commands` 注册表。
/// 返回干净结构体（stdout/stderr 文本 + 长度 + 截断标记 + 运行态），供前端增量轮询。
/// 安全不削弱：只暴露已捕获的输出，不新增任何执行 / 控制能力。
#[tauri::command]
pub async fn get_command_output(
    state: State<'_, Arc<AppState>>,
    handle: String,
    stdout_offset: Option<usize>,
    stderr_offset: Option<usize>,
) -> Result<CommandOutput, String> {
    use std::sync::atomic::Ordering;
    let stdout_offset = stdout_offset.unwrap_or(0);
    let stderr_offset = stderr_offset.unwrap_or(0);
    // 先克隆出需要的 Arc，再释放 DashMap 的 Ref，避免在持有 Ref 期间跨 await。
    let (stdout_arc, stderr_arc, stdout_trunc, stderr_trunc, exit_code_arc, pid) = {
        let entry = state
            .running_commands
            .get(&handle)
            .ok_or_else(|| format!("未知的 handle: {handle}（可能已被清理）"))?;
        (
            entry.stdout.clone(),
            entry.stderr.clone(),
            entry.stdout_truncated.clone(),
            entry.stderr_truncated.clone(),
            entry.exit_code.clone(),
            entry.pid,
        )
    };

    let stdout = stdout_arc.lock().await;
    let stderr = stderr_arc.lock().await;
    let exit_code = *exit_code_arc.lock().await;

    let stdout_slice = &stdout[stdout_offset.min(stdout.len())..];
    let stderr_slice = &stderr[stderr_offset.min(stderr.len())..];

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(stdout_slice).to_string(),
        stderr: String::from_utf8_lossy(stderr_slice).to_string(),
        stdout_total_bytes: stdout.len(),
        stderr_total_bytes: stderr.len(),
        stdout_truncated: stdout_trunc.load(Ordering::Relaxed),
        stderr_truncated: stderr_trunc.load(Ordering::Relaxed),
        running: exit_code.is_none(),
        exit_code,
        pid,
    })
}

#[derive(Debug, Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    #[serde(rename = "stdoutTotalBytes")]
    pub stdout_total_bytes: usize,
    #[serde(rename = "stderrTotalBytes")]
    pub stderr_total_bytes: usize,
    #[serde(rename = "stdoutTruncated")]
    pub stdout_truncated: bool,
    #[serde(rename = "stderrTruncated")]
    pub stderr_truncated: bool,
    pub running: bool,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    pub pid: u32,
}

// ===== 一键回滚 + 变更 Diff（P1）=====

/// 校验 backup_path 合法性：必须在 data_dir/backup_dir 内且以 .bak 结尾。
/// canonicalize 后做前缀校验，杜绝用备份通道越权读写任意文件（安全模块不削弱）。
fn assert_backup_path_in_scope(
    backup_path: &str,
    data_dir: &std::path::Path,
    backup_dir: &str,
) -> Result<PathBuf, String> {
    let expected_dir = data_dir.join(backup_dir);
    let expected_canon = expected_dir
        .canonicalize()
        .map_err(|e| format!("备份目录解析失败：{e}"))?;
    let bak_canon = PathBuf::from(backup_path)
        .canonicalize()
        .map_err(|_| "备份文件不存在或路径非法".to_string())?;
    let bak_str = bak_canon.to_string_lossy();
    if !bak_canon.starts_with(&expected_canon) || !bak_str.ends_with(".bak") {
        return Err("备份路径越权：必须为白名单备份目录内的 .bak 文件".into());
    }
    Ok(bak_canon)
}

/// 一键回滚：将指定 .bak 备份按原字节写回目标文件（保留原始编码）。
///
/// 安全（不削弱）：backup_path 限备份目录内 .bak；target_path 走白名单校验。
/// 还原前对当前目标再备一次（可继续撤销）；目标不存在（删除类操作）则直接恢复被删文件。
/// 自身写一条审计（关联新备份），使回滚动作也可追溯。
#[tauri::command(rename_all = "snake_case")]
pub async fn restore_file(
    state: State<'_, Arc<AppState>>,
    backup_path: String,
    target_path: String,
) -> Result<(), String> {
    let config = state.config.read().await;
    let data_dir = state.data_dir.clone();
    let backup_dir = config.backup_dir.clone();
    let backup_retention = config.backup_retention;

    // 1) 安全校验 backup_path
    let bak_canon = assert_backup_path_in_scope(&backup_path, &data_dir, &backup_dir)?;
    // 2) 白名单校验 target（安全模块不削弱）
    let resolved = path::resolve_safe_path_cached(
        &target_path,
        &state.cached_roots(),
        config.whitelist_enabled,
    )?;
    drop(config);

    // 3) 还原前再备一次（可继续撤销）——仅当目标已存在
    let mut new_backup: Option<PathBuf> = None;
    if resolved.exists() {
        let db = state.db.lock().await;
        new_backup = backup::backup_before_overwrite(&resolved, &backup_dir, &data_dir, &db)?;
        drop(db);
        backup::prune_backups(&resolved, &backup_dir, &data_dir, backup_retention)?;
    }

    // 4) 原子写回：临时文件 + rename（保留原始字节 / 编码）
    let tmp = resolved.with_extension("tmp_restore");
    std::fs::copy(&bak_canon, &tmp).map_err(|e| format!("写入临时文件失败：{e}"))?;
    std::fs::rename(&tmp, &resolved).map_err(|e| format!("恢复文件失败：{e}"))?;

    // 5) 写审计（工具名 restore_file，关联本次新备份以便再撤销）
    let mut entry = audit::new_entry(
        "restore_file",
        &serde_json::json!({ "backupPath": backup_path, "targetPath": target_path }).to_string(),
        true,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    );
    entry.backup_path = new_backup
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    entry.target_path = Some(target_path.clone());
    audit::write_audit_log(&data_dir, &entry)?;

    Ok(())
}

// ===== 备份目录查看 + 清单（P0/P1）=====

/// 在系统文件管理器中打开备份目录（复用 reveal_install_dir 的 cmd start 思路，
/// 规避 explorer /select 的 DDE 转发导致不弹窗）。同时返回绝对路径供前端展示。
/// 目录可能尚不存在（从未产生备份）——先创建，确保资源管理器能打开。
#[tauri::command]
pub async fn reveal_backup_dir(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let config = state.config.read().await;
    let dir = state.data_dir.join(&config.backup_dir);
    drop(config);
    let dir_str = dir.to_string_lossy().into_owned();
    let _ = std::fs::create_dir_all(&dir);
    // 修复：漏加 CREATE_NO_WINDOW，cmd.exe 会一闪而过弹出黑框（对齐 firewall.rs 里
    // netsh/powershell 子进程的同款修复；run_command.rs 的 CREATE_NO_WINDOW 修复未覆盖到这里）。
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = std::process::Command::new("cmd");
    command.args(["/c", "start", "", &dir_str]);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let status = command.status();
    if let Err(e) = status {
        return Err(format!("打开备份目录失败: {e}"));
    }
    Ok(dir_str)
}

#[derive(Debug, Serialize)]
pub struct BackupFileInfo {
    #[serde(rename = "backupPath")]
    pub backup_path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// 创建备份时记录的原始绝对路径（仍落在当前白名单内才返回）。白名单关闭
    /// 或该备份无对应索引记录（历史备份）时恒为空。
    pub targets: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct BackupGroupInfo {
    #[serde(rename = "originalFile")]
    pub original_file: String,
    pub count: usize,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    pub entries: Vec<BackupFileInfo>,
}

#[derive(Debug, Serialize)]
pub struct BackupListResult {
    pub dir: String,
    pub exists: bool,
    pub count: usize,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    pub groups: Vec<BackupGroupInfo>,
}

/// 列出全部 .bak 备份，按原文件名分组，并从 backup_index 表精确反查还原目标。
///
/// 安全（不削弱）：targets 仅在白名单开启时返回，且仍需再次经过 resolve_safe_path
/// 确认当前确实落在 allowed_roots 内（root 配置可能在备份之后被改过），不返回白名单外
/// 路径；白名单关闭时 targets 恒为空（还原交由 restore_file 再走一次白名单校验）。
#[tauri::command]
pub async fn list_backups(state: State<'_, Arc<AppState>>) -> Result<BackupListResult, String> {
    let config = state.config.read().await;
    let data_dir = state.data_dir.clone();
    let backup_dir_name = config.backup_dir.clone();
    let whitelist_enabled = config.whitelist_enabled;
    drop(config);

    let dir = data_dir.join(&backup_dir_name);
    let mut result = BackupListResult {
        dir: dir.to_string_lossy().into_owned(),
        exists: dir.exists(),
        count: 0,
        total_bytes: 0,
        groups: Vec::new(),
    };
    if !result.exists {
        return Ok(result);
    }

    let mut groups: std::collections::BTreeMap<String, BackupGroupInfo> =
        std::collections::BTreeMap::new();

    let rd = std::fs::read_dir(&dir).map_err(|e| format!("读取备份目录失败: {e}"))?;
    for entry in rd.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("bak") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = meta.len();
        // 文件名 = "{original}.{timestamp}.bak"（时间戳含下划线、无点）
        let stem = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let (original, ts) = match stem.rsplit_once('.') {
            Some((o, t)) => (o.to_string(), t.to_string()),
            None => (stem.clone(), String::new()),
        };
        let created_at = parse_backup_timestamp(&ts, &meta);
        let g = groups
            .entry(original.clone())
            .or_insert_with(|| BackupGroupInfo {
                original_file: original.clone(),
                count: 0,
                total_bytes: 0,
                entries: Vec::new(),
            });
        g.count += 1;
        g.total_bytes += size;
        g.entries.push(BackupFileInfo {
            backup_path: p.to_string_lossy().into_owned(),
            size_bytes: size,
            created_at,
            targets: Vec::new(),
        });
    }

    // 反查还原目标（仅白名单开启时）：从 backup_index 表精确读取创建备份时记录的原始绝对路径，
    // 不再对文件系统做"按文件名猜"的有边界遍历（旧实现受 max_depth=6/max_scan=8000 限制，
    // 对深层企业级仓库容易查不到）。旧备份（backup_index 上线前创建）无对应记录，
    // 查不到即 targets 为空，前端按钮相应禁用（已知、可接受的降级）。
    if whitelist_enabled && !groups.is_empty() {
        let db = state.db.lock().await;
        let mut index: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        if let Ok(mut stmt) = db.prepare("SELECT backup_path, original_path FROM backup_index") {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }) {
                for row in rows.filter_map(|r| r.ok()) {
                    index.insert(row.0, row.1);
                }
            }
        }
        drop(db);

        for g in groups.values_mut() {
            for e in g.entries.iter_mut() {
                if let Some(original_path) = index.get(&e.backup_path) {
                    // 仍需核实该路径当前确实落在白名单内（root 配置可能在备份之后被改过）。
                    if let Ok(resolved) =
                        path::resolve_safe_path_cached(original_path, &state.cached_roots(), true)
                    {
                        e.targets = vec![path::display_path(&resolved)];
                    }
                }
            }
        }
    }

    // 每组内按时间倒序（文件名时间戳字典序即时间序）
    for g in groups.values_mut() {
        g.entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    }
    result.groups = groups.into_values().collect();
    result.count = result.groups.iter().map(|g| g.count).sum();
    result.total_bytes = result.groups.iter().map(|g| g.total_bytes).sum();
    Ok(result)
}

/// 解析备份时间戳（文件名内嵌的 %Y%m%d_%H%M%S_%3f）；失败回退到文件修改时间。
fn parse_backup_timestamp(ts: &str, meta: &std::fs::Metadata) -> String {
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(ts, "%Y%m%d_%H%M%S_%3f") {
        return dt.format("%Y-%m-%d %H:%M:%S").to_string();
    }
    if let Ok(system_time) = meta.modified() {
        let dt: chrono::DateTime<chrono::Local> = system_time.into();
        return dt.format("%Y-%m-%d %H:%M:%S").to_string();
    }
    "未知时间".to_string()
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    /// "context" | "added" | "removed"
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct FileDiffResult {
    pub lines: Vec<DiffLine>,
    /// 触发护栏的原因（二进制 / 体积过大 / 行数过多）；非空时前端仅允许「还原」、不展示全量 diff。
    #[serde(rename = "guard")]
    pub guard: Option<String>,
    #[serde(rename = "beforeLines")]
    pub before_lines: usize,
    #[serde(rename = "afterLines")]
    pub after_lines: usize,
}

/// 变更 Diff：实时用 .bak（前）vs 当前文件（后）做行级 diff，不占存储。
///
/// 安全（不削弱）：同 restore_file —— backup_path 限备份目录内 .bak；target 走白名单校验。
/// 大文件 / 二进制 / 行数过多触发护栏，仅返回行数统计，避免前端卡死；护栏下仍允许「还原」。
#[tauri::command(rename_all = "snake_case")]
pub async fn get_file_diff(
    state: State<'_, Arc<AppState>>,
    backup_path: String,
    target_path: String,
) -> Result<FileDiffResult, String> {
    let config = state.config.read().await;
    let data_dir = state.data_dir.clone();
    let backup_dir = config.backup_dir.clone();

    // 1) 校验 backup_path
    let bak_canon = assert_backup_path_in_scope(&backup_path, &data_dir, &backup_dir)?;
    // 2) 白名单校验 target
    let resolved = path::resolve_safe_path_cached(
        &target_path,
        &state.cached_roots(),
        config.whitelist_enabled,
    )?;

    // 3) 读取 before（.bak）与 after（当前；不存在 = 已删除）
    let before_bytes = std::fs::read(&bak_canon).map_err(|e| format!("读取备份失败：{e}"))?;
    let after_bytes = if resolved.exists() {
        Some(std::fs::read(&resolved).map_err(|e| format!("读取当前文件失败：{e}"))?)
    } else {
        None
    };
    drop(config);

    let before_has_nul = before_bytes.contains(&0u8);
    let after_has_nul = after_bytes
        .as_ref()
        .map(|b| b.contains(&0u8))
        .unwrap_or(false);
    let big = before_bytes.len() > 1_000_000
        || after_bytes
            .as_ref()
            .map(|b| b.len() > 1_000_000)
            .unwrap_or(false);

    let before = String::from_utf8_lossy(&before_bytes).into_owned();
    let after = after_bytes
        .as_ref()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();

    let before_lines = before.lines().count();
    let after_lines = after.lines().count();
    let many = before_lines > 2000 || after_lines > 2000;

    let guard = if before_has_nul || after_has_nul {
        Some("文件含二进制内容，仅可一键还原，不可预览 diff".into())
    } else if big {
        Some("文件体积超过 1MB，仅可一键还原，不可预览 diff".into())
    } else if many {
        Some("变更行数过多（>2000），仅可一键还原，不可预览 diff".into())
    } else {
        None
    };

    if guard.is_some() {
        return Ok(FileDiffResult {
            lines: vec![],
            guard,
            before_lines,
            after_lines,
        });
    }

    // 行级 diff（复用 similar，已是项目依赖）
    let diff = TextDiff::from_lines(&before, &after);
    let lines: Vec<DiffLine> = diff
        .iter_all_changes()
        .map(|c| {
            let (sign, kind) = match c.tag() {
                similar::ChangeTag::Delete => ("-", "removed"),
                similar::ChangeTag::Insert => ("+", "added"),
                similar::ChangeTag::Equal => (" ", "context"),
            };
            DiffLine {
                kind: kind.into(),
                text: format!("{}{}", sign, c.value()),
            }
        })
        .collect();

    Ok(FileDiffResult {
        lines,
        guard: None,
        before_lines,
        after_lines,
    })
}

/// 相邻版本对比：两个 .bak 互为 before/after 做行级 diff（均限备份目录内）。
///
/// 安全（不削弱）：两个路径都经 `assert_backup_path_in_scope` 双重校验（必须在备份目录内、以 .bak 结尾），
/// 杜绝用对比通道越权读取任意文件。复用 get_file_diff 的护栏 + similar，零新依赖。
#[tauri::command(rename_all = "snake_case")]
pub async fn diff_backups(
    state: State<'_, Arc<AppState>>,
    from_path: String,
    to_path: String,
) -> Result<FileDiffResult, String> {
    let config = state.config.read().await;
    let data_dir = state.data_dir.clone();
    let backup_dir = config.backup_dir.clone();
    drop(config);

    // 双重校验：两个路径都需在备份目录内且为 .bak
    let from_canon = assert_backup_path_in_scope(&from_path, &data_dir, &backup_dir)?;
    let to_canon = assert_backup_path_in_scope(&to_path, &data_dir, &backup_dir)?;

    let from_bytes = std::fs::read(&from_canon).map_err(|e| format!("读取备份失败：{e}"))?;
    let to_bytes = std::fs::read(&to_canon).map_err(|e| format!("读取备份失败：{e}"))?;

    let from_has_nul = from_bytes.contains(&0u8);
    let to_has_nul = to_bytes.contains(&0u8);
    let big = from_bytes.len() > 1_000_000 || to_bytes.len() > 1_000_000;

    let from = String::from_utf8_lossy(&from_bytes).into_owned();
    let to = String::from_utf8_lossy(&to_bytes).into_owned();

    let before_lines = from.lines().count();
    let after_lines = to.lines().count();
    let many = before_lines > 2000 || after_lines > 2000;

    let guard = if from_has_nul || to_has_nul {
        Some("文件含二进制内容，仅可一键还原，不可预览 diff".into())
    } else if big {
        Some("文件体积超过 1MB，仅可一键还原，不可预览 diff".into())
    } else if many {
        Some("变更行数过多（>2000），仅可一键还原，不可预览 diff".into())
    } else {
        None
    };

    if guard.is_some() {
        return Ok(FileDiffResult {
            lines: vec![],
            guard,
            before_lines,
            after_lines,
        });
    }

    // 行级 diff（复用 similar，已是项目依赖）。from=较旧版本，to=较新版本。
    let diff = TextDiff::from_lines(&from, &to);
    let lines: Vec<DiffLine> = diff
        .iter_all_changes()
        .map(|c| {
            let (sign, kind) = match c.tag() {
                similar::ChangeTag::Delete => ("-", "removed"),
                similar::ChangeTag::Insert => ("+", "added"),
                similar::ChangeTag::Equal => (" ", "context"),
            };
            DiffLine {
                kind: kind.into(),
                text: format!("{}{}", sign, c.value()),
            }
        })
        .collect();

    Ok(FileDiffResult {
        lines,
        guard: None,
        before_lines,
        after_lines,
    })
}

// ===== 配置导入/导出（C8）=====

#[tauri::command]
pub async fn export_config(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let config = state.config.read().await;
    serde_json::to_string_pretty(&*config).map_err(|e| format!("序列化配置失败：{e}"))
}

/// `import_config` 的纯逻辑入口：解析 → 白名单兜底校验 → 落库 → 写 config → 刷新白名单缓存。
///
/// 抽出来是为了让回归测试能直达「写 config 后必须刷新缓存」这一不变量，而不触发
/// Tauri `State` 包装与 `restart_server` 的端口副作用（见文件末尾 `import_config_refreshes_cached_roots`）。
pub(crate) async fn import_config_inner(
    state: &Arc<AppState>,
    json: &str,
) -> Result<ConfigSaveResult, String> {
    let incoming: crate::config::BridgeConfig =
        serde_json::from_str(json).map_err(|e| format!("配置解析失败：{e}"))?;

    // 白名单兜底校验（复用 security::path 白名单逻辑，不可绕过）。
    // incoming 尚未写入 state，用其自身 roots 预 canonicalize 的本地缓存集合校验。
    let incoming_roots = crate::security::path::canonicalize_roots(&incoming.allowed_roots);
    for root in &incoming.allowed_roots {
        if let Err(e) =
            path::resolve_safe_path_cached(root, &incoming_roots, incoming.whitelist_enabled)
        {
            return Err(format!("白名单目录校验失败「{}」：{}", root, e));
        }
    }

    let db = state.db.lock().await;
    crate::config::save_full_config(&db, &incoming)?;
    drop(db);

    *state.config.write().await = incoming;

    // 白名单根缓存随导入刷新（性能优化）：与 save_config 一致，写完 config 后用最新 roots 重算，
    // 否则缓存仍指向旧 roots，导致后续工具校验误放行/误拒绝。
    state.refresh_canonicalized_roots(&state.config.read().await.allowed_roots);

    Ok(ConfigSaveResult {
        ok: true,
        changed: vec!["(全部配置)".into()],
        warnings: vec![],
        restart_required: true,
    })
}

#[tauri::command]
pub async fn import_config(
    state: State<'_, Arc<AppState>>,
    json: String,
) -> Result<ConfigSaveResult, String> {
    let result = import_config_inner(state.inner(), &json).await;
    // 仅成功时重启服务使 host/port 等配置生效（失败时不重启，与原语义一致）
    if result.is_ok() {
        crate::mcp::http::restart_server(state.inner()).await;
        state
            .mcp_running
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    result
}

// ===== 自动更新（后台线程，不阻塞 UI），採自 PastePanda 实现 =====

/// 指数退避重试辅助函数
async fn retry_with_backoff<F, Fut, T, E>(
    max_retries: u32,
    operation_name: &str,
    f: F,
) -> Result<T, E>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(val) => return Ok(val),
            Err(e) => {
                attempt += 1;
                if attempt > max_retries {
                    return Err(e);
                }
                let delay_secs = 1u64 << (attempt - 1);
                log::warn!(
                    "[Update] {} 失败（第 {}/{} 次），{} 秒后重试: {}",
                    operation_name,
                    attempt,
                    max_retries,
                    delay_secs,
                    e
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
            }
        }
    }
}

/// 解析更新源端点：优先环境变量 `CCBRIDGE_UPDATE_ENDPOINT`（逗号分隔多 URL，按顺序故障转移），
/// 未设置或解析为空则返回 `None`（退回 `tauri.conf.json` 的 `plugins.updater.endpoints`）。
fn resolve_update_endpoints() -> Result<Option<Vec<url::Url>>, String> {
    let raw = match std::env::var("CCBRIDGE_UPDATE_ENDPOINT") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return Ok(None),
    };
    let mut eps = Vec::new();
    for part in raw.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        match url::Url::parse(trimmed) {
            Ok(u) => eps.push(u),
            Err(e) => return Err(format!("更新源 \"{trimmed}\" 不是合法 URL: {e}")),
        }
    }
    if eps.is_empty() {
        Ok(None)
    } else {
        Ok(Some(eps))
    }
}

/// Gitee 镜像仓库路径（owner/repo），CI 会把每次发版的产物 + manifest 同步到这里的
/// `releases` 分支 `latest/` 目录（见 .github/workflows/build.yml）。国内访问远比任何
/// 公共 GitHub 代理稳定，作为更新源的第一候选；失败时自动回退到 tauri.conf.json 配置的
/// ghproxy/GitHub 端点（见 candidate_endpoint_groups）。
///
const GITEE_REPOSITORY: &str = "lzul/cc-bridge";

/// 候选更新源分组，按顺序尝试：前一组检查或下载任一步失败，才换下一组。
/// 手动 env 覆盖（CCBRIDGE_UPDATE_ENDPOINT）存在时只用这一组、不做自动换源，保持覆盖语义单一可预期。
fn candidate_endpoint_groups() -> Result<Vec<Option<Vec<url::Url>>>, String> {
    if let Some(eps) = resolve_update_endpoints()? {
        return Ok(vec![Some(eps)]);
    }
    let gitee_url =
        format!("https://gitee.com/{GITEE_REPOSITORY}/raw/releases/latest/updater-gitee.json");
    let gitee = url::Url::parse(&gitee_url).map_err(|e| format!("Gitee 更新源 URL 无效: {e}"))?;
    Ok(vec![
        Some(vec![gitee]),
        None, // 退回 tauri.conf.json 配置的端点（现有 ghproxy → GitHub 两级）
    ])
}

/// 构造 `Updater`：注入指定的端点（若有），否则用配置端点。
/// 供 `check_update` / `start_update` 共用，确保更新源解析只有这一处实现（单一真相源）。
fn build_updater(
    app: &tauri::AppHandle,
    endpoints: Option<Vec<url::Url>>,
) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;
    let app_handle = app.clone();
    let mut builder = app_handle.updater_builder();
    if let Some(eps) = endpoints {
        builder = builder
            .endpoints(eps)
            .map_err(|e| format!("更新源配置无效（需 https）: {e}"))?;
    }
    builder
        .build()
        .map_err(|e| format!("更新插件初始化失败: {e}"))
}

/// 后台执行更新检查+下载安装，通过 Tauri event 推送状态到前端。
/// 按 `candidate_endpoint_groups` 的顺序依次尝试候选源（默认 Gitee 优先、ghproxy/GitHub
/// 回退），前一个候选检查或下载任一步失败就换下一个，全部失败才报错。内置指数退避重试：
/// 每个候选内检查最多重试 2 次、下载安装最多重试 2 次。
#[tauri::command]
pub fn start_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("update:checking", ());

        let groups = match candidate_endpoint_groups() {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit("update:error", serde_json::json!({ "message": e }));
                return;
            }
        };

        let mut last_message: Option<String> = None;
        for endpoints in groups {
            let updater = match build_updater(&app, endpoints) {
                Ok(u) => u,
                Err(e) => {
                    last_message = Some(e);
                    continue;
                }
            };

            let check_result = match retry_with_backoff(2, "检查更新", || updater.check()).await
            {
                Ok(r) => r,
                Err(e) => {
                    last_message = Some(format!("检查更新失败: {e}"));
                    continue;
                }
            };

            let update = match check_result {
                Some(u) => u,
                None => {
                    // 下载链路不负责"已是最新"判定（那是 check_update 的事）。
                    // 这里返回 None 说明下载前复查没拿到可用更新，发 error 而非 uptodate，
                    // 避免把用户手上已有的可用更新静默清空；不再尝试下一个候选（各源应给出一致结论，
                    // 换源重试只会徒增耗时）。
                    let _ = app.emit(
                        "update:error",
                        serde_json::json!({
                            "message": "下载前复查未找到可用更新，可能已发布新版本，请重新检查"
                        }),
                    );
                    return;
                }
            };

            let date_str = update.date.map(|d| d.to_string());
            let current_ver = update.current_version.clone();
            let _ = app.emit(
                "update:available",
                serde_json::json!({
                    "version": update.version,
                    "body": update.body,
                    "date": date_str,
                    "currentVersion": current_ver,
                }),
            );

            let _ = app.emit("update:downloading", ());

            let app_progress = app.clone();
            let app_ready = app.clone();
            let result = retry_with_backoff(2, "下载安装", || {
                let u = update.clone();
                let ap = app_progress.clone();
                let ar = app_ready.clone();
                async move {
                    let mut downloaded_total: u64 = 0;
                    // 下载速度：窗口限流计算（~250ms 重算一次），不是每个 chunk 都重算——
                    // 快网速下 chunk 回调可能每秒触发好几十次，逐次算瞬时速率会跳得难看。
                    // downloaded/total 仍每 chunk 都发（百分比保持平滑），只有 bytesPerSec 在窗口
                    // 间隔内复用上一次算出的值。
                    let mut window_start = std::time::Instant::now();
                    let mut window_bytes: u64 = 0;
                    let mut last_bytes_per_sec: f64 = 0.0;
                    u.download_and_install(
                        move |chunk_len, total| {
                            downloaded_total += chunk_len as u64;
                            window_bytes += chunk_len as u64;
                            let elapsed = window_start.elapsed();
                            if elapsed.as_millis() >= 250 {
                                last_bytes_per_sec = window_bytes as f64 / elapsed.as_secs_f64();
                                window_start = std::time::Instant::now();
                                window_bytes = 0;
                            }
                            let _ = ap.emit(
                                "update:progress",
                                serde_json::json!({
                                    "downloaded": downloaded_total,
                                    "total": total,
                                    "bytesPerSec": last_bytes_per_sec,
                                }),
                            );
                        },
                        move || {
                            let _ = ar.emit("update:ready", ());
                        },
                    )
                    .await
                }
            })
            .await;

            match result {
                Ok(()) => return, // 这个源成功，结束
                Err(e) => {
                    last_message = Some(format!("下载安装失败: {e}"));
                    continue; // 换下一个候选源重试
                }
            }
        }

        let _ = app.emit(
            "update:error",
            serde_json::json!({
                "message": format!(
                    "全部更新源均失败（已依次尝试）: {}",
                    last_message.unwrap_or_else(|| "未知错误".into())
                )
            }),
        );
    });
}

/// 只检查更新、不下载，通过 Tauri event 把结果推给前端用于展示徽章。
/// 与 `start_update` 共用 `updater.check()`、指数退避重试与候选源回退顺序，确保检查逻辑
/// 只有这一处实现（单一真相源）。
#[tauri::command]
pub fn check_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("update:checking", ());

        let groups = match candidate_endpoint_groups() {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit("update:error", serde_json::json!({ "message": e }));
                return;
            }
        };

        let mut last_message: Option<String> = None;
        for endpoints in groups {
            let updater = match build_updater(&app, endpoints) {
                Ok(u) => u,
                Err(e) => {
                    last_message = Some(e);
                    continue;
                }
            };

            match retry_with_backoff(2, "检查更新", || updater.check()).await {
                Ok(Some(u)) => {
                    let date_str = u.date.map(|d| d.to_string());
                    let current_ver = u.current_version.clone();
                    let _ = app.emit(
                        "update:available",
                        serde_json::json!({
                            "version": u.version,
                            "body": u.body,
                            "date": date_str,
                            "currentVersion": current_ver,
                        }),
                    );
                    return;
                }
                Ok(None) => {
                    let _ = app.emit("update:uptodate", ());
                    return;
                }
                Err(e) => {
                    last_message = Some(format!("检查更新失败: {e}"));
                    continue;
                }
            }
        }

        let _ = app.emit(
            "update:error",
            serde_json::json!({
                "message": format!(
                    "全部更新源均检查失败（已依次尝试）: {}",
                    last_message.unwrap_or_else(|| "未知错误".into())
                )
            }),
        );
    });
}

// ===== 单元测试 =====

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BridgeConfig;
    use crate::db;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 回归测试：import_config 写入新的 `allowed_roots` 后**必须**刷新白名单缓存
    /// （`canonicalized_roots`），否则 `cached_roots()` 仍指向旧 roots，导致后续所有
    /// 走 `state.cached_roots()` 的工具校验误放行/误拒绝。
    ///
    /// 复现 #1-A 复审发现的 `import_config` 漏刷缓存 bug：若有人把
    /// `import_config_inner` 里的 `refresh_canonicalized_roots(...)` 一行删掉，
    /// 本测试的"缓存必须等于新 roots"断言会直接失败——这正是本测试存在的意义。
    #[tokio::test]
    async fn import_config_refreshes_cached_roots() {
        // 两个不同目录，确保"导入后缓存是否跟着变"可被明确测出（若用同一目录则无差异）。
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir_a: PathBuf = std::env::temp_dir().join(format!(
            "cc-bridge-import-test-a-{}-{}-{}",
            std::process::id(),
            n,
            "a"
        ));
        let dir_b: PathBuf = std::env::temp_dir().join(format!(
            "cc-bridge-import-test-b-{}-{}-{}",
            std::process::id(),
            n,
            "b"
        ));
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
        std::fs::create_dir_all(&dir_a).expect("create dir_a");
        std::fs::create_dir_all(&dir_b).expect("create dir_b");

        let root_a = dir_a.to_string_lossy().into_owned();
        let root_b = dir_b.to_string_lossy().into_owned();

        // 初始 state：白名单 = [dir_a]
        let conn = db::init_database(Path::new(&dir_a)).expect("init db");
        let cfg = BridgeConfig {
            allowed_roots: vec![root_a.clone()],
            ..BridgeConfig::default()
        };
        let state = Arc::new(AppState::new(conn, cfg, dir_a.clone()));

        // 导入前：缓存必须等于 [dir_a] 的 canonicalize 结果
        let expected_a =
            crate::security::path::canonicalize_roots(&state.config.read().await.allowed_roots);
        assert_eq!(
            state.cached_roots(),
            expected_a,
            "导入前缓存应等于 [dir_a] 的 canonicalize"
        );

        // 构造 incoming 配置，白名单改为 [dir_b]
        let incoming = BridgeConfig {
            allowed_roots: vec![root_b.clone()],
            ..BridgeConfig::default()
        };
        let json = serde_json::to_string(&incoming).expect("serialize config");

        // 直达纯逻辑入口（不经过 restart_server，无端口副作用）
        let result = super::import_config_inner(&state, &json).await;
        assert!(result.is_ok(), "import_config 应成功：{:?}", result.err());

        // 导入后 1：config 自身必须已更新为 [dir_b]
        let cfg_roots = state.config.read().await.allowed_roots.clone();
        assert_eq!(
            cfg_roots,
            vec![root_b.clone()],
            "导入后 config.allowed_roots 应更新为 [dir_b]"
        );

        // 导入后 2（关键）：缓存必须同步刷新为 [dir_b]，否则白名单校验会误放行/误拒绝
        let expected_b = crate::security::path::canonicalize_roots(&cfg_roots);
        assert_eq!(
            state.cached_roots(),
            expected_b,
            "导入后缓存必须刷新为 [dir_b] 的 canonicalize，否则白名单校验会误放行/误拒绝"
        );

        // 导入后 3：缓存不应仍停留在导入前的旧 roots（删掉刷新行时此断言必败）
        assert_ne!(
            state.cached_roots(),
            expected_a,
            "缓存不应仍指向导入前的旧 roots [dir_a]"
        );

        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }
}
