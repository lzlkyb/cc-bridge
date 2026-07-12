use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct RemoveDirectoryArgs {
    pub path: String,
    /// 递归删除整个目录树（危险）。默认 false：仅删空目录，非空则失败。
    #[serde(default)]
    pub recursive: bool,
}

pub async fn handle(args: RemoveDirectoryArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;

    let resolved = security::path::resolve_safe_path(
        &args.path,
        &config.allowed_roots,
        config.whitelist_enabled,
    )?;

    // 目录级操作也按路径加锁，避免与并发写/删竞争。
    let lock = state
        .path_locks
        .entry(resolved.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .value()
        .clone();
    let _guard = lock.lock().await;

    let metadata = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Directory does not exist: {e}"))?;
    if !metadata.is_dir() {
        return Err("path is not a directory".into());
    }

    if args.recursive {
        tokio::fs::remove_dir_all(&resolved)
            .await
            .map_err(|e| format!("Recursive remove failed: {e}"))?;
    } else {
        // remove_dir 仅删空目录；非空会返回错误，符合默认安全预期。
        tokio::fs::remove_dir(&resolved)
            .await
            .map_err(|e| format!("Remove failed (directory not empty? use recursive=true): {e}"))?;
    }

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&json!({ "path": args.path, "ok": true, "recursive": args.recursive })).unwrap() }] }),
    )
}
