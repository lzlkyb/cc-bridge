use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct ListDirectoryArgs {
    pub path: String,
    #[serde(default)]
    pub recursive: bool,
    #[serde(default = "default_max_depth")]
    #[serde(rename = "maxDepth")]
    pub max_depth: u32,
}

fn default_max_depth() -> u32 {
    10
}

#[derive(Debug, Serialize)]
struct DirEntry {
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<DirEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub async fn handle(args: ListDirectoryArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let resolved = security::path::resolve_safe_path_cached(
        &args.path,
        &state.cached_roots(),
        config.whitelist_enabled,
    )?;

    let metadata = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Cannot stat path: {e}"))?;
    if !metadata.is_dir() {
        return Err("path is not a directory".into());
    }

    let entries = walk_dir(&resolved, args.recursive, args.max_depth, 0).await?;
    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&entries).unwrap() }] }),
    )
}

fn walk_dir(
    dir: &Path,
    recursive: bool,
    max_depth: u32,
    current_depth: u32,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<DirEntry>, String>> + Send + '_>>
{
    Box::pin(walk_dir_inner(dir, recursive, max_depth, current_depth))
}

async fn walk_dir_inner(
    dir: &Path,
    recursive: bool,
    max_depth: u32,
    current_depth: u32,
) -> Result<Vec<DirEntry>, String> {
    let t0 = std::time::Instant::now();
    let mut read_dir = tokio::fs::read_dir(dir)
        .await
        .map_err(|e| format!("Cannot read directory: {e}"))?;
    crate::timing::record_io(t0.elapsed());

    let mut result = Vec::new();
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("Read error: {e}"))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path();

        let t1 = std::time::Instant::now();
        let metadata = match entry.metadata().await {
            // E-P1-6: 用 entry.metadata() 避免额外 stat syscall（read_dir 已含元数据）
            Ok(m) => {
                crate::timing::record_io(t1.elapsed());
                m
            }
            Err(e) => {
                crate::timing::record_io(t1.elapsed());
                result.push(DirEntry {
                    name,
                    entry_type: "unknown".into(),
                    size: None,
                    mtime: None,
                    children: None,
                    truncated: None,
                    error: Some(e.to_string()),
                });
                continue;
            }
        };

        let entry_type = if metadata.is_dir() {
            "directory"
        } else if metadata.is_file() {
            "file"
        } else {
            "other"
        };

        let mtime = metadata
            .modified()
            .ok()
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());

        let mut dir_entry = DirEntry {
            name,
            entry_type: entry_type.into(),
            size: Some(metadata.len()),
            mtime,
            children: None,
            truncated: None,
            error: None,
        };

        if metadata.is_dir() && recursive {
            if current_depth >= max_depth {
                dir_entry.truncated = Some(true);
            } else {
                match walk_dir(&full_path, recursive, max_depth, current_depth + 1).await {
                    Ok(children) => dir_entry.children = Some(children),
                    Err(e) => dir_entry.error = Some(e),
                }
            }
        }

        result.push(dir_entry);
    }

    Ok(result)
}
