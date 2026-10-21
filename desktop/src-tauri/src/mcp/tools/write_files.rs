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
    /// 回显档位：`none` | `stat` | `hunks` | `full` | `auto`（省略 = `auto`）。
    /// `auto`：新建文件只回 `+N/-M 行`，覆盖已有文件回截断到 4KB 的 hunk。
    /// 详见 [`crate::diff_utils::DiffMode`]。
    pub diff: Option<String>,
}

/// `write_single` 的落盘结果。回显档位的解释放在 `handle` 里做，工具函数只管事实。
struct WriteOutcome {
    /// 写之前目标文件是否存在（决定 `auto` 落成 `stat` 还是 `hunks`）。
    existed: bool,
    old_bytes: usize,
    new_bytes: usize,
    /// 原文件内容——仅当它是合法 UTF-8 时 `Some`。`None` 且 `existed` 为真 ＝ 非 UTF-8 原文，
    /// 无法逐行比较（GBK / Big5 / 被误判成文本的二进制）。
    old_text: Option<String>,
    /// base64 写入的是二进制原文，逐行 diff 无意义。
    binary: bool,
}

pub async fn handle(args: WriteFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    // 档位解析失败要整次拒绝（而不是静默回落 auto）：调用方拼错 "stat " 之外的写法时，
    // 悄悄按 auto 处理会让它以为拿到了 stat，实际收到的却是 diff 正文。
    let mode = match args.diff.as_deref() {
        Some(raw) => diff_utils::DiffMode::parse(raw)?,
        None => diff_utils::DiffMode::Auto,
    };
    let config = state.config.read().await;
    let mut results = Vec::new();

    for f in &args.files {
        match write_single(f, &config, state).await {
            Ok(out) => {
                let mut row = json!({ "path": f.path, "ok": true });
                // `none` 档位不带 diff 字段（而不是给个空串）——免得模型以为「改了但没变化」。
                if let Some(d) = render_diff(mode, f, &out) {
                    row["diff"] = json!(d);
                }
                results.push(row);
            }
            Err(e) => results.push(json!({ "path": f.path, "ok": false, "error": e })),
        }
    }

    Ok(
        json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&results).unwrap() }] }),
    )
}

/// 按档位渲染单个文件的 `diff` 字段；`None` ＝ 结果里不出现该字段。
fn render_diff(
    mode: diff_utils::DiffMode,
    f: &WriteFileEntry,
    out: &WriteOutcome,
) -> Option<String> {
    if out.binary {
        // 改造前就返回空串，保持不变（二进制没有可比的文本行）。
        return Some(String::new());
    }
    match mode.resolve(out.existed) {
        // 🔴 原文件非 UTF-8：既不能拿空串当 old（那会把整份新内容标成 `+` 行，20MB 文件的
        // 响应≈全文），也不能假装 diff 成功。给一句带字节数的摘要，行为与改造前一致。
        diff_utils::DiffMode::Hunks | diff_utils::DiffMode::Full
            if out.existed && out.old_text.is_none() =>
        {
            Some(format!(
                "（未生成逐行 diff：原文件不是 UTF-8，已整份覆盖。原 {} 字节 → 新 {} 字节）",
                out.old_bytes, out.new_bytes
            ))
        }
        resolved => diff_utils::render(
            resolved,
            out.existed,
            &f.path,
            out.old_text.as_deref().unwrap_or(""),
            &f.content,
            out.old_bytes,
            out.new_bytes,
        ),
    }
}

async fn write_single(
    f: &WriteFileEntry,
    config: &crate::config::BridgeConfig,
    state: &Arc<AppState>,
) -> Result<WriteOutcome, String> {
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

    // 回显档位的选择交给调用方（见 `render_diff`）；这里只把「改前/改后」的事实带出去。
    // 旧实现在这里无条件算完整 diff，于是新建文件＝整份内容第二次进上下文。
    Ok(WriteOutcome {
        existed: existing_raw.is_some(),
        old_bytes: existing_raw.as_ref().map(|b| b.len()).unwrap_or(0),
        new_bytes: data.len(),
        old_text: old_content_for_diff,
        binary: is_base64,
    })
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
            diff: None,
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
            diff: None,
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
            diff: None,
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

    /// 从 `handle` 的返回里取出 `content[0].text`（再解析出结构用）。
    fn result_text(out: &Value) -> String {
        out["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    /// 🔴 token 回归：新建文件默认**不得**把内容当 `+` 行回显。
    ///
    /// 这是 RFC 里最省 token 的一条——模型刚写进去的内容它自己知道，回显纯属第二次付费。
    #[tokio::test]
    async fn new_file_default_diff_is_stat_only() {
        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let file = dir.join("big.md");
        let body = "这是一行正文，不该出现在响应里\n".repeat(40);

        let args = WriteFilesArgs {
            files: vec![WriteFileEntry {
                path: file.to_string_lossy().into_owned(),
                content: body.clone(),
                encoding: None,
            }],
            diff: None, // 省略 = auto
        };
        let out = handle(args, &state).await.expect("write");
        assert!(written_ok(&out), "写入必须真的成功：{out}");
        let text = result_text(&out);
        assert!(
            text.contains("+40/-0 行"),
            "新建文件默认应给行数统计：{text}"
        );
        assert!(
            !text.contains("这是一行正文"),
            "新建文件默认不得回显内容（省 token 的全部意义就在这里）：{text}"
        );
    }

    /// 显式 `full` 必须回到改造前的行为（整份 `+` 行），否则想要精确核对的人无从下手。
    #[tokio::test]
    async fn explicit_full_diff_echoes_content() {
        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let file = dir.join("full.txt");

        let args = WriteFilesArgs {
            files: vec![WriteFileEntry {
                path: file.to_string_lossy().into_owned(),
                content: "alpha\nbeta\n".into(),
                encoding: None,
            }],
            diff: Some("full".into()),
        };
        let out = handle(args, &state).await.expect("write");
        assert!(written_ok(&out), "写入必须真的成功：{out}");
        let text = result_text(&out);
        assert!(text.contains("+alpha"), "full 应回显内容：{text}");
        assert!(
            text.contains("+++ b/"),
            "full 应保留 unified diff 头：{text}"
        );
    }

    /// `none` 是「连 diff 字段都不要」——不能退化成空串字段，
    /// 否则模型会把它读成「改了但内容没变」。
    #[tokio::test]
    async fn diff_none_omits_field_entirely() {
        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let file = dir.join("silent.txt");

        let args = WriteFilesArgs {
            files: vec![WriteFileEntry {
                path: file.to_string_lossy().into_owned(),
                content: "hello\n".into(),
                encoding: None,
            }],
            diff: Some("none".into()),
        };
        let out = handle(args, &state).await.expect("write");
        let rows: Value = serde_json::from_str(&result_text(&out)).expect("rows json");
        assert_eq!(rows[0]["ok"], json!(true));
        assert!(
            rows[0].get("diff").is_none(),
            "diff:\"none\" 时结果里不应出现 diff 字段：{rows}"
        );
    }

    /// 档位拼错必须整次报错，并列出合法值（静默回落 auto 会让调用方误判拿到的是 stat）。
    #[tokio::test]
    async fn unknown_diff_mode_is_rejected() {
        let (state, dir) = make_state(|c| c.backup_enabled = false);
        let args = WriteFilesArgs {
            files: vec![WriteFileEntry {
                path: dir.join("x.txt").to_string_lossy().into_owned(),
                content: "x".into(),
                encoding: None,
            }],
            diff: Some("short".into()),
        };
        let err = handle(args, &state)
            .await
            .expect_err("非法 diff 档位必须报错");
        assert!(err.contains("hunks"), "错误文案要列出合法值：{err}");
    }
}
