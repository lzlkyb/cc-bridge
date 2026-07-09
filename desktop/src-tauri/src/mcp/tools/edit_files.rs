use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::backup;
use crate::encoding;
use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct EditEntry {
    pub path: String,
    #[serde(rename = "oldString")]
    pub old_string: String,
    #[serde(rename = "newString")]
    pub new_string: String,
    #[serde(default, rename = "replaceAll")]
    pub replace_all: bool,
}

#[derive(Debug, Deserialize)]
pub struct EditFilesArgs {
    pub files: Vec<EditEntry>,
}

pub async fn handle(args: EditFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let mut results = Vec::new();

    for f in &args.files {
        match edit_single(f, &config, state).await {
            Ok((count, enc, newline)) => results.push(
                json!({ "path": f.path, "ok": true, "replacements": count, "encoding": enc, "newline": newline }),
            ),
            Err(e) => results.push(json!({ "path": f.path, "ok": false, "error": e })),
        }
    }

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&results).unwrap() }] }),
    )
}

async fn edit_single(
    f: &EditEntry,
    config: &crate::config::BridgeConfig,
    state: &Arc<AppState>,
) -> Result<(usize, String, &'static str), String> {
    if f.old_string.is_empty() {
        return Err("oldString must not be empty".into());
    }
    if f.old_string == f.new_string {
        return Err("oldString and newString are identical, nothing to do".into());
    }

    let resolved = security::path::resolve_safe_path(
        &f.path,
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
        return Err("path is a directory".into());
    }
    security::filesize::assert_file_size_ok(&resolved, config.max_file_size_bytes)?;

    // 读取原始字节，探测编码/换行/BOM，文本归一化到 LF 供匹配。
    let raw = tokio::fs::read(&resolved)
        .await
        .map_err(|e| format!("Read error: {e}"))?;
    let ft = encoding::read_text(&raw, None)?;
    let content = &ft.text;

    let match_count = content.matches(&f.old_string).count();
    if match_count == 0 {
        return Err("oldString not found in file".into());
    }

    let (updated, replacements) = if f.replace_all {
        (content.replace(&f.old_string, &f.new_string), match_count)
    } else {
        if match_count > 1 {
            return Err(format!(
                "oldString matched {match_count} times, not unique; add more surrounding context or set replaceAll=true"
            ));
        }
        (content.replacen(&f.old_string, &f.new_string, 1), 1)
    };

    // 按原编码/换行/BOM 无损编码（内含 round-trip 守卫，编码有损会报错）。
    let out_bytes = encoding::encode_text(&updated, ft.encoding, ft.crlf, ft.had_bom)?;

    if config.backup_enabled {
        backup::backup_before_overwrite(&resolved, &config.backup_dir, &state.data_dir)?;
        backup::prune_backups(
            &resolved,
            &config.backup_dir,
            &state.data_dir,
            config.backup_retention,
        )?;
    }

    // 原子写：先写临时文件再 rename，避免写一半崩溃损坏原文件。
    write_atomic(&resolved, &out_bytes).await?;

    Ok((
        replacements,
        ft.encoding.name().to_string(),
        ft.newline_label(),
    ))
}

/// 原子写：同目录临时文件 + rename。rename 在同一卷上是原子操作。
async fn write_atomic(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("ccbridge");
    let tmp = dir.join(format!(".{file_name}.ccbridge.tmp"));

    if let Err(e) = tokio::fs::write(&tmp, data).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("Write temp failed: {e}"));
    }
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("Atomic rename failed: {e}"));
    }
    Ok(())
}
