use std::path::Path;
use std::sync::Arc;

use encoding_rs::UTF_8;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::encoding;
use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
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

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
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

    Ok(json!({ "content": [{ "type": "text", "text": serde_json::to_string(&results).unwrap() }] }))
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

    // E-P0-8: 行范围读取走流式（仅读需要的行），大文件不把整文件载入内存。
    // 触发条件：指定了 start/end 且编码可确定（显式 override，或 detect 关闭→强制 UTF-8）。
    // 自动探测（detect_enabled 且未指定编码）需全文件扫描，回退下面的全读路径。
    let streamable = start_line.is_some() || end_line.is_some();
    let enc_determinable = encoding_override.is_some() || !detect_enabled;
    if streamable && enc_determinable {
        return read_range_streaming(
            file_path,
            &resolved,
            start_line,
            end_line,
            encoding_override,
        )
        .await;
    }

    // 全读路径（编码自动探测 / 无行范围）
    let t0 = std::time::Instant::now();
    let raw = tokio::fs::read(&resolved)
        .await
        .map_err(|e| format!("Read error: {e}"))?;
    crate::timing::record_io(t0.elapsed());
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
        // E-P0-8: 惰性 skip/take，避免把所有行 collect 进 Vec（大文件省内存）。
        let selected: Vec<&str> = content
            .lines()
            .skip(from.saturating_sub(1))
            .take(to.saturating_sub(from).saturating_add(1))
            .collect();
        let actual_end = if selected.is_empty() {
            from.saturating_sub(1)
        } else {
            to.min(from + selected.len() - 1)
        };

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

/// E-P0-8: 流式行范围读取。逐行从磁盘读取、按需解码，绝不同时把整文件载入内存。
/// 调用方已确保编码可确定（override 显式指定，或 detect 关闭→UTF-8），
/// 因此可逐行用该编码解码，无需全文件扫描。
async fn read_range_streaming(
    file_path: &str,
    resolved: &Path,
    start_line: Option<u32>,
    end_line: Option<u32>,
    encoding_override: Option<&str>,
) -> Result<Value, String> {
    let file = tokio::fs::File::open(resolved)
        .await
        .map_err(|e| format!("Cannot open: {e}"))?;
    let reader = BufReader::new(file);
    let mut split = reader.split(b'\n');

    let encoding = match encoding_override {
        Some(label) => crate::encoding::label_to_encoding(label)
            .ok_or_else(|| format!("Unknown encoding label: {label}"))?,
        None => UTF_8,
    };

    let from = start_line.unwrap_or(1) as usize;
    let to = end_line.map(|e| e as usize).unwrap_or(usize::MAX);
    let t0 = std::time::Instant::now();

    let mut selected: Vec<String> = Vec::new();
    let mut i: usize = 0;
    let mut last_segment_empty = false;
    let mut reached_eof = false;
    let mut had_crlf = false;

    loop {
        let seg = match split.next_segment().await {
            Ok(Some(b)) => b,
            Ok(None) => {
                reached_eof = true;
                break;
            }
            Err(e) => return Err(format!("Read error: {e}")),
        };
        let one_based = i + 1;
        last_segment_empty = seg.is_empty();
        if one_based >= from && one_based <= to {
            let mut bytes = seg;
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
                had_crlf = true;
            }
            let (cow, _) = encoding.decode_without_bom_handling(&bytes);
            selected.push(cow.into_owned());
        }
        if one_based >= to {
            break;
        }
        i += 1;
    }
    crate::timing::record_io(t0.elapsed());

    // 复刻 str::lines()：仅当文件以 \n 结尾（真正 EOF）时丢弃最后一个空行。
    if reached_eof && last_segment_empty {
        if let Some(last) = selected.last() {
            if last.is_empty() {
                selected.pop();
            }
        }
    }

    let enc_name = encoding.name();
    let newline = if had_crlf { "CRLF" } else { "LF" };
    let actual_end = if selected.is_empty() {
        from.saturating_sub(1)
    } else {
        to.min(from + selected.len() - 1)
    };

    Ok(json!({
        "path": file_path,
        "content": selected.join("\n"),
        "startLine": from,
        "endLine": actual_end,
        "encoding": enc_name,
        "newline": newline,
    }))
}
