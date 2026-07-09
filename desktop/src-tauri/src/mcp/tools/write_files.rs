use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::backup;
use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct WriteFileEntry {
    pub path: String,
    pub content: String,
    #[serde(default = "default_encoding")]
    pub encoding: String,
}

fn default_encoding() -> String {
    "utf8".into()
}

#[derive(Debug, Deserialize)]
pub struct WriteFilesArgs {
    pub files: Vec<WriteFileEntry>,
}

pub async fn handle(args: WriteFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let mut results = Vec::new();

    for f in &args.files {
        match write_single(&f, &config, state).await {
            Ok(()) => results.push(json!({ "path": f.path, "ok": true })),
            Err(e) => results.push(json!({ "path": f.path, "ok": false, "error": e })),
        }
    }

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&results).unwrap() }] }),
    )
}

async fn write_single(
    f: &WriteFileEntry,
    config: &crate::config::BridgeConfig,
    state: &Arc<AppState>,
) -> Result<(), String> {
    let resolved = security::path::resolve_safe_path(
        &f.path,
        &config.allowed_roots,
        config.whitelist_enabled,
    )?;
    security::extension::assert_extension_allowed(&resolved, &config.allowed_extensions)?;

    let data = if f.encoding == "base64" {
        let decoded = base64_decode(&f.content)?;
        decoded
    } else {
        f.content.as_bytes().to_vec()
    };

    if data.len() as u64 > config.max_file_size_bytes {
        return Err(format!(
            "Content size {} exceeds limit {}",
            data.len(),
            config.max_file_size_bytes
        ));
    }

    let lock = state
        .path_locks
        .entry(resolved.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .value()
        .clone();
    let _guard = lock.lock().await;

    if resolved.exists() && config.backup_enabled {
        backup::backup_before_overwrite(&resolved, &config.backup_dir, &state.data_dir)?;
        backup::prune_backups(
            &resolved,
            &config.backup_dir,
            &state.data_dir,
            config.backup_retention,
        )?;
    }

    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create parent dirs: {e}"))?;
    }

    tokio::fs::write(&resolved, &data)
        .await
        .map_err(|e| format!("Write failed: {e}"))?;

    Ok(())
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    // Simple base64 decoder
    let table: Vec<u8> =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".to_vec();
    let input = input.trim().replace('\n', "").replace('\r', "");
    let mut output = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u32;

    for c in input.bytes() {
        if c == b'=' {
            break;
        }
        let val = table
            .iter()
            .position(|&b| b == c)
            .ok_or_else(|| format!("Invalid base64 character: {}", c as char))?
            as u32;
        buffer = (buffer << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Ok(output)
}
