//! `get_status` 与它的四个响应结构体（`StatusResponse` / `RateLimitInfo` /
//! `StatsInfo` / `ToolCount`）。
//!
//! D19 方案 C 第 3 批。这一块只有 1 个命令却占 416 行——绝大部分是那四个结构体
//! 与 `get_status` 里的聚合逻辑（配置快照、统计、限流、LAN 地址、工具计数、
//! 防火墙状态缓存、平台标识）。前端每 5s 轮询它，所以它同时是性能话题
//! （见清单 M2/M14）的主角。
//!
//! 本文件是**纯搬动**：函数体逐字节未改，可用 `tools/fingerprint.py` 比对哈希验证。

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::backup;
use crate::network;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub version: String,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: u64,
    #[serde(rename = "allowedRoots")]
    pub allowed_roots: Vec<String>,
    /// 白名单配置组（存档）与当前组名。仅服务「按项目切换」这个 UI 能力，
    /// **不参与安全判定**——当前生效集合永远是上面的 `allowed_roots`。
    #[serde(rename = "rootProfiles")]
    pub root_profiles: Vec<crate::config::RootProfile>,
    #[serde(rename = "activeProfile")]
    pub active_profile: String,
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
    /// 用户上次接入确认的项目路径（project 作用域时生效）。由连接页保存。
    /// None 表示未指定；连接页据此回填，避免每次进入被重置为 null。
    #[serde(rename = "projectPath")]
    pub project_path: Option<String>,
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
    /// 命令白名单开关（Layer 2，opt-in，④P0-1）。前端「安全」页读写。
    #[serde(rename = "commandAllowlistEnabled")]
    pub command_allowlist_enabled: bool,
    /// 命令白名单程序列表（Layer 2，④P0-1）。前端「安全」页读写。
    #[serde(rename = "commandAllowlist")]
    pub command_allowlist: Vec<String>,
    /// 后台命令完成通知开关。默认开启——后台命令结束后自动推 Windows toast。
    #[serde(rename = "notifyCommandComplete")]
    pub notify_command_complete: bool,
    /// 任务完成通知开关（push_notification MCP 工具总开关）。默认开启。
    #[serde(rename = "notifyTaskComplete")]
    pub notify_task_complete: bool,
    /// 关窗时释放界面内存。默认开启（关窗销毁 webview，托盘常驻约 85MB → 5.5MB）。
    #[serde(rename = "releaseWebviewOnClose")]
    pub release_webview_on_close: bool,
    /// 运行平台：`"windows"` / `"macos"` / `"linux"`（取 `std::env::consts::OS`）。
    ///
    /// 为何由后端下发而不是前端自己探：这是**编译期常量**，比嗅探
    /// `navigator.userAgent` 可靠，也不用为此引入 `@tauri-apps/plugin-os` 依赖。
    /// 前端据此隐藏 Windows 专属 UI（防火墙卡片/告警）与切换快捷键标签（⌘ / Ctrl）。
    pub platform: String,
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
    let uptime = state.uptime_seconds().await;
    let running = state.mcp_running.load(std::sync::atomic::Ordering::Relaxed);
    let startup_error = state.startup_error.lock().unwrap().clone();
    let lan_ips = state.cached_lan_ips();

    // 先用一次**短锁**取出下面三处慢操作要用的少量字段，随即释放。
    //
    // 为何这么做：本函数有三处慢操作——首次防火墙查询（netsh，可达数百 ms）、
    // 可达性探针（TCP connect，最长 200ms）、备份目录统计（磁盘枚举，实测 2.3ms /
    // 1230 个文件）。原实现把 config 读锁从函数开头一路罩到末尾，于是前端每 5s 轮询
    // 一次，就造出一个最长 200ms+ 的窗口，期间任何配置写入（用户在设置页改东西）
    // 都得排队等这把锁。读锁只应用来读内存，不应罩住 I/O 与 await。
    let (probe_host, port, backup_dir_name) = {
        let config = state.config.read().await;
        let probe_host = network::resolve_display_host(
            &config.host,
            &lan_ips,
            config.last_selected_ip.as_deref(),
        );
        (probe_host, config.port, config.backup_dir.clone())
    };

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
                let (e, p) = crate::firewall::query_firewall_state(port);
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
    // S1: 远程链路可达性探针。对远程客户端应当连接的展示地址（与连接命令一致）
    // 做 TCP 探测（超时 200ms）。running 为 false 时不探测，直接不可达。
    // 这是「远程连接中断」状态机的真实信号源，区别于 ip_changed（仅文本地址变化）。
    // 不降频的理由：不可达时用户正盯着「连接中断」状态等恢复，拉长周期会直接
    // 拖慢恢复提示；而窗口不可见时前端已经完全停了轮询（见 lib/appVisibility.ts），
    // 常驻开销本来就已归零。
    let remote_reachable = if !running {
        false
    } else {
        matches!(
            timeout(
                Duration::from_millis(200),
                TcpStream::connect((probe_host.as_str(), port)),
            )
            .await,
            Ok(Ok(_))
        )
    };

    // 备份目录绝对路径 + 统计（扫一次磁盘，供设置页展示）。同样放在锁外。
    let backup_dir_abs = state
        .data_dir
        .join(&backup_dir_name)
        .to_string_lossy()
        .into_owned();
    let (backup_count, backup_total_bytes) =
        backup::backup_stats(&state.data_dir, &backup_dir_name);

    // ── 慢操作到此结束，现在才取锁读其余字段（全是内存读，微秒级）。──
    let config = state.config.read().await;
    let stats = state.stats.read().await;

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

    Ok(StatusResponse {
        version: env!("CARGO_PKG_VERSION").into(),
        uptime_seconds: uptime,
        allowed_roots: config.allowed_roots.clone(),
        root_profiles: config.root_profiles.clone(),
        active_profile: config.active_profile.clone(),
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
        project_path: config.project_path.clone(),
        startup_error,
        lan_ips,
        firewall_enabled,
        firewall_port_open,
        firewall_available,
        command_allowlist_enabled: config.command_allowlist_enabled,
        command_allowlist: config.command_allowlist.clone(),
        notify_command_complete: config.notify_command_complete,
        notify_task_complete: config.notify_task_complete,
        release_webview_on_close: config.release_webview_on_close,
        platform: std::env::consts::OS.to_string(),
    })
}
