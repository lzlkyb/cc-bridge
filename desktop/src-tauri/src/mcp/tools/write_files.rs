use std::sync::Arc;

use encoding_rs::UTF_8;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::backup;
use crate::diff_utils;
use crate::encoding as enc_mod;
use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct WriteFileEntry {
    pub path: String,
    pub content: String,
    /// 可选：写盘编码。省略时——若目标文件已存在且服务端编码自动识别(encoding_detect_enabled)开启,
    /// 则探测并沿用原文件编码(GBK 文件保持 GBK,不再被静默转成 UTF-8,与 read_files/edit_files 对齐);
    /// 否则按 utf8。显式传 "gbk"/"gb18030"/"utf-16le" 等强制该编码;传 "base64" 则把 content 当 base64 解码为原始二进制写入。
    pub encoding: Option<String>,
}

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct WriteFilesArgs {
    pub files: Vec<WriteFileEntry>,
}

pub async fn handle(args: WriteFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let mut results = Vec::new();

    for f in &args.files {
        match write_single(f, &config, state).await {
            Ok(diff) => results.push(json!({ "path": f.path, "ok": true, "diff": diff })),
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
) -> Result<String, String> {
    let resolved = security::path::resolve_safe_path_cached(
        &f.path,
        &state.cached_roots(),
        config.whitelist_enabled,
    )?;
    security::extension::assert_extension_allowed(&resolved, &config.allowed_extensions)?;

    let is_base64 = f.encoding.as_deref() == Some("base64");

    // 读一次原文件字节:既用于编码自动探测(下方),也用于生成 diff 的旧内容。
    // 新建文件 / 读取失败 → None。base64(二进制)写入不生成文本 diff、也不探测编码。
    let existing_raw: Option<Vec<u8>> = if is_base64 {
        None
    } else {
        tokio::fs::read(&resolved).await.ok()
    };

    // 旧内容用于 diff:沿用改动前语义——仅当原文件是合法 UTF-8 时才展示逐行 diff,
    // 否则(新建 / 非 UTF-8)按空内容处理。复用 existing_raw,避免二次读盘。
    let old_content_for_diff = existing_raw
        .as_ref()
        .and_then(|b| String::from_utf8(b.clone()).ok());

    let data = if is_base64 {
        base64_decode(&f.content)?
    } else {
        // 决定写盘编码:
        // - 显式传了 encoding → 用它(含显式 "utf8",强制转码)。
        // - 省略 encoding(None) → 自动模式:目标文件已存在、服务端自动识别开启、且不是二进制,
        //   则探测并沿用原文件编码(GBK 保持 GBK,与 read_files/edit_files 行为对齐);
        //   否则(新建 / 开关关 / 二进制)回退 utf8。
        // 安全性:即使探测选了 GBK,下面 encode_text 的 round-trip 守卫也会在新内容含该编码
        //   无法表示的字符时报错而非损坏文件,因此写侧探测猜错不会造成静默损坏。
        let enc = match f.encoding.as_deref() {
            Some(label) => enc_mod::label_to_encoding(label)
                .ok_or_else(|| format!("Unknown encoding label: {label}"))?,
            None => match &existing_raw {
                Some(bytes)
                    if config.encoding_detect_enabled
                        && !bytes.is_empty()
                        && !enc_mod::is_binary_content(bytes) =>
                {
                    enc_mod::detect_encoding(bytes)
                }
                _ => UTF_8,
            },
        };
        // 归一化换行用于 round-trip 守卫；若原文含 CRLF，则写回时还原 CRLF，
        // 保证内容（含换行风格）不丢失，且不触发 encode_text 错误的有损拒绝
        // （其守卫要求输入为 LF 归一化文本）。utf8 默认路径与改动前 as_bytes() 行为一致。
        let crlf = f.content.contains("\r\n");
        let normalized = f.content.replace("\r\n", "\n").replace('\r', "\n");
        enc_mod::encode_text(&normalized, enc, crlf, false)
            .map_err(|e| format!("Failed to encode content as {}: {e}", enc.name()))?
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
        let db = state.db.lock().await;
        let bp =
            backup::backup_before_overwrite(&resolved, &config.backup_dir, &state.data_dir, &db)?;
        drop(db);
        backup::prune_backups(
            &resolved,
            &config.backup_dir,
            &state.data_dir,
            config.backup_retention,
        )?;
        // 关联审计：记录本次备份路径 + 目标路径（供一键回滚 / Diff 使用）。
        crate::audit::record_op_backup(bp, Some(resolved.clone()));
    }

    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create parent dirs: {e}"))?;
    }

    let t0 = std::time::Instant::now();
    // M9 修复：改用原子写（同目录临时文件 + rename），与 edit_files/notebook_edit 一致，
    // 避免直接覆写时进程被杀/断电/磁盘满导致原文件被截断损坏。
    crate::mcp::tools::edit_files::write_atomic(&resolved, &data)
        .await
        .map_err(|e| format!("Write failed: {e}"))?;
    crate::timing::record_io(t0.elapsed());

    let diff = if !is_base64 {
        diff_utils::unified_diff(
            &f.path,
            old_content_for_diff.as_deref().unwrap_or(""),
            &f.content,
        )
    } else {
        String::new()
    };

    Ok(diff)
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    // E-P2-3: O(1) 查找表替代 O(64) 线性搜索
    static DECODE_TABLE: std::sync::LazyLock<[u8; 128]> = std::sync::LazyLock::new(|| {
        let mut table = [0xFFu8; 128];
        for (i, &b) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            .iter()
            .enumerate()
        {
            table[b as usize] = i as u8;
        }
        table
    });
    let table = &*DECODE_TABLE;
    let input = input.trim().replace(['\n', '\r'], "");
    let mut output = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u32;

    for c in input.bytes() {
        if c == b'=' {
            break;
        }
        if c >= 128 {
            return Err(format!("Invalid base64 character: {}", c as char));
        }
        let val = table[c as usize];
        if val == 0xFF {
            return Err(format!("Invalid base64 character: {}", c as char));
        }
        let val = val as u32;
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
