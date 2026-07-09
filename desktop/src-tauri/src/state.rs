use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use dashmap::DashMap;
use rusqlite::Connection;
use tokio::sync::{Mutex, RwLock};

use crate::config::BridgeConfig;

pub struct RunningCommand {
    pub pid: u32,
    pub command: String,
    pub cwd: String,
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
}
