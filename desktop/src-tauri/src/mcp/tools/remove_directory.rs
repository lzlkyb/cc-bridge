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

    let resolved = security::path::resolve_safe_path_cached(
        &args.path,
        &state.cached_roots(),
        config.whitelist_enabled,
    )?;

    // M13：递归删除要用到扩展名白名单与备份配置，先取出再按需 drop。
    let allowed_extensions = config.allowed_extensions.clone();
    let backup_enabled = config.backup_enabled;
    let backup_dir = config.backup_dir.clone();
    let backup_retention = config.backup_retention;
    drop(config);

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
        // M13 修复：递归删除前遍历目录树——(1) 施加与 delete_files 一致的扩展名白名单校验，
        // 防止用 recursive 绕过白名单删除受限文件；(2) backup_enabled 时逐文件备份，保可回滚。
        let root = resolved.clone();
        let files: Vec<std::path::PathBuf> = tokio::task::spawn_blocking(move || {
            ignore::WalkBuilder::new(&root)
                .standard_filters(false)
                .hidden(false)
                .build()
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .map(|e| e.path().to_path_buf())
                .collect()
        })
        .await
        .map_err(|e| format!("遍历目录失败: {e}"))?;

        for f in &files {
            security::extension::assert_extension_allowed(f, &allowed_extensions)?;
        }
        if backup_enabled {
            let db = state.db.lock().await;
            for f in &files {
                crate::backup::backup_before_overwrite(f, &backup_dir, &state.data_dir, &db)?;
                crate::backup::prune_backups(f, &backup_dir, &state.data_dir, backup_retention)?;
            }
            drop(db);
        }

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
