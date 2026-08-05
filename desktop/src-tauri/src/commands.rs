use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use similar::TextDiff;
// Manager 只被 create_desktop_shortcut_impl 的 Windows 版用到（app.path()），
// 放这里会让 mac 的 `clippy --all-targets -D warnings` 因未用导入直接失败，
// 所以改成在那个函数内部局部 use。
use tauri::{AppHandle, Emitter, State};
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

// D19 方案 C 第 1 批：自动更新拆到 commands/update.rs。
// `pub use` 是为了让 `commands::start_update` 这个路径保持不变——main.rs 的
// `invoke_handler!` 有 42 项，改路径等于改 42 处，且拆分本身不该让调用方感知。
mod update;
pub use update::*;

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
    /// 用户接入时确认的项目路径（项目级 scope 时用于 cd 前缀）。
    /// 跟随连接页选择，供托盘「复制 IP 替换命令」生成带 cd 的精确命令，与 IpChangedBanner 对齐。
    #[serde(rename = "projectPath")]
    pub project_path: Option<String>,
    /// 命令白名单开关（Layer 2，④P0-1）。前端「安全」页写入。
    #[serde(rename = "commandAllowlistEnabled")]
    pub command_allowlist_enabled: Option<bool>,
    /// 命令白名单程序列表（Layer 2，④P0-1）。前端「安全」页写入。
    #[serde(rename = "commandAllowlist")]
    pub command_allowlist: Option<Vec<String>>,
    /// 后台命令完成通知开关。前端「功能开关」卡写入。
    #[serde(rename = "notifyCommandComplete")]
    pub notify_command_complete: Option<bool>,
    /// 任务完成通知开关（push_notification 工具总开关）。前端「功能开关」卡写入。
    #[serde(rename = "notifyTaskComplete")]
    pub notify_task_complete: Option<bool>,
    /// 关窗时释放界面内存。前端「功能开关」卡写入。
    #[serde(rename = "releaseWebviewOnClose")]
    pub release_webview_on_close: Option<bool>,
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
                // 先持久化再改内存：若 save_config_field 失败（`?` 提前返回），内存不会领先于
                // DB。旧顺序先改内存后写盘，写盘失败时内存已变、DB 未变，产生不一致。
                save_config_field(&db, $key, &serde_json::to_value(&v).unwrap())?;
                config.$field = v.clone();
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
    // Layer 2 命令白名单（④P0-1）：开关 + 程序列表。仅当二者均被提供时更新。
    apply_field!(
        command_allowlist_enabled,
        "command_allowlist_enabled",
        &patch.command_allowlist_enabled
    );
    apply_field!(
        command_allowlist,
        "command_allowlist",
        &patch.command_allowlist
    );
    // 通知开关
    apply_field!(
        notify_command_complete,
        "notify_command_complete",
        &patch.notify_command_complete
    );
    apply_field!(
        notify_task_complete,
        "notify_task_complete",
        &patch.notify_task_complete
    );
    apply_field!(
        release_webview_on_close,
        "release_webview_on_close",
        &patch.release_webview_on_close
    );
    // 首次接入复制命令时由前端写入，记录 cc-bridge 被注册到远程的作用域，
    // 供后续 IP 变化 / Token 重生成生成精确 sed 命令（方案 A）。
    // scope 在 config 中也是 Option<String>，与 apply_field! 宏的 "T vs Option<T>" 假设不符，故单独处理。
    if let Some(ref s) = patch.scope {
        save_config_field(&db, "scope", &serde_json::to_value(s).unwrap())?;
        config.scope = Some(s.clone());
        changed.push("scope".into());
    }
    // project_path 同 scope 为 Option<String>，apply_field! 宏假设不符，单独处理。
    if let Some(ref p) = patch.project_path {
        save_config_field(&db, "project_path", &serde_json::to_value(p).unwrap())?;
        config.project_path = Some(p.clone());
        changed.push("project_path".into());
    }

    if let Some(ref h) = patch.host {
        if *h != config.host {
            save_config_field(&db, "host", &serde_json::to_value(h).unwrap())?;
            config.host = h.clone();
            changed.push("host".into());
            restart_required = true;
        }
    }
    if let Some(p) = patch.port {
        if p != config.port {
            save_config_field(&db, "port", &serde_json::to_value(p).unwrap())?;
            config.port = p;
            changed.push("port".into());
            restart_required = true;
        }
    }

    // 反向同步：在当前组里增删目录时，把生效集合写回该组的存档。
    // 不同步的后果：“切走再切回来”会用旧存档覆盖掉刚改的目录，看起来就像改动丢了。
    // 注意方向：`allowed_roots` 仍是唯一事实源，这里只是让存档跟上它。
    if patch.allowed_roots.is_some() {
        let active = config.active_profile.clone();
        let roots = config.allowed_roots.clone();
        if let Some(p) = config.root_profiles.iter_mut().find(|p| p.name == active) {
            p.roots = roots;
        }
        save_config_field(
            &db,
            "root_profiles",
            &serde_json::to_value(&config.root_profiles).unwrap(),
        )?;
    }

    // 保留天数一变就后台跑一次清理，不再等下次启动。
    // 原行为：`save_config` 只存值，而清理只在启动时跑——用户把 30 天改成 7 天后
    // 什么都不会发生，很容易误以为改完就生效了。
    // 放后台：大 audit.log 的重写可能耗时，不能卡住保存配置这个交互
    // （与启动那次同理，E-P2-4 当时就是为此改成后台的）。
    if patch.audit_retention_days.is_some() {
        let dir = state.data_dir.clone();
        let retention = config.audit_retention_days;
        tauri::async_runtime::spawn(async move {
            match audit::cleanup_old_entries(&dir, retention) {
                Ok(0) => {}
                Ok(n) => log::info!("保留天数改为 {retention} 天，已删除 {n} 条过期审计记录"),
                Err(e) => log::warn!("保留天数变更后清理审计日志失败：{e}"),
            }
        });
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

// ===== 白名单配置组（按项目切换）=====
//
// 安全要点：以下命令**只**经 Tauri invoke 暴露给本机面板，不注册为 MCP 工具——
// 远程 AI 不能自行更换自己的可访问范围。这是选「人工切换配置组」而非
// 「按远程项目自动切」的核心理由。
//
// 另一个要点：切换组 = 把该组 roots 写进 `allowed_roots`，然后跑与 `save_config`
// 完全相同的收尾（持久化 → 刷新 canonicalize 缓存）。不新增任何安全关键路径。

/// 组名校验：去首尾空白 → 非空 → 长度上限 → 不重名。
/// `allow_same` 传重命名时的原名（允许改成自己，否则“只改大小写”之类会被误判重名）。
/// 重名直接拒绝而不自动加后缀：两个看起来一样的组比报错更害人。
fn validate_profile_name(
    name: &str,
    existing: &[crate::config::RootProfile],
    allow_same: Option<&str>,
) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("组名不能为空".into());
    }
    if n.chars().count() > 40 {
        return Err("组名过长（最多 40 字）".into());
    }
    if existing
        .iter()
        .any(|p| p.name == n && Some(p.name.as_str()) != allow_same)
    {
        return Err(format!("已存在同名配置组「{n}」"));
    }
    Ok(n.to_string())
}

/// 新建配置组。`copy_current=true` 时用当前生效集合作为初内容，否则建空组。
/// `switch=true` 则建完立即切过去。
#[tauri::command]
pub async fn create_root_profile(
    state: State<'_, Arc<AppState>>,
    name: String,
    copy_current: bool,
    switch: bool,
) -> Result<(), String> {
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    let clean = validate_profile_name(&name, &config.root_profiles, None)?;
    let roots = if copy_current {
        config.allowed_roots.clone()
    } else {
        vec![]
    };
    config.root_profiles.push(crate::config::RootProfile {
        name: clean.clone(),
        roots: roots.clone(),
    });
    save_config_field(
        &db,
        "root_profiles",
        &serde_json::to_value(&config.root_profiles).unwrap(),
    )?;
    if switch {
        apply_profile_switch(&db, &mut config, &clean, roots)?;
    }
    drop(config);
    state.refresh_canonicalized_roots(&state.config.read().await.allowed_roots);
    Ok(())
}

/// 删除配置组。**只删这份目录清单，不碰目录里的任何文件。**
/// 两条护栏：不能删当前组（否则生效集合无归属），也不能删到一个不剩。
#[tauri::command]
pub async fn delete_root_profile(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<(), String> {
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    if config.active_profile == name {
        return Err("不能删除当前使用中的配置组，请先切到其它组".into());
    }
    if config.root_profiles.len() <= 1 {
        return Err("至少需保留一个配置组".into());
    }
    let before = config.root_profiles.len();
    config.root_profiles.retain(|p| p.name != name);
    if config.root_profiles.len() == before {
        return Err(format!("配置组「{name}」不存在"));
    }
    save_config_field(
        &db,
        "root_profiles",
        &serde_json::to_value(&config.root_profiles).unwrap(),
    )?;
    Ok(())
}

/// 重命名配置组。改的是当前组时，`active_profile` 指针要跟着改，
/// 否则下次 `normalize_profiles` 会因为“指针指向不存在的组”而默默回落到第一个组。
#[tauri::command]
pub async fn rename_root_profile(
    state: State<'_, Arc<AppState>>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    let clean = validate_profile_name(&new_name, &config.root_profiles, Some(&old_name))?;
    match config.root_profiles.iter_mut().find(|p| p.name == old_name) {
        Some(p) => p.name = clean.clone(),
        None => return Err(format!("配置组「{old_name}」不存在")),
    }
    save_config_field(
        &db,
        "root_profiles",
        &serde_json::to_value(&config.root_profiles).unwrap(),
    )?;
    if config.active_profile == old_name {
        config.active_profile = clean;
        save_config_field(
            &db,
            "active_profile",
            &serde_json::to_value(&config.active_profile).unwrap(),
        )?;
    }
    Ok(())
}

/// 切换到指定配置组：把该组 roots 写进生效集合，并刷新白名单缓存 + 记审计。
///
/// 已在跑的后台命令不会被杀，但它后续经 cc-bridge 的文件操作按**新**白名单校验。
#[tauri::command]
pub async fn switch_root_profile(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<(), String> {
    switch_root_profile_inner(&state, &name).await
}

/// 纯逻辑入口（与 `import_config_inner` 同一套路）：不依赖 Tauri `State`，
/// 便于单元测试直达——「切换后必须刷新白名单缓存」这条安全不变量得能被测出来。
pub(crate) async fn switch_root_profile_inner(
    state: &Arc<AppState>,
    name: &str,
) -> Result<(), String> {
    let name = name.to_string();
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    let from = config.active_profile.clone();
    let roots = config
        .root_profiles
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| format!("配置组「{name}」不存在"))?
        .roots
        .clone();
    let count = roots.len();
    apply_profile_switch(&db, &mut config, &name, roots)?;
    drop(config);
    drop(db);

    // 刷新 canonicalize 缓存——漏了这一步就是安全缺陷：UI 显示已切换，
    // 而路径校验还在用旧根目录（import_config 历史上正是漏在这里，有回归测试）。
    state.refresh_canonicalized_roots(&state.config.read().await.allowed_roots);

    let entry = audit::new_entry(
        "switch_root_profile",
        &serde_json::json!({ "from": from, "to": name, "rootCount": count }).to_string(),
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
    let _ = audit::write_audit_log(&state.data_dir, &entry);
    Ok(())
}

/// 切换的共用写入：先落盘再改内存（与 save_config 的 apply_field! 同一约定，
/// 避免写盘失败时内存领先于 DB）。不在此刷缓存：谁持有锁谁负责，由调用方
/// 释锁后统一刷。
fn apply_profile_switch(
    db: &rusqlite::Connection,
    config: &mut crate::config::BridgeConfig,
    name: &str,
    roots: Vec<String>,
) -> Result<(), String> {
    save_config_field(db, "allowed_roots", &serde_json::to_value(&roots).unwrap())?;
    save_config_field(db, "active_profile", &serde_json::to_value(name).unwrap())?;
    config.allowed_roots = roots;
    config.active_profile = name.to_string();
    Ok(())
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

#[tauri::command(rename_all = "snake_case")]
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

/// 按当前保留天数**立即**清理一次，返回删掉的条数（供前端提示「已清理 N 条」）。
///
/// 为何需要它：之前手动只有「清空全部」（`clear_audit_log`，直接删整个文件），
/// 想「只删旧的、留最近几天」唯一办法是改保留天数然后重启应用——中间没任何反馈。
/// 这个命令把那个中间档补上了。
#[tauri::command]
pub async fn cleanup_audit_now(state: State<'_, Arc<AppState>>) -> Result<u64, String> {
    let retention = state.config.read().await.audit_retention_days;
    let removed = audit::cleanup_old_entries(&state.data_dir, retention)?;
    log::info!("手动清理审计日志：已删除 {removed} 条（保留 {retention} 天）");
    Ok(removed)
}

// ===== 备份高级清理（设计稿：design/备份与审计-高级清理-设计稿.html）=====

#[derive(Debug, Serialize)]
pub struct BackupCleanupPreview {
    /// 待删份数
    pub count: u32,
    #[serde(rename = "freedBytes")]
    pub freed_bytes: u64,
    #[serde(rename = "totalBytesBefore")]
    pub total_bytes_before: u64,
    #[serde(rename = "totalCountBefore")]
    pub total_count_before: u32,
    /// 执行后将不再有任何备份的原文件（预览里那行红字）。
    #[serde(rename = "filesLosingAll")]
    pub files_losing_all: Vec<String>,
    /// **待删备份的完整路径列表**——前端原样回传给 `cleanup_backups`。
    ///
    /// 这是「预览 == 执行」真正的实现方式。共用同一个 `plan_cleanup` **函数**并不够：
    /// 两个命令各自重扫目录、各自取一次 `now()`，于是预览到确认之间只要发生一次
    /// MCP 写操作（这正是本应用的主业）新增了 `.bak`，或 cutoff 随时间前移，
    /// 实际删除集合就不等于用户确认过的那个集合——恰好就是注释里反复承诺不会发生的
    /// 「预览说删 847、实际删了 900」。
    pub victims: Vec<String>,
}

/// 把前端传的 mode 字符串转成强类型。非法值直接报错——删除操作不容许“猜一个默认”。
fn parse_cleanup_mode(
    mode: &str,
    days: Option<u32>,
    target_mb: Option<u64>,
) -> Result<backup::CleanupMode, String> {
    match mode {
        "olderThanDays" => days
            .filter(|d| *d > 0)
            .map(backup::CleanupMode::OlderThanDays)
            .ok_or_else(|| "按时间清理需提供大于 0 的天数".to_string()),
        // 与 days 一样必须 > 0：目标 0 字节等于全删，但用户以为自己在「清到 300MB」。
        // 想全删必须显式选「全部清空」（`cleanup_audit_before` 已经立了这个规矩）。
        "toTotalMb" => target_mb
            .filter(|mb| *mb > 0)
            .map(|mb| backup::CleanupMode::ToTotalBytes(mb.saturating_mul(1024 * 1024)))
            .ok_or_else(|| {
                "按体积清理需提供大于 0 的目标大小（想全删请选「全部清空」）".to_string()
            }),
        "all" => Ok(backup::CleanupMode::All),
        other => Err(format!("未知的清理方式：{other}")),
    }
}

/// 预览清理（**无副作用**）。与执行共用 `backup::plan_cleanup` 这一份筛选实现，
/// 所以不会出现「预览说删 847、实际删了 900」这类偏差。
#[tauri::command]
pub async fn preview_backup_cleanup(
    state: State<'_, Arc<AppState>>,
    mode: String,
    days: Option<u32>,
    target_mb: Option<u64>,
    keep_last_one: bool,
) -> Result<BackupCleanupPreview, String> {
    let m = parse_cleanup_mode(&mode, days, target_mb)?;
    let backup_dir = state.config.read().await.backup_dir.clone();
    let db = state.db.lock().await;
    let items = backup::list_backup_items(&state.data_dir, &backup_dir, &db)
        .ok_or_else(|| "读不到备份目录（不存在 / 权限不足 / 所在盘未就绪）".to_string())?;
    drop(db);
    let plan = backup::plan_cleanup(&items, &m, keep_last_one);
    Ok(BackupCleanupPreview {
        count: plan.victims.len() as u32,
        freed_bytes: plan.freed_bytes,
        total_bytes_before: plan.total_bytes_before,
        total_count_before: plan.total_count_before,
        files_losing_all: plan.files_losing_all,
        victims: plan
            .victims
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    })
}

#[derive(Debug, Serialize)]
pub struct BackupCleanupResult {
    pub removed: u32,
    #[serde(rename = "freedBytes")]
    pub freed_bytes: u64,
    /// 顺手清掉的孤儿索引行数（历史上绕过面板手删备份遗留的）。
    #[serde(rename = "healedIndexRows")]
    pub healed_index_rows: u32,
    /// 删失败的份数（被杀软/编辑器占用、只读属性等）。
    /// 不能吞：预览说 900、实际只删了 3 而不给解释，用户无法判断发生了什么。
    pub failed: u32,
}

/// 删备份写审计。三个删除命令（批量/单份/整组）共用它——三者同样不可逆，
/// 一次能干掉几百个版本，不能只给批量那条留痕。
fn audit_backup_deletion(data_dir: &std::path::Path, action: &str, detail: serde_json::Value) {
    let entry = audit::new_entry(
        action,
        &detail.to_string(),
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
    if let Err(e) = audit::write_audit_log(data_dir, &entry) {
        log::warn!("写入删备份审计失败：{e}");
    }
}

/// 执行清理。**只删 `victims` 里的路径**，即预览返回、用户看到并确认过的那一份清单。
///
/// 为何不重新根据条件算一遍（原先的写法）：预览到确认之间只要发生一次 MCP 写操作
/// 就会新增 `.bak`，或自动裁剪删掉几个，或 cutoff 随 `now()` 前移——实际删除集合
/// 就不等于用户确认过的集合。后新增的备份因为不在清单里而不会被删，这是对的：
/// 用户没确认过它们。
///
/// `mode`/`days`/`target_mb`/`keep_last_one` 已不参与筛选，**仅用于审计记录**当时的条件。
#[tauri::command]
pub async fn cleanup_backups(
    state: State<'_, Arc<AppState>>,
    victims: Vec<String>,
    mode: String,
    days: Option<u32>,
    target_mb: Option<u64>,
    keep_last_one: bool,
) -> Result<BackupCleanupResult, String> {
    if victims.is_empty() {
        return Err("没有待删备份（请先重新预览）".into());
    }
    let backup_dir_name = state.config.read().await.backup_dir.clone();

    // 每一条路径都重新过一次「必须落在备份目录内且是 .bak」的校验。
    // 前端传什么都不能直接信，复用已有的 `assert_backup_path_in_scope`（安全模块不另写一套）。
    let mut targets: Vec<PathBuf> = Vec::with_capacity(victims.len());
    for v in &victims {
        targets.push(assert_backup_path_in_scope(
            v,
            &state.data_dir,
            &backup_dir_name,
        )?);
    }

    // 删文件全程**不持 db 锁**，并且丢到 spawn_blocking：备份可能上万，
    // 原先持锁删完所有文件会把 write_files/edit_files 等全部 MCP 写操作
    // （它们写备份索引也要同一把锁）卡在那里数十秒，同时还挂住一个 tokio worker。
    let (deleted, freed, failed) = tokio::task::spawn_blocking(move || {
        backup::delete_files_bulk(&targets)
    })
    .await
    .map_err(|e| format!("清理任务异常结束：{e}"))?;
    let removed = deleted.len() as u32;

    let db = state.db.lock().await;
    backup::purge_index_rows(&db, &deleted);
    // 自愈孤儿索引前先确认备份目录**真的读得到**：读不到时绝不能把索引行当孤儿清掉。
    let dir_readable =
        backup::list_backup_items(&state.data_dir, &backup_dir_name, &db).is_some();
    let healed = if dir_readable {
        backup::heal_orphan_index(&db, &state.data_dir.join(&backup_dir_name))
    } else {
        log::warn!("备份目录不可读，跳过孤儿索引自愈");
        0
    };
    drop(db);

    audit_backup_deletion(
        &state.data_dir,
        "cleanup_backups",
        serde_json::json!({
            "mode": mode, "days": days, "targetMb": target_mb,
            "keepLastOne": keep_last_one, "confirmed": victims.len(),
            "removed": removed, "failed": failed, "freedBytes": freed
        }),
    );
    log::info!(
        "清理备份：确认 {} 个，删除 {removed} 个，失败 {failed} 个，释放 {freed} 字节，修复孤儿索引 {healed} 行",
        victims.len()
    );
    Ok(BackupCleanupResult {
        removed,
        freed_bytes: freed,
        healed_index_rows: healed,
        failed,
    })
}

/// 删单份备份（版本历史逐行）。路径必须落在备份目录内且以 .bak 结尾——
/// 复用已有的 `assert_backup_path_in_scope`，不另写一套校验（安全模块不削弱）。
#[tauri::command]
pub async fn delete_backup(
    state: State<'_, Arc<AppState>>,
    backup_path: String,
) -> Result<u64, String> {
    let backup_dir = state.config.read().await.backup_dir.clone();
    let canon = assert_backup_path_in_scope(&backup_path, &state.data_dir, &backup_dir)?;
    let size = std::fs::metadata(&canon).map(|m| m.len()).unwrap_or(0);
    std::fs::remove_file(&canon).map_err(|e| format!("删除备份失败：{e}"))?;
    let db = state.db.lock().await;
    let _ = db.execute(
        "DELETE FROM backup_index WHERE backup_path = ?1",
        rusqlite::params![canon.to_string_lossy().into_owned()],
    );
    drop(db);
    audit_backup_deletion(
        &state.data_dir,
        "delete_backup",
        serde_json::json!({ "backupPath": canon.to_string_lossy(), "freedBytes": size }),
    );
    Ok(size)
}

/// 删某原文件的**全部**备份（分组头一键）。返回 (删除数, 释放字节)。
#[tauri::command]
pub async fn delete_backups_of_file(
    state: State<'_, Arc<AppState>>,
    original_path: String,
) -> Result<BackupCleanupResult, String> {
    let backup_dir = state.config.read().await.backup_dir.clone();
    let db = state.db.lock().await;
    let items = backup::list_backup_items(&state.data_dir, &backup_dir, &db)
        .ok_or_else(|| "读不到备份目录（不存在 / 权限不足 / 所在盘未就绪）".to_string())?;
    // 只选属于该原文件的，然后走与批量清理同一条执行路径。
    //
    // 两种口径都认：`BackupItem.original` 优先取索引里的**完整原路径**，而版本历史
    // （`list_backups`）是按**备份文件名推导出的原文件名**分组的。前端从分组头传过来的
    // 是后者，如果只比 `i.original`，有索引记录的备份（绝大多数）一个都匹配不上。
    // 按名匹配会把不同目录的同名文件一起删——但那正是用户在分组里看到的内容。
    let mine: Vec<backup::BackupItem> = items
        .into_iter()
        .filter(|i| {
            i.original == original_path
                || backup::original_from_backup_name(&i.path) == original_path
        })
        .collect();
    if mine.is_empty() {
        return Err("该文件没有备份".into());
    }
    // 此处故意不给底线：用户明确要删这个文件的全部备份，前端会弹确认。
    let plan = backup::plan_cleanup(&mine, &backup::CleanupMode::All, false);
    let (deleted, freed, failed) = backup::delete_files_bulk(&plan.victims);
    let removed = deleted.len() as u32;
    backup::purge_index_rows(&db, &deleted);
    drop(db);
    audit_backup_deletion(
        &state.data_dir,
        "delete_backups_of_file",
        serde_json::json!({
            "originalPath": original_path, "removed": removed,
            "failed": failed, "freedBytes": freed
        }),
    );
    Ok(BackupCleanupResult {
        removed,
        freed_bytes: freed,
        healed_index_rows: 0,
        failed,
    })
}

/// 审计：按**临时**天数清一次，不改配置里的保留天数。
/// 与备份侧「清理早于 N 天」操作心智一致。
#[tauri::command]
pub async fn cleanup_audit_before(
    state: State<'_, Arc<AppState>>,
    days: u32,
) -> Result<u64, String> {
    if days == 0 {
        return Err("天数需大于 0（想全删请用日志页的「清空全部」）".into());
    }
    let removed = audit::cleanup_old_entries(&state.data_dir, days)?;
    log::info!("按临时天数清理审计日志：早于 {days} 天的已删 {removed} 条");
    Ok(removed)
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

/// 安装位置：Windows 上就是 exe 所在目录；macOS 上要**从 .app 包内部走出来**。
///
/// mac 的 `current_exe()` 落在 `…/cc-bridge.app/Contents/MacOS/cc-bridge-desktop`，
/// 直接取 parent 得到的是 `Contents/MacOS`——展示给用户是一串包内部路径，
/// 再交给 reveal_item_in_dir 更是直接把访达跳进「显示包内容」。
/// 所以往上三层找 `.app` 本体：MacOS → Contents → *.app。
/// 任一层不符（开发模式下 target/debug 里的裸二进制）就按原样返回 parent。
fn resolve_install_dir() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位自身路径: {e}"))?;
    let dir = exe.parent().ok_or_else(|| "无法解析安装目录".to_string())?;
    #[cfg(target_os = "macos")]
    if let Some(bundle) = dir.parent().and_then(|contents| contents.parent()) {
        if bundle.extension().is_some_and(|ext| ext == "app") {
            return Ok(bundle.to_string_lossy().into_owned());
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// 返回软件安装位置，用于前端「安装位置」展示。
/// 发布版：Windows 是安装目录、macOS 是 `.app` 本体；开发模式指向 target/debug。
#[tauri::command]
pub fn install_dir() -> Result<String, String> {
    resolve_install_dir()
}

/// 在系统文件管理器中打开（定位）安装位置。
/// 使用 tauri-plugin-opener 的 reveal_item_in_dir（Windows 底层 SHOpenFolderAndSelectItems，
/// macOS 走 NSWorkspace 在访达里选中目标），不产生子进程、不闪 cmd 窗口；
/// 项目已依赖并注册 opener 插件（Cargo.toml:18 / main.rs:137）。
/// 同时返回该路径字符串，便于前端展示。
#[tauri::command]
pub fn reveal_install_dir() -> Result<String, String> {
    let dir = resolve_install_dir()?;
    tauri_plugin_opener::reveal_item_in_dir(&dir).map_err(|e| format!("打开安装目录失败: {e}"))?;
    Ok(dir)
}

/// 在桌面创建（或覆盖）指向本程序的快捷方式。**仅 Windows**，见下方两份 impl。
#[tauri::command]
pub fn create_desktop_shortcut(app: tauri::AppHandle) -> Result<(), String> {
    create_desktop_shortcut_impl(app)
}

/// 非 Windows 没有 .lnk 这回事：macOS 上应用装在 /Applications、入口是 Dock 与启动台，
/// 桌面本来就不放图标。前端已按平台隐藏这一行（SettingsTab.tsx 的 InstallGroup），
/// 这里再兜一层明确报错——否则会一路走到 Windows 版里去 spawn `powershell`，
/// mac 上拿到的是「No such file or directory」这种看不出所以然的底层错误。
#[cfg(not(windows))]
fn create_desktop_shortcut_impl(_app: tauri::AppHandle) -> Result<(), String> {
    Err("桌面快捷方式仅 Windows 支持；macOS 请把 cc-bridge.app 拖到 Dock 或从启动台打开".into())
}

/// 复用系统 WScript.Shell COM（零 Rust 依赖，守规则8），普通用户权限即可，
/// 桌面为当前用户可写目录，无需 UAC 提权。用户确认：已存在同名 lnk 直接覆盖。
/// 桌面路径优先取 USERPROFILE\Desktop，失败回退 Tauri desktop_dir()。
#[cfg(windows)]
fn create_desktop_shortcut_impl(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager; // app.path()；仅此处需要，见文件顶部 use 行的注释
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
    let mut cmd = std::process::Command::new("powershell");
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW：隐藏 powershell 控制台窗口，避免闪黑框
    let out = cmd
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

/// 本机面板的「终止」按钮：移除注册表条目并显式整树终止，逻辑与 MCP 的 stop_command 工具一致。
#[tauri::command]
pub async fn stop_running_command(
    state: State<'_, Arc<AppState>>,
    handle: String,
) -> Result<(), String> {
    let entry = state
        .running_commands
        .remove(&handle)
        .ok_or_else(|| format!("未知的 handle: {handle}"))?;
    // 必须显式 start_kill：process-wrap 的 JobObject 默认不 kill-on-close，drop 不会杀进程
    // （见 Cargo.toml:95 注释）。仅 drop 会让后台命令成孤儿进程、输出读取线程泄漏。
    // child 是 Box<dyn StdChildWrapper>，对 trait object 调 start_kill 无需额外 use。
    if let Ok(mut guard) = entry.1.child.lock() {
        let _ = guard.start_kill();
    }
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
    let readonly_mode = config.readonly_mode;
    let allowed_extensions = config.allowed_extensions.clone();

    // 1) 安全校验 backup_path
    let bak_canon = assert_backup_path_in_scope(&backup_path, &data_dir, &backup_dir)?;
    // 2) 白名单校验 target（安全模块不削弱）
    let resolved = path::resolve_safe_path_cached(
        &target_path,
        &state.cached_roots(),
        config.whitelist_enabled,
    )?;
    drop(config);

    // 回滚也是写操作：与写工具一致，只读模式下拒绝、并校验扩展名白名单，
    // 避免经回滚通道绕过只读闸门或向非白名单扩展名写入。
    if readonly_mode {
        return Err("只读模式已开启，禁止恢复文件（写操作被拦截）".into());
    }
    crate::security::extension::assert_extension_allowed(&resolved, &allowed_extensions)?;

    // 3) 还原前再备一次（可继续撤销）——仅当目标已存在
    let mut new_backup: Option<PathBuf> = None;
    if resolved.exists() {
        let db = state.db.lock().await;
        new_backup = backup::backup_before_overwrite(&resolved, &backup_dir, &data_dir, &db)?;
        backup::prune_backups(&resolved, &backup_dir, &data_dir, backup_retention, &db)?;
        drop(db);
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
    #[cfg(windows)]
    {
        // 修复：漏加 CREATE_NO_WINDOW，cmd.exe 会一闪而过弹出黑框（对齐 firewall.rs 里
        // netsh/powershell 子进程的同款修复；run_command.rs 的 CREATE_NO_WINDOW 修复未覆盖到这里）。
        let mut command = std::process::Command::new("cmd");
        command.args(["/c", "start", "", &dir_str]);
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Err(e) = command.status() {
            return Err(format!("打开备份目录失败: {e}"));
        }
    }
    // 非 Windows 上根本没有 `cmd`，原来这里必然返回「No such file or directory」，
    // 「打开备份目录」按钮在 mac 上是死的。改走 opener 插件（与 reveal_install_dir 同一条路）。
    // Windows 分支保留原样不动：当年用 `cmd /c start` 正是为了规避 explorer /select 的
    // DDE 转发导致不弹窗，不能顺手「统一」掉。
    #[cfg(not(windows))]
    tauri_plugin_opener::open_path(&dir_str, None::<&str>)
        .map_err(|e| format!("打开备份目录失败: {e}"))?;
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
    // M1 修复：不导出 Bearer token（唯一远程访问凭证）。克隆后脱敏再序列化，
    // 避免导出的配置文件被备份/转发/入库时泄露凭证。导入端 token 为空时会保留现有或重新生成。
    let mut export = config.clone();
    export.token = String::new();
    serde_json::to_string_pretty(&export).map_err(|e| format!("序列化配置失败：{e}"))
}

/// `import_config` 的纯逻辑入口：解析 → 白名单兜底校验 → 落库 → 写 config → 刷新白名单缓存。
///
/// 抽出来是为了让回归测试能直达「写 config 后必须刷新缓存」这一不变量，而不触发
/// Tauri `State` 包装与 `restart_server` 的端口副作用（见文件末尾 `import_config_refreshes_cached_roots`）。
pub(crate) async fn import_config_inner(
    state: &Arc<AppState>,
    json: &str,
) -> Result<ConfigSaveResult, String> {
    let mut incoming: crate::config::BridgeConfig =
        serde_json::from_str(json).map_err(|e| format!("配置解析失败：{e}"))?;
    // M1 配套：导出已脱敏 token（空）。导入时 token 为空则保留现有、现有也空则生成新，
    // 避免把鉴权凭证清空（空 token 会导致鉴权被绕过）。
    if incoming.token.trim().is_empty() {
        let cur = state.config.read().await.token.clone();
        incoming.token = if cur.trim().is_empty() {
            crate::security::auth::generate_token()
        } else {
            cur
        };
    }

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

    /// 回归测试（安全）：`switch_root_profile` 切换配置组后**必须**刷新
    /// `canonicalized_roots`。漏刷的后果不是显示问题而是**安全缺陷**：UI 与
    /// `get_status` 都显示已切到新组，而所有走 `state.cached_roots()` 的工具校验
    /// 仍按旧组的根目录放行 / 拒给。若有人删掉 `switch_root_profile_inner` 里的
    /// `refresh_canonicalized_roots` 一行，下面第 2 条断言会直接失败。
    #[tokio::test]
    async fn switch_root_profile_refreshes_cached_roots() {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir_a: PathBuf =
            std::env::temp_dir().join(format!("cc-bridge-prof-a-{}-{}", std::process::id(), n));
        let dir_b: PathBuf =
            std::env::temp_dir().join(format!("cc-bridge-prof-b-{}-{}", std::process::id(), n));
        for d in [&dir_a, &dir_b] {
            let _ = std::fs::remove_dir_all(d);
            std::fs::create_dir_all(d).expect("create dir");
        }
        let root_a = dir_a.to_string_lossy().into_owned();
        let root_b = dir_b.to_string_lossy().into_owned();

        let conn = db::init_database(Path::new(&dir_a)).expect("init db");
        let cfg = BridgeConfig {
            allowed_roots: vec![root_a.clone()],
            root_profiles: vec![
                crate::config::RootProfile {
                    name: "A组".into(),
                    roots: vec![root_a.clone()],
                },
                crate::config::RootProfile {
                    name: "B组".into(),
                    roots: vec![root_b.clone()],
                },
            ],
            active_profile: "A组".into(),
            ..BridgeConfig::default()
        };
        let state = Arc::new(AppState::new(conn, cfg, dir_a.clone()));

        assert_eq!(
            state.cached_roots(),
            crate::security::path::canonicalize_roots(std::slice::from_ref(&root_a)),
            "切换前缓存应为 A 组"
        );

        super::switch_root_profile_inner(&state, "B组")
            .await
            .expect("切换应成功");

        // 1) 生效集合与当前组名都已换成 B 组
        assert_eq!(
            state.config.read().await.allowed_roots,
            vec![root_b.clone()]
        );
        assert_eq!(state.config.read().await.active_profile, "B组");
        // 2) 关键：白名单缓存必须跟着换
        assert_eq!(
            state.cached_roots(),
            crate::security::path::canonicalize_roots(std::slice::from_ref(&root_b)),
            "切换后缓存必须等于 B 组的 canonicalize——漏刷即安全缺陷"
        );

        // 3) 切到不存在的组必须报错，且不得改动任何状态
        assert!(super::switch_root_profile_inner(&state, "不存在的组")
            .await
            .is_err());
        assert_eq!(state.config.read().await.active_profile, "B组");

        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

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
