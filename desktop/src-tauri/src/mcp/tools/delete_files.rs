use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::backup;
use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct DeleteFilesArgs {
    pub paths: Vec<String>,
}

pub async fn handle(args: DeleteFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let mut results = Vec::new();

    for p in &args.paths {
        match delete_single(p, &config, state).await {
            Ok(()) => results.push(json!({ "path": p, "ok": true })),
            Err(e) => results.push(json!({ "path": p, "ok": false, "error": e })),
        }
    }

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&results).unwrap() }] }),
    )
}

async fn delete_single(
    file_path: &str,
    config: &crate::config::BridgeConfig,
    state: &Arc<AppState>,
) -> Result<(), String> {
    let resolved = security::path::resolve_safe_path(
        file_path,
        &config.allowed_roots,
        config.whitelist_enabled,
    )?;
    security::extension::assert_extension_allowed(&resolved, &config.allowed_extensions)?;

    let lock = state
        .path_locks
        .entry(resolved.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .value()
        .clone();
    let _guard = lock.lock().await;

    let metadata = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| format!("File does not exist: {e}"))?;

    if metadata.is_dir() {
        return Err("path is a directory, refusing to delete".into());
    }

    if config.backup_enabled {
        backup::backup_before_overwrite(&resolved, &config.backup_dir, &state.data_dir)?;
        backup::prune_backups(
            &resolved,
            &config.backup_dir,
            &state.data_dir,
            config.backup_retention,
        )?;
    }

    tokio::fs::remove_file(&resolved)
        .await
        .map_err(|e| format!("Delete failed: {e}"))?;

    Ok(())
}
