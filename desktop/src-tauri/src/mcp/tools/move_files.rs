use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::backup;
use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct TransferItem {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
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

    // D3 修复：同时锁定源与目标路径，避免并发 move 时源被其他读/写工具穿插。
    // 按路径字典序加锁防止两个并发 move 互相死锁；源==目标时只锁一次避免自死锁。
    let from_lock_arc = state
        .path_locks
        .entry(from_resolved.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .value()
        .clone();
    let to_lock_arc = if to_resolved != from_resolved {
        Some(
            state
                .path_locks
                .entry(to_resolved.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .value()
                .clone(),
        )
    } else {
        None
    };
    // 按路径字典序依次加锁：from < to 时先锁源，否则先锁目标，保证全局一致顺序。
    // 源==目标（to_lock_arc 为 None）时只锁源一次，避免自死锁。
    let (_from_guard, _to_guard) = if from_resolved < to_resolved {
        let fg = from_lock_arc.lock().await;
        let tg = match to_lock_arc.as_ref() {
            Some(t) => Some(t.lock().await),
            None => None,
        };
        (Some(fg), tg)
    } else if let Some(t) = to_lock_arc.as_ref() {
        // from >= to 且目标存在：先锁目标再锁源
        let tg = t.lock().await;
        let fg = from_lock_arc.lock().await;
        (Some(fg), Some(tg))
    } else {
        // 目标与源相同：只锁源一次
        let fg = from_lock_arc.lock().await;
        (Some(fg), None)
    };

    if to_resolved.exists() && config.backup_enabled {
        let bp =
            backup::backup_before_overwrite(&to_resolved, &config.backup_dir, &state.data_dir)?;
        backup::prune_backups(
            &to_resolved,
            &config.backup_dir,
            &state.data_dir,
            config.backup_retention,
        )?;
        // 关联审计：记录本次备份路径 + 目标路径（供一键回滚 / Diff 使用）。
        crate::audit::record_op_backup(bp, Some(to_resolved.clone()));
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
