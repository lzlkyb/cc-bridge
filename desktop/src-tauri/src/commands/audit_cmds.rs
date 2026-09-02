//! 审计日志的 IPC 命令：分页读取、清空、立即清理、按临时天数清理。
//!
//! D19 方案 C 第 4 批。**为何叫 `audit_cmds`**：`crate::audit`（`src/audit.rs`）已存在。
//!
//! 注意这四个命令在原 `commands.rs` 里**并不相邻**——`cleanup_audit_before` 被备份域
//! 隔在了后面（原 1313 行），本次归并到一处。
//!
//! 本文件是**纯搬动**：函数体逐字节未改。

use std::sync::Arc;

use tauri::State;

use crate::audit;
use crate::state::AppState;

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

/// 连接页「最近活动」：尾部读取最近 n 条审计（默认 3）。
///
/// 🔴 **不能用 `get_audit_log` 代替**：那条路径的缓存键含 mtime/len，而审计是追加写，
/// 远程一活跃就次次缓存未命中 → 全量重解析整个 audit.log。连接页是默认停留页，
/// 按 5s 轮询会把它变成持续的 CPU 与内存开销。详见 `audit::read_recent_tail` 头注释。
#[tauri::command(rename_all = "snake_case")]
pub async fn get_recent_activity(
    state: State<'_, Arc<AppState>>,
    n: Option<u32>,
) -> Result<Vec<audit::AuditEntry>, String> {
    audit::read_recent_tail(&state.data_dir, n.unwrap_or(3) as usize)
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
