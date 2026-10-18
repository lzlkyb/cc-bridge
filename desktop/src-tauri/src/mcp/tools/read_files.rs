use std::path::{Path, PathBuf};
use std::sync::Arc;

use encoding_rs::UTF_8;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader};

use crate::encoding;
use crate::mcp::tools::text_result_compact;
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
    /// 容错：部分客户端把数组 stringify 成字符串再发（审计实锤，含 `paths` 别名误用），
    /// 见 `flex_args::vec_from_json_or_string`。
    #[serde(
        deserialize_with = "crate::mcp::tools::flex_args::vec_from_json_or_string",
        alias = "paths"
    )]
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
    let cached_roots = state.cached_roots();
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
            &cached_roots,
            &config,
        )
        .await
        {
            Ok(val) => results.push(val),
            Err(e) => results.push(json!({ "path": file_path, "error": e })),
        }
    }

    Ok(text_result_compact(&results))
}

async fn read_single_file(
    file_path: &str,
    start_line: Option<u32>,
    end_line: Option<u32>,
    encoding_override: Option<&str>,
    detect_enabled: bool,
    cached_roots: &[PathBuf],
    config: &crate::config::BridgeConfig,
) -> Result<Value, String> {
    let resolved = security::path::resolve_safe_path_cached(
        file_path,
        cached_roots,
        &config.exclude_patterns,
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
    //
    // 🔴 还有一个排除项（审查 P2）：**UTF-16 不能走流式**。流式是按**字节** `\n` 切段的，
    // 而 UTF-16 的换行是 `0A 00` —— 切点落在码元中间，逐段 decode 出来是错位乱码
    // （奇偶字节互换，且不报错）。这类编码回退全读路径：先整体解码，再按字符行切。
    let ascii_compatible = match encoding_override {
        Some(label) => crate::encoding::label_to_encoding(label)
            .map(|e| e.is_ascii_compatible())
            .unwrap_or(true), // 未知标签：交给下游统一报错
        None => true, // 未指定 → utf-8（ASCII 兼容）
    };
    let streamable = (start_line.is_some() || end_line.is_some()) && ascii_compatible;
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
    // 二进制守卫：read_text 只在编码有损时拦截，而 GBK/GB18030 几乎能解码任何双字节序列，
    // 导致 PNG/EXE/".pyc" 等二进制被当文本成功解码、裸返乱码污染远程上下文。这里先按内容
    // 检测 NUL / 非打印字符占比，命中即返回友好提示而非乱码。
    if encoding::is_binary_content(&raw) {
        return Err(
            "文件疑似二进制内容（含 NUL 或非文本控制字符占比过高），read_files 不会原样返回以避免污染远程上下文。如需查看请通过其他方式获取，或确认文件真实编码后再处理。".into(),
        );
    }
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
    let mut file = tokio::fs::File::open(resolved)
        .await
        .map_err(|e| format!("Cannot open: {e}"))?;
    // 二进制守卫：流式读也要避免把二进制当文本逐行裸返。先 peek 前 8KB 检测，命中则返回
    // 友好提示（与全读路径一致）；否则回到文件头重新流式解码。
    {
        let mut peek = [0u8; 8192];
        let n = file
            .read(&mut peek)
            .await
            .map_err(|e| format!("Read error: {e}"))?;
        if encoding::is_binary_content(&peek[..n]) {
            return Err(
                "文件疑似二进制内容（含 NUL 或非文本控制字符占比过高），read_files 不会原样返回以避免污染远程上下文。如需查看请通过其他方式获取。".into(),
            );
        }
        file.seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(|e| format!("Seek error: {e}"))?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::testutil::*;

    /// 🔴 回归（审查 P2）：UTF-16 + 行范围曾走「按字节切 `\n`」的流式路径。
    ///
    /// UTF-16LE 的换行是 `0A 00`，按字节切会让每段长度错位，逐段 `decode` 出来是
    /// 奇偶互换的乱码——而且**不报错**，用户只看到一堆看不懂的字。
    /// 现在这类编码（`!is_ascii_compatible()`）强制走全读路径：整体解码后按字符行切。
    ///
    /// 注意必须带 BOM：二进制守卫把「含 0x00 且无 UTF-16/32 BOM」判为二进制，
    /// 而真实世界的 UTF-16 文本文件基本都带 BOM。
    #[tokio::test]
    async fn utf16_line_range_is_not_garbled() {
        let (state, dir) = make_state(|c| c.encoding_detect_enabled = false);
        let file = dir.join("u16.txt");
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE]; // UTF-16LE BOM
        for u in "first\nsecond\nthird\n".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(&file, &bytes).expect("seed");

        let args = ReadFilesArgs {
            files: vec![FileRef::Detailed {
                path: file.to_string_lossy().into_owned(),
                start_line: Some(2),
                end_line: Some(2),
            }],
            start_line: None,
            end_line: None,
            encoding: Some("utf-16le".into()),
        };
        let out = handle(args, &state).await.expect("read");
        let s = serde_json::to_string(&out).expect("serialize");
        assert!(s.contains("second"), "行范围应取到第二行，实际：{s}");
        assert!(!s.contains('\u{FFFD}'), "不应出现替换字符：{s}");
    }

    /// 流式路径的适用条件（`is_ascii_compatible`）单独钉住：
    /// 只要它误判成 true，上面那条就会重新变成乱码。
    #[test]
    fn only_ascii_compatible_encodings_can_stream_by_bytes() {
        use encoding_rs::{GBK, UTF_16BE, UTF_16LE, UTF_8};
        assert!(!UTF_16LE.is_ascii_compatible());
        assert!(!UTF_16BE.is_ascii_compatible());
        assert!(UTF_8.is_ascii_compatible());
        assert!(GBK.is_ascii_compatible());
    }
}
