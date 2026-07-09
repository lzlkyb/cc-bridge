use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct GetCommandOutputArgs {
    pub handle: String,
    #[serde(default, rename = "stdoutOffset")]
    pub stdout_offset: usize,
    #[serde(default, rename = "stderrOffset")]
    pub stderr_offset: usize,
}

/// 增量拉取后台命令（run_command background=true）的输出。
/// 已知限制：v1 没有定时回收任务，命令结束后 handle 仍会占位直到被
/// stop_command 显式移除，或后台并发数达上限时拒绝新建。
pub async fn handle(args: GetCommandOutputArgs, state: &Arc<AppState>) -> Result<Value, String> {
    // 先克隆出需要的 Arc，再释放 DashMap 的 Ref，避免在持有 Ref 期间跨 await。
    let (stdout_arc, stderr_arc, stdout_trunc, stderr_trunc, exit_code_arc, pid) = {
        let entry = state
            .running_commands
            .get(&args.handle)
            .ok_or_else(|| format!("未知的 handle: {}（可能从未存在，或已被清理）", args.handle))?;
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

    let stdout_slice = &stdout[args.stdout_offset.min(stdout.len())..];
    let stderr_slice = &stderr[args.stderr_offset.min(stderr.len())..];

    Ok(json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&json!({
            "stdout": String::from_utf8_lossy(stdout_slice),
            "stderr": String::from_utf8_lossy(stderr_slice),
            "stdoutTotalBytes": stdout.len(),
            "stderrTotalBytes": stderr.len(),
            "stdoutTruncated": stdout_trunc.load(Ordering::Relaxed),
            "stderrTruncated": stderr_trunc.load(Ordering::Relaxed),
            "running": exit_code.is_none(),
            "exitCode": exit_code,
            "pid": pid,
        })).unwrap() }]
    }))
}
