use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use rusqlite::Connection;
use tokio::sync::{Mutex, RwLock};

use crate::config::BridgeConfig;
use crate::network;

/// 会话级 cwd 持久化（默认关，见 `BridgeConfig::session_cwd_enabled`）。
///
/// 用显式 `session_id` handle 串起跨 `run_command` 调用的工作目录，消除「每次必传 cwd」
/// 的摩擦。安全约束不削弱：每次使用前仍经 `security::path::resolve_safe_path` 重校验白名单
/// —— 绝不因「已存」而跳过校验（规则 7 红线）。
pub struct CwdSession {
    pub cwd: PathBuf,
    /// 会话级持久化的环境变量（key=value），跨 run_command 调用保留——
    /// 解决「source venv / export PATH 每调用丢失」的痛点。注入子进程时仅作用于 env、
    /// 与路径白名单无关，cwd 仍每次重校验（规则 7 不削弱）。
    pub env_overrides: HashMap<String, String>,
    pub last_active: Instant,
}

pub struct RunningCommand {
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    /// 人类可读描述（来自 run_command 的 description 参数），仅作审计/区分记录，不参与执行。
    pub description: Option<String>,
    // 进程树句柄（process-wrap 的 wrapped child，Windows 上内部为 JobObject）。
    // 后台任务的 wait 线程与 stop_command 共享同一份：wait 线程持有它调 wait() 更新
    // exit_code；stop_command 持有它调 start_kill() 触发 TerminateJobObject 杀整树。
    // 与前版手写 win32job Job（KillOnJobClose）不同，process-wrap 的 std JobObject 默认
    // 不 kill-on-close，drop 不会杀进程，必须显式 start_kill()（见 stop_command.rs）。
    pub child: Arc<StdMutex<Box<dyn process_wrap::std::StdChildWrapper>>>,
    pub stdout: Arc<Mutex<Vec<u8>>>,
    pub stderr: Arc<Mutex<Vec<u8>>>,
    pub stdout_truncated: Arc<AtomicBool>,
    pub stderr_truncated: Arc<AtomicBool>,
    pub exit_code: Arc<Mutex<Option<i32>>>,
    pub started_at: Instant,
    /// 进程结束那一刻定格的“已运行秒数”（由 wait 线程与 exit_code 同时写入）。
    /// 修复：之前面板的“已运行”一直用 started_at.elapsed() 实时计算，即使进程早已结束
    /// （v1 不自动回收注册表条目，要等 stop_command 显式移除），还会随面板轮询一直增长下去。
    pub finished_elapsed_secs: Arc<Mutex<Option<u64>>>,
}

pub struct RuntimeStats {
    pub total_requests: u64,
    pub total_errors: u64,
    pub start_time: Instant,
}

/// 防火墙状态缓存（规则级，仅 Windows 真实查询）。
/// 由后台定时任务（每 5 分钟）与按需（open_firewall_port 成功后 / 前端「重新检查」）刷新，
/// get_status 直接读缓存，避免在 5s 轮询里反复跑 netsh。
pub struct FirewallCache {
    /// 防火墙是否开启（任一配置文件启用即 true）。
    pub enabled: Option<bool>,
    /// 7823/TCP 入站是否被放行（存在 allow 规则即 true）。
    pub port_open: Option<bool>,
    /// 上次检查时刻；None 表示尚未检查过。
    pub checked_at: Option<Instant>,
}

impl Default for RuntimeStats {
    fn default() -> Self {
        Self {
            total_requests: 0,
            total_errors: 0,
            start_time: Instant::now(),
        }
    }
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub config: RwLock<BridgeConfig>,
    pub path_locks: DashMap<PathBuf, Arc<Mutex<()>>>,
    pub rate_limiter: DashMap<String, Vec<Instant>>,
    pub stats: RwLock<RuntimeStats>,
    pub data_dir: PathBuf,
    pub mcp_server_handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    // MCP 服务是否在运行（供 UI 显示启停状态）。用户可手动停止/启动。
    pub mcp_running: AtomicBool,
    // 后台命令注册表（run_command background=true 时登记）。v1 没有独立的定时回收任务，
    // 已结束的 handle 会一直占位直到 stop_command 显式移除或达到并发上限被拒绝新建。
    pub running_commands: DashMap<String, RunningCommand>,
    // 会话级 cwd 持久化存储（默认关）。key=opaque session_id，value=已校验的 cwd + 最后活跃时间。
    // 与 path_locks 同源使用 DashMap；空闲回收见 `gc_cwd_sessions`。
    pub cwd_sessions: DashMap<String, CwdSession>,
    /// A3 修复：启动期错误（如端口被占用）。bind 失败时写入，成功时清除。
    /// 供前端 Header 展示「启动失败」红态，避免用户盲目尝试。
    pub startup_error: StdMutex<Option<String>>,

    /// 防火墙状态缓存（规则级，仅 Windows 真实查询）。见 `FirewallCache`。
    pub firewall_cache: StdMutex<FirewallCache>,
    /// 系统 netsh 是否可用（启动探测一次）。false 时停止后台/手动防火墙查询，
    /// 状态恒为 unknown，避免 netsh 损坏时反复 spawn 失败进程并触发「应用程序错误」弹窗。
    pub firewall_available: StdMutex<bool>,

    /// 本机可达 IPv4 地址列表缓存（IP 检测优化）。
    /// 由 new() 启动时初始化一次 + ip_watch 事件（IP 变化时）刷新；get_status 每 5s
    /// 热路径直接读此缓存，避免每次轮询都重扫网卡（UdpSocket bind + GetAdaptersAddresses）。
    /// 与 firewall_cache 同款的短临界区 StdMutex，不跨 await。
    pub lan_ips: StdMutex<Vec<String>>,

    /// 白名单根目录 canonicalize 缓存（白名单校验性能优化）。
    /// 由 new() 启动时初始化一次 + 配置变更（save_config/import_config）时刷新；
    /// 工具层白名单校验直接读此缓存，避免每个工具调用都对所有 root 各做一次 stat 级 canonicalize。
    /// 与 lan_ips 同款的短临界区 StdMutex，不跨 await。
    pub canonicalized_roots: StdMutex<Vec<PathBuf>>,

    /// SSE transport session 注册表。key = session UUID，value = broadcast sender。
    /// GET /mcp/sse 握手时注册，POST /mcp/messages 结果投递时查找，连接断开后自动过期。
    pub sse_registry: crate::mcp::sse::SseRegistry,

    /// Tauri AppHandle，供 MCP 工具调用 Tauri 插件（notification 等）。
    /// new() 时为 None，main.rs 在 setup 中注入。StdMutex 短临界区，不跨 await。
    /// test profile 下不编译：AppHandle 会引入 tao/webview2-com 的 GUI DLL 链，
    /// 导致 test 二进制启动时 0xc0000139（入口点未找到）。
    #[cfg(not(test))]
    pub app_handle: StdMutex<Option<tauri::AppHandle>>,

    // ── 方案 A 运行卡实时指标（全做真·后端实时统计）──
    /// 最近请求到达时间戳，用于 rpm（60s 滑动窗口）。StdMutex 短临界区，不跨 await。
    pub recent_requests: StdMutex<VecDeque<Instant>>,
    /// 耗时累计（ms）与计数，用于平均耗时（无锁原子）。
    pub latency_sum_ms: AtomicU64,
    pub latency_count: AtomicU64,
    /// 最近耗时样本（ms）环形缓冲，固定容量用于 P95 计算。
    pub latency_samples: StdMutex<VecDeque<u64>>,
    /// 限流命中次数（429 因超出单窗口上限）。
    pub rate_limit_hits: AtomicU64,
    /// 鉴权拒绝次数（401 因 token 校验失败 = 拒绝未授权访问）。
    pub auth_denies: AtomicU64,
    /// 审计落盘条数（仅 audit_enabled 且写成功时累计）。
    pub audit_count: AtomicU64,
    /// 各工具累计调用次数（热门工具 Top3 用）。DashMap 并发安全。
    pub tool_counts: DashMap<String, u64>,
}

impl AppState {
    pub fn new(db: Connection, config: BridgeConfig, data_dir: PathBuf) -> Self {
        // 白名单根目录缓存初始化：在 config 被移入 RwLock 前取一次 canonicalize。
        let canonicalized_roots = crate::security::path::canonicalize_roots(&config.allowed_roots);
        Self {
            db: Mutex::new(db),
            config: RwLock::new(config),
            path_locks: DashMap::new(),
            rate_limiter: DashMap::new(),
            stats: RwLock::new(RuntimeStats::default()),
            data_dir,
            mcp_server_handle: Mutex::new(None),
            mcp_running: AtomicBool::new(false),
            running_commands: DashMap::new(),
            cwd_sessions: DashMap::new(),
            startup_error: StdMutex::new(None),
            firewall_cache: StdMutex::new(FirewallCache {
                enabled: None,
                port_open: None,
                checked_at: None,
            }),
            firewall_available: StdMutex::new(true),
            lan_ips: StdMutex::new(network::get_lan_ips()),
            canonicalized_roots: StdMutex::new(canonicalized_roots),
            sse_registry: crate::mcp::sse::new_registry(),
            recent_requests: StdMutex::new(VecDeque::new()),
            latency_sum_ms: AtomicU64::new(0),
            latency_count: AtomicU64::new(0),
            latency_samples: StdMutex::new(VecDeque::new()),
            rate_limit_hits: AtomicU64::new(0),
            auth_denies: AtomicU64::new(0),
            audit_count: AtomicU64::new(0),
            tool_counts: DashMap::new(),
            #[cfg(not(test))]
            app_handle: StdMutex::new(None),
        }
    }

    pub async fn increment_requests(&self) {
        let mut stats = self.stats.write().await;
        stats.total_requests += 1;
    }

    pub async fn increment_errors(&self) {
        let mut stats = self.stats.write().await;
        stats.total_errors += 1;
    }

    pub async fn uptime_seconds(&self) -> u64 {
        let stats = self.stats.read().await;
        stats.start_time.elapsed().as_secs()
    }

    /// D2 修复：回收空闲路径锁。
    ///
    /// `path_locks` 为「路径 → Arc<Mutex>」表，每个被操作的路径都会留下一个永久 entry，
    /// 长期运行会无界增长。此处仅移除「强引用计数 == 1」的 entry——即只有 DashMap 自身
    /// 持有、当前没有任何工具正在持有该锁的条目；正在使用（strong_count >= 2）的锁会被保留，
    /// 因此不会误删并发操作所需的锁。由 main 中每 60s 触发的后台任务调用。
    pub fn gc_path_locks(&self) {
        self.path_locks
            .retain(|_, lock| Arc::strong_count(lock) > 1);
    }

    /// 回收空闲超过 30 分钟的 cwd 会话。
    ///
    /// 与 `gc_path_locks` 同节奏（每 60s，由 main 后台任务调用）。超时即丢弃，不续期——
    /// 客户端若仍持有旧 session_id，下次调用会收到「session 不存在」错误，按工具描述重新创建即可。
    pub fn gc_cwd_sessions(&self) {
        let Some(cutoff) = Instant::now().checked_sub(Duration::from_secs(30 * 60)) else {
            return; // 进程启动不足 30 分钟，不可能有超时 session
        };
        self.cwd_sessions.retain(|_, s| s.last_active > cutoff);
    }

    /// G5 修复：从 commands.rs 收拢到这里。之前它们定义在 Tauri 命令层（commands.rs），却被
    /// 协议层的 mcp/tools/run_command.rs 反向 `use crate::commands` 调用，依赖方向反了；且与
    /// gc_path_locks/gc_cwd_sessions 是几乎同构的“快照→判断→remove”模式，收拢到同一处。
    ///
    /// 并发上限时的即时腾位：不管 5 分钟宽容期，把所有已结束（exit_code 为 Some）的
    /// 命令立即移除，为新命令腾出空位。修复：之前一旦命中并发上限，即使前面的早已跑完，
    /// 新命令也会被硬拒绝，用户必须手动 stop_command 才能重试。由 `run_command.rs` 在打包 5
    /// 上限报错前先调用。
    pub async fn evict_finished_commands(&self) {
        let snapshot: Vec<_> = self
            .running_commands
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().exit_code.clone()))
            .collect();

        for (handle, exit_code_arc) in snapshot {
            if exit_code_arc.lock().await.is_some() {
                self.running_commands.remove(&handle);
            }
        }
    }

    /// 后台定时清理：从配置读宽容期（默认 2 分钟），命令结束后超过该时间自动从注册表移除。
    /// 0 表示立即清理（不保留宽容期）。
    /// 仅清理已结束（exit_code 为 Some）且超过宽容期的条目，运行中的不动。
    /// 由 main.rs 里的周期任务调用（每 60s 一次）。
    pub async fn cleanup_finished_commands(&self) {
        let cleanup_secs = self.config.read().await.command_cleanup_secs;
        if cleanup_secs == 0 {
            // 宽容期为 0：仅保留仍在运行的，已结束的全清
            self.evict_finished_commands().await;
            return;
        }
        let grace_period = Duration::from_secs(cleanup_secs);

        let snapshot: Vec<_> = self
            .running_commands
            .iter()
            .map(|entry| {
                let cmd = entry.value();
                (
                    entry.key().clone(),
                    cmd.exit_code.clone(),
                    cmd.finished_elapsed_secs.clone(),
                    cmd.started_at,
                )
            })
            .collect();

        let mut to_remove = Vec::new();
        for (handle, exit_code_arc, finished_elapsed_arc, started_at) in snapshot {
            if exit_code_arc.lock().await.is_none() {
                continue; // 还在跑，不清
            }
            let Some(finished_secs) = *finished_elapsed_arc.lock().await else {
                continue; // exit_code 已写但 finished_elapsed 还没来得及写入（极短窗口），下一轮再看
            };
            let finished_at = started_at + Duration::from_secs(finished_secs);
            if finished_at.elapsed() >= grace_period {
                to_remove.push(handle);
            }
        }

        for handle in to_remove {
            self.running_commands.remove(&handle);
        }
    }

    // ── 方案 A 运行卡实时指标采集（全做真，禁止伪造）──

    /// 记录一次请求到达时间（rpm 统计）。环形上限 10_000 防无界增长。
    pub fn record_request_time(&self) {
        const CAP: usize = 10_000;
        let mut q = self.recent_requests.lock().unwrap();
        q.push_back(Instant::now());
        while q.len() > CAP {
            q.pop_front();
        }
    }

    /// 记录一次工具调用耗时（ms）：更新累计和/计数（avg）+ 环形样本（P95）。样本上限 500。
    pub fn record_latency(&self, ms: u64) {
        const CAP: usize = 500;
        self.latency_sum_ms.fetch_add(ms, Ordering::Relaxed);
        self.latency_count.fetch_add(1, Ordering::Relaxed);
        let mut q = self.latency_samples.lock().unwrap();
        q.push_back(ms);
        while q.len() > CAP {
            q.pop_front();
        }
    }

    /// 记录一次工具调用（按工具名累计，热门工具 Top3 用）。
    pub fn record_tool(&self, name: &str) {
        *self.tool_counts.entry(name.to_string()).or_insert(0) += 1;
    }

    /// 限流命中（429）计数 +1。
    pub fn inc_rate_limit_hits(&self) {
        self.rate_limit_hits.fetch_add(1, Ordering::Relaxed);
    }

    /// 鉴权拒绝（401）计数 +1。
    pub fn inc_auth_denies(&self) {
        self.auth_denies.fetch_add(1, Ordering::Relaxed);
    }

    /// 审计落盘条数 +1。
    pub fn inc_audit_count(&self) {
        self.audit_count.fetch_add(1, Ordering::Relaxed);
    }

    // ── 本机 IP 地址缓存（IP 检测优化）──

    /// 重扫网卡并把最新列表写回缓存，返回最新列表。
    /// 仅由 ip_watch 事件（OS 通知 IP 变化时）调用，刷新与「changed 判断」合一。
    pub fn refresh_lan_ips(&self) -> Vec<String> {
        let ips = network::get_lan_ips();
        *self.lan_ips.lock().unwrap() = ips.clone();
        ips
    }

    /// 读缓存（get_status 每 5s 热路径用，零系统调用）。
    pub fn cached_lan_ips(&self) -> Vec<String> {
        self.lan_ips.lock().unwrap().clone()
    }

    // ── 白名单根目录缓存（白名单校验性能优化）──

    /// 用最新的 allowed_roots 重算缓存（canonicalize 一次）。仅由配置变更路径调用，
    /// 不碰 config 锁，避免与调用方已有的 config 读写锁产生顺序依赖。
    pub fn refresh_canonicalized_roots(&self, allowed_roots: &[String]) {
        *self.canonicalized_roots.lock().unwrap() =
            crate::security::path::canonicalize_roots(allowed_roots);
    }

    /// 读缓存（工具层白名单校验用，零重复 canonicalize）。
    pub fn cached_roots(&self) -> Vec<PathBuf> {
        self.canonicalized_roots.lock().unwrap().clone()
    }
}
