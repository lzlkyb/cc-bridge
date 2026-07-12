use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct CreateDirectoryArgs {
    pub path: String,
}

pub async fn handle(args: CreateDirectoryArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;

    // 目录无扩展名，不做扩展名白名单校验（否则会被误拒），仅走路径白名单。
    let resolved = security::path::resolve_safe_path(
        &args.path,
        &config.allowed_roots,
        config.whitelist_enabled,
    )?;

    // create_dir_all 幂等：目录已存在也返回 Ok。
    tokio::fs::create_dir_all(&resolved)
        .await
        .map_err(|e| format!("Create directory failed: {e}"))?;

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&json!({ "path": args.path, "ok": true })).unwrap() }] }),
    )
}
