use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::backup;
use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct TransferItem {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
pub struct MoveFilesArgs {
    pub items: Vec<TransferItem>,
}

pub async fn handle(args: MoveFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let mut results = Vec::new();

    for item in &args.items {
        match move_single(item, &config, state).await {
            Ok(()) => results.push(json!({ "from": item.from, "to": item.to, "ok": true })),
            Err(e) => {
                results.push(json!({ "from": item.from, "to": item.to, "ok": false, "error": e }))
            }
        }
    }

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&results).unwrap() }] }),
    )
}

async fn move_single(
    item: &TransferItem,
    config: &crate::config::BridgeConfig,
    state: &Arc<AppState>,
) -> Result<(), String> {
    let from_resolved = security::path::resolve_safe_path(
        &item.from,
        &config.allowed_roots,
        config.whitelist_enabled,
    )?;
    let to_resolved = security::path::resolve_safe_path(
        &item.to,
        &config.allowed_roots,
        config.whitelist_enabled,
    )?;
    security::extension::assert_extension_allowed(&from_resolved, &config.allowed_extensions)?;
    security::extension::assert_extension_allowed(&to_resolved, &config.allowed_extensions)?;

    let from_meta = tokio::fs::metadata(&from_resolved)
        .await
        .map_err(|e| format!("Source not found: {e}"))?;
    if from_meta.is_dir() {
        return Err("source is a directory, not supported".into());
    }

    let lock = state
        .path_locks
        .entry(to_resolved.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .value()
        .clone();
    let _guard = lock.lock().await;

    if to_resolved.exists() && config.backup_enabled {
        backup::backup_before_overwrite(&to_resolved, &config.backup_dir, &state.data_dir)?;
        backup::prune_backups(
            &to_resolved,
            &config.backup_dir,
            &state.data_dir,
            config.backup_retention,
        )?;
    }

    if let Some(parent) = to_resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create parent dirs: {e}"))?;
    }

    // Try rename first, fall back to copy+delete on cross-device
    match tokio::fs::rename(&from_resolved, &to_resolved).await {
        Ok(()) => Ok(()),
        Err(_e) => {
            // EXDEV or other cross-device error — fallback to copy+delete
            tokio::fs::copy(&from_resolved, &to_resolved)
                .await
                .map_err(|e| format!("Copy fallback failed: {e}"))?;
            tokio::fs::remove_file(&from_resolved)
                .await
                .map_err(|e| format!("Remove source after copy failed: {e}"))?;
            Ok(())
        }
    }
}
