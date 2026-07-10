use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::encoding;
use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum FileRef {
    Simple(String),
    Detailed {
        path: String,
        #[serde(rename = "startLine")]
        start_line: Option<u32>,
        #[serde(rename = "endLine")]
        end_line: Option<u32>,
    },
}

#[derive(Debug, Deserialize)]
pub struct ReadFilesArgs {
    pub files: Vec<FileRef>,
    #[serde(rename = "startLine")]
    pub start_line: Option<u32>,
    #[serde(rename = "endLine")]
    pub end_line: Option<u32>,
    /// 可选：强制按此编码解码（如 "gbk"）。省略时自动探测（UTF-8/GBK/…）。
    pub encoding: Option<String>,
}

pub async fn handle(args: ReadFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let mut results = Vec::new();

    for item in &args.files {
        let (file_path, start_line, end_line) = match item {
            FileRef::Simple(p) => (p.as_str(), args.start_line, args.end_line),
            FileRef::Detailed {
                path,
                start_line,
                end_line,
            } => (
                path.as_str(),
                start_line.or(args.start_line),
                end_line.or(args.end_line),
            ),
        };

        match read_single_file(
            file_path,
            start_line,
            end_line,
            args.encoding.as_deref(),
            config.encoding_detect_enabled,
            &config,
        )
        .await
        {
            Ok(val) => results.push(val),
            Err(e) => results.push(json!({ "path": file_path, "error": e })),
        }
    }

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&results).unwrap() }] }),
    )
}

async fn read_single_file(
    file_path: &str,
    start_line: Option<u32>,
    end_line: Option<u32>,
    encoding_override: Option<&str>,
    detect_enabled: bool,
    config: &crate::config::BridgeConfig,
) -> Result<Value, String> {
    let resolved = security::path::resolve_safe_path(
        file_path,
        &config.allowed_roots,
        config.whitelist_enabled,
    )?;
    security::extension::assert_extension_allowed(&resolved, &config.allowed_extensions)?;

    let metadata = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Cannot stat: {e}"))?;
    if metadata.is_dir() {
        return Err("path is a directory".into());
    }
    security::filesize::assert_file_size_ok(&resolved, config.max_file_size_bytes)?;

    // 读原始字节，探测编码/换行，文本统一归一化到 LF（整读/行读一致）。
    let raw = tokio::fs::read(&resolved)
        .await
        .map_err(|e| format!("Read error: {e}"))?;
    // 编码自适应默认关：关时强制按 UTF-8 读，避免启发式误判；显式 encoding 参数始终优先。
    let effective_encoding =
        encoding_override.or(if detect_enabled { None } else { Some("utf-8") });
    let ft = encoding::read_text(&raw, effective_encoding)?;
    let enc_name = ft.encoding.name();
    let newline = ft.newline_label();
    let content = ft.text;

    if start_line.is_some() || end_line.is_some() {
        let from = start_line.unwrap_or(1) as usize;
        let to = end_line.map(|e| e as usize).unwrap_or(usize::MAX);

        let lines: Vec<&str> = content.lines().collect();
        let actual_end = to.min(lines.len());
        let selected: Vec<&str> = lines
            .iter()
            .enumerate()
            .filter(|(i, _)| (*i).saturating_add(1) >= from && (*i).saturating_add(1) <= actual_end)
            .map(|(_, l)| *l)
            .collect();

        Ok(json!({
            "path": file_path,
            "content": selected.join("\n"),
            "startLine": from,
            "endLine": actual_end,
            "encoding": enc_name,
            "newline": newline,
        }))
    } else {
        Ok(
            json!({ "path": file_path, "content": content, "encoding": enc_name, "newline": newline }),
        )
    }
}
