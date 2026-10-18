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
    /// 容错：部分客户端把数组 stringify 成字符串再发（审计实锤），
    /// 见 `flex_args::vec_from_json_or_string`。
    #[serde(deserialize_with = "crate::mcp::tools::flex_args::vec_from_json_or_string")]
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
        &config.exclude_patterns,
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
        // 归一化换行用于 round-trip 守卫；写回时**沿用原文件的换行风格**，
        // 保证内容（含换行风格）不丢失，且不触发 encode_text 错误的有损拒绝
        // （其守卫要求输入为 LF 归一化文本）。utf8 默认路径与改动前 as_bytes() 行为一致。
        //
        // 🔴 判据必须是**原文件**是否含 CRLF，不是新内容（审查 P2）。原实现
        // `f.content.contains("\r\n")` 看的是模型给的新内容——模型普遍按 LF 组织，
        // 于是覆盖一个 CRLF 文件时全文被翻成 LF：`.bat/.cmd` 语义改变、git diff 全红。
        // 新建文件（读不到原内容）才回退看新内容，让调用方仍能显式要 CRLF。
        let crlf = match &existing_raw {
            // 按字节判断，不依赖原文件是合法 UTF-8（GBK 文件同样适用）。
            Some(bytes) => bytes.windows(2).any(|w| w == b"\r\n"),
            None => f.content.contains("\r\n"),
        };
        let normalized = enc_mod::normalize_newlines(&f.content);
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
        backup::prune_backups(
            &resolved,
            &config.backup_dir,
            &state.data_dir,
            config.backup_retention,
            &db,
        )?;
        drop(db);
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
        // 🔴 三种情形要分开（审查 P2）。旧实现把「新建」和「原文件不是合法 UTF-8」
        // 都折成 `old = ""`，于是覆盖一个 20MB 的 GBK 文件时，整份新内容都成了 `+` 行
        // ——响应体≈全文，直接把模型上下文打爆。
        match (existing_raw.is_some(), old_content_for_diff.as_deref()) {
            // 新建文件：整份 `+` 是正常的（第一次落盘）。
            (false, _) => diff_utils::unified_diff(&f.path, "", &f.content),
            // 已有文件但解不出 UTF-8（GBK / Big5 / 二进制误判）：只回一行摘要。
            (true, None) => format!(
                "（未生成逐行 diff：原文件不是 UTF-8，已整份覆盖。原 {} 字节 → 新 {} 字节）",
                existing_raw.as_ref().map(|b| b.len()).unwrap_or(0),
                data.len()
            ),
            (true, Some(old)) => diff_utils::unified_diff(&f.path, old, &f.content),
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::testutil::*;

    /// 从 `handle` 的返回里读出第一个文件的 `ok` 标志。
    ///
    /// `handle` 把 `results` 用 `to_string_pretty` 塞进 `content[0].text`，所以要二次解析。
    /// 存在的意义：`.expect("write")` 只证明 `handle` 返回 Ok，而单文件失败是**软失败**
    /// （`ok:false`）——不查这个标志，所有「写完后读回文件」的断言都可能落在没被写过的
    /// 原文件上，测试假绿。
    fn written_ok(out: &Value) -> bool {
        out["content"][0]["text"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v[0]["ok"].as_bool())
            .unwrap_or(false)
    }

    /// 🔴 回归（审查 P2）：覆盖 CRLF 文件时**必须保留 CRLF**（即使新内容全是 LF）。
    ///
    /// 原判据是 `f.content.contains("\r\n")`——看的是模型给的新内容，而模型普遍按
    /// LF 组织，于是 CRLF 文件被整份翻成 LF：`.bat/.cmd` 语义改变、diff 全红。
    #[tokio::test]
    async fn preserves_crlf_of_existing_file() {
        let (state, dir) = make_state(|c| c.backup_enabled = false);
        // 🔴 扩展名必须在**默认白名单**内（`.txt` 在，`.bat` 不在）。
        // 这条测试原来用 `run.bat`：默认 `allowed_extensions` 不含 `.bat`，写入被
        // `assert_extension_allowed` 直接拒掉，而 `handle` 把错误吞进 `results.ok=false`
        // 仍返回 Ok——于是"读回的还是没被碰过的原文件"，CRLF 当然完好，测试**永远绿**。
        // 实测：把判据改回 `f.content.contains("\r\n")` 它也不红。所以下面必须同时断言
        // 写入真的成功，否则这条测试等于没写。
        let file = dir.join("run.txt");
        std::fs::write(&file, b"@echo off\r\necho hi\r\n").expect("seed");

        let args = WriteFilesArgs {
            files: vec![WriteFileEntry {
                path: file.to_string_lossy().into_owned(),
                // 模型给的是 LF 内容。
                content: "@echo off\necho hello\n".into(),
                encoding: None,
            }],
        };
        let out = handle(args, &state).await.expect("write");
        // ⚠️ `handle` 把**单个文件**的失败塞进 results（`ok:false`）而不是返回 Err，
        // 所以 `.expect("write")` 通过不代表写成功。这里必须解析结构确认——否则
        // 写入被拒时读回的是没被碰过的原文件，断言永远成立（假绿）。
        assert!(
            written_ok(&out),
            "写入必须真的成功，否则下面读到的只是原文件（假绿）：{out}"
        );

        let bytes = std::fs::read(&file).expect("read back");
        assert!(
            bytes.windows(2).any(|w| w == b"\r\n"),
            "CRLF 原文被翻成 LF 了：{:?}",
            String::from_utf8_lossy(&bytes)
        );
        assert!(
            !bytes.windows(2).any(|w| w == b"\n\n"),
            "不应出现裸 LF 混入"
        );
    }

    /// 相反方向：原文件是 LF 时不得被写成 CRLF（否则每次写都污染整仓 diff）。
    #[tokio::test]
    async fn keeps_lf_of_existing_file() {
        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let file = dir.join("a.txt");
        std::fs::write(&file, b"one\ntwo\n").expect("seed");

        let args = WriteFilesArgs {
            files: vec![WriteFileEntry {
                path: file.to_string_lossy().into_owned(),
                content: "one\r\ntwo\r\nthree\r\n".into(),
                encoding: None,
            }],
        };
        let out = handle(args, &state).await.expect("write");
        assert!(
            written_ok(&out),
            "写入必须真的成功（否则断言读到的只是原文件）：{out}"
        );

        let bytes = std::fs::read(&file).expect("read back");
        assert!(
            !bytes.windows(2).any(|w| w == b"\r\n"),
            "LF 原文不应被翻成 CRLF：{:?}",
            String::from_utf8_lossy(&bytes)
        );
    }

    /// 🔴 回归（审查 P2）：覆盖**非 UTF-8**（GBK）文件时，响应里不能把整份内容当 `+` 行回显。
    ///
    /// 旧实现把「原文件解不出 UTF-8」折成 `old = ""`，于是整份新内容都成了 `+` 行——
    /// 写一个 20MB 的 GBK 文件，响应≈全文，模型上下文直接被撑爆。
    #[tokio::test]
    async fn non_utf8_overwrite_does_not_echo_whole_content() {
        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let file = dir.join("gbk.txt");
        // 合法的 GBK 中文（非 UTF-8）：旧内容解不出来。
        let gbk_old = [0xD6, 0xD0, 0xCE, 0xC4]; // 「中文」
        std::fs::write(&file, gbk_old).expect("seed");

        let args = WriteFilesArgs {
            files: vec![WriteFileEntry {
                path: file.to_string_lossy().into_owned(),
                content: "新的内容".into(),
                encoding: Some("gbk".into()),
            }],
        };
        let out = handle(args, &state).await.expect("write");
        let text = serde_json::to_string(&out).expect("serialize");

        assert!(
            text.contains("未生成逐行 diff"),
            "非 UTF-8 覆盖应给一行摘要而不是逐行 diff：{text}"
        );
        assert!(
            !text.contains("+新的内容"),
            "绝不能把整份新内容当 diff 回显：{text}"
        );
    }
}
