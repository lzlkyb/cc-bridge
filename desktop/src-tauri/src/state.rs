use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use dashmap::DashMap;
use rusqlite::Connection;
use tokio::sync::{Mutex, RwLock};

use crate::config::BridgeConfig;

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
