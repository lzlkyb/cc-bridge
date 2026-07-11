use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use rusqlite::Connection;
use tokio::sync::{Mutex, RwLock};

use crate::config::BridgeConfig;

/// 会话级 cwd 持久化（默认关，见 `BridgeConfig::session_cwd_enabled`）。
///
/// 用显式 `session_id` handle 串起跨 `run_command` 调用的工作目录，消除「每次必传 cwd」
/// 的摩擦。安全约束不削弱：每次使用前仍经 `security::path::resolve_safe_path` 重校验白名单
/// —— 绝不因「已存」而跳过校验（规则 7 红线）。
pub struct CwdSession {
    pub cwd: PathBuf,
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
}

pub struct RuntimeStats {
    pub total_requests: u64,
    pub total_errors: u64,
    pub start_time: Instant,
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
}

impl AppState {
    pub fn new(db: Connection, config: BridgeConfig, data_dir: PathBuf) -> Self {
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
        let cutoff = Instant::now() - Duration::from_secs(30 * 60);
        self.cwd_sessions.retain(|_, s| s.last_active > cutoff);
    }
}
