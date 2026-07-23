use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::backup;
use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct CopyItem {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct CopyFilesArgs {
    pub items: Vec<CopyItem>,
}

pub async fn handle(args: CopyFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let mut results = Vec::new();

    for item in &args.items {
        match copy_single(item, &config, state).await {
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

async fn copy_single(
    item: &CopyItem,
    config: &crate::config::BridgeConfig,
    state: &Arc<AppState>,
) -> Result<(), String> {
    let from_resolved = security::path::resolve_safe_path_cached(
        &item.from,
        &state.cached_roots(),
        config.whitelist_enabled,
    )?;
    let to_resolved = security::path::resolve_safe_path_cached(
        &item.to,
        &state.cached_roots(),
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
        let db = state.db.lock().await;
        let bp = backup::backup_before_overwrite(
            &to_resolved,
            &config.backup_dir,
            &state.data_dir,
            &db,
        )?;
        backup::prune_backups(
            &to_resolved,
            &config.backup_dir,
            &state.data_dir,
            config.backup_retention,
            &db,
        )?;
        drop(db);
        // 关联审计：记录本次备份路径 + 目标路径（供一键回滚 / Diff 使用）。
        crate::audit::record_op_backup(bp, Some(to_resolved.clone()));
    }

    if let Some(parent) = to_resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create parent dirs: {e}"))?;
    }

    tokio::fs::copy(&from_resolved, &to_resolved)
        .await
        .map_err(|e| format!("Copy failed: {e}"))?;

    Ok(())
}
