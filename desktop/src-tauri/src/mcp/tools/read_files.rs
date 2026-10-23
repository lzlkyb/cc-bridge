use std::path::{Path, PathBuf};
use std::sync::Arc;

use encoding_rs::UTF_8;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader};

use crate::encoding;
use crate::mcp::tools::{text_result_compact, wire_chars, MAX_INLINE_CHARS};
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

/// 单文件读取的结果 + 生成「超限指引」需要的元信息（方案 §3.5「超限即拒」）。
///
/// 为什么要带 `total_bytes` / `full_read`：超限时**不能**只回一句「太大了」——
/// 模型必须拿到「怎么读」的具体参数，否则它只会原样重试一次，白烧一轮往返。
struct ReadOutcome {
    value: Value,
    /// 文件总字节数（不是本次返回的字节数）。
    total_bytes: u64,
    /// 本次是否读了全文：决定超限时的建议是「分段读」还是「把这一段的 endLine 调小」。
    full_read: bool,
}

/// 每行平均字符数的**上界**估计：直接用「字节数 / 行数」。
///
/// UTF-8 下英文 1 字节 = 1 字符、中文 3 字节 = 1 字符，因此字节数恒 ≥ 字符数——
/// 中文文件会得到偏少的建议行数（偏保守，宁可多读一次），英文文件正好。
fn avg_chars_per_line(total_bytes: u64, total_lines: usize) -> u64 {
    (total_bytes / total_lines.max(1) as u64).max(1)
}

/// 推荐「一次读多少行」，判据是**照做之后不会再被拒**。
///
/// 🔴 固定 600 行是错的（本轮实测踩到）：900 行 × 80 列的测试文件按 600 行读一次，
/// 序列化后 48,698 字符，仍然越线 ⇒ 模型照着建议做，又被拒一次，白跑一个来回。
/// 建议值必须从文件真实密度算出来。
///
/// ⚠️ 这只是**初估**（平均密度）：换行/引号在行间的分布不均匀时平均值会低估
/// （CSV 短行带引号实测可差 ~40%），所以 [`too_large_marker`] 还要用真实内容
/// 把「第一页」精确量一遍再给出（见 [`fits_inline_budget`]）。
fn suggest_page_lines(total_bytes: u64, total_lines: usize) -> usize {
    let per_line = avg_chars_per_line(total_bytes, total_lines);
    // JSON 序列化把正文里的换行 / 引号 / 反斜杠各多算 1 字符（源码约 +15%），留出余量。
    let per_line = per_line.saturating_mul(115) / 100 + 1;
    (MAX_INLINE_CHARS as u64 / per_line).clamp(1, 600) as usize
}

/// 「读 `k` 行按 wire 口径放得下吗」——用**真实的前 `k` 行**拼出返回形状精确量一次，
/// 而不是拿平均密度估。返回 `false` 表示连 1 行都放不下（单行巨文件，按行分页彻底无效）。
///
/// 边际 2048：probe 只含 `path`+`content`，真实返回还有 `startLine/endLine/encoding/newline`
/// 等字段（约 80 字符）；中段行的密度可能比第一页高，再留一些缓冲。
fn fits_inline_budget(path: &str, content: &str, k: usize) -> bool {
    if k == 0 {
        return false;
    }
    let page: String = content.lines().take(k).collect::<Vec<_>>().join("\n");
    wire_chars(&json!({ "path": path, "content": page })) <= MAX_INLINE_CHARS - 2048
}

/// 单次返回超限时的占位对象：**不给残文**，给可执行的下一步。
///
/// 依据（方案 §2.2 第 7 条）：Claude Code 的 Read 工具实现过截断、又把它回滚了——
/// 因为截断出来的 25K token 残文会被模型当成完整内容去改代码，而抛错只花约 100 字节。
/// 所以这里返回的是「为什么 + 有多大 + 下一步怎么读」，而不是头尾拼接的片段。
fn too_large_marker(path: &str, chars: usize, outcome: &ReadOutcome) -> Value {
    let lines = outcome
        .value
        .get("content")
        .and_then(|v| v.as_str())
        .map(|c| c.lines().count());
    let mut v = json!({
        "path": path,
        "error": format!("内容超出单次内联上限，未返回正文（约 {chars} 字符 > {MAX_INLINE_CHARS}）"),
        "why": "这么大的单条结果会被客户端整条降级成前 2KB 预览，你实际看不到全文；返回残文更糟——你会以为自己读到了完整文件。",
        "fileBytes": outcome.total_bytes,
    });
    if let (true, Some(n)) = (outcome.full_read, lines) {
        v["totalLines"] = json!(n);
        let content = outcome
            .value
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("");
        // 单行/极少行文件（压缩后的 JS、一行 JSON、minified CSS）：按行分页毫无意义，
        // 必须给另一条路，否则模型会在「再试一次大范围」上死循环。
        if n <= 3 {
            v["next"] = json!(format!(
                "该文件只有 {n} 行，按行分段读无效。请改用 search_files 定位目标内容，或用 run_command 配合 head / tail / sed -n 按**字节**截取（例如 `sed -n '1,200p'` 无效时用 `cut -c1-4000`）。"
            ));
        } else {
            // 行数必须按文件密度算：固定 600 行会让「照着建议读」再被拒一次（见该函数注释）。
            // `min(n - 1)`：整个文件已经确定超限，若估计值 ≥ n 就该退一步——
            // 「把全文再读一遍」正是刚刚被拒的那件事。
            let mut per_page = suggest_page_lines(outcome.total_bytes, n)
                .min(n.saturating_sub(1))
                .max(1);
            // 平均密度是初估：行间分布不均（CSV 短行、引号密集）时会低估。
            // 用真实的前 per_page 行精确校准，超了就减半，保证示例**照抄必然成功**。
            while per_page > 1 && !fits_inline_budget(path, content, per_page) {
                per_page /= 2;
            }
            if !fits_inline_budget(path, content, per_page) {
                // 连 1 行都放不下（4 行但其中一行几万字符）：按行分页彻底失效，
                // 与「单行巨文件」同一条出路，别给一个必然失败的 startLine/endLine 示例。
                v["next"] = json!(format!(
                    "该文件存在单行超限的行（共 {n} 行），按行分段读无效。请改用 search_files 定位目标内容，或用 run_command 按字节截取。"
                ));
            } else {
                // 除了自然语言，也给一个结构化字段：模型可以照抄，测试也能精确断言
                // 「这个建议读得下去」（否则测试只能去正则解析句子）。
                v["suggestedLines"] = json!(per_page);
                v["next"] = json!(format!(
                    "用 startLine/endLine 分段读（本文件共 {n} 行，平均每行 {} 字符），单次读 {per_page} 行以内可确保不超限，例如 {{\"path\":\"{path}\",\"startLine\":1,\"endLine\":{per_page}}}；也可以先用 search_files 定位目标行再只读那一段。",
                    avg_chars_per_line(outcome.total_bytes, n)
                ));
            }
        }
    } else {
        v["next"] = json!(format!(
            "本次是按行范围读的，说明这一段本身就太大：把 endLine 调小或拆成多次读取（单次不超过 {MAX_INLINE_CHARS} 字符）。"
        ));
    }
    v["note"] = json!("文件本身没有被修改，磁盘上的内容完整——只是无法一次全部返回。");
    v
}

/// 多文件调用里累计超限之后的占位：**数据没有丢**，只是要单独发一次读取。
fn deferred_marker(path: &str) -> Value {
    json!({
        "path": path,
        "error": "本次调用已返回足够多的内容，此文件未内联（未读取，不是读取失败）",
        "next": "再次调用 read_files 单独读它（可只传这一个路径），或用 startLine/endLine 只读需要的段。",
    })
}

/// 预算已满时的**收尾条目**：后面的文件不再逐条写占位，合并成一条。
///
/// 🔴 为什么必须合并：占位对象本身也占字符（每个约 200–700）。文件多时 N 个占位累加会把
/// 整条结果顶过客户端门槛——那就成了「用防越线的机制造成越线」，而且这些文件根本没被读，
/// 纯属白花字节。合并后总长有界（一条 ~250 字符）。
fn skipped_marker(remaining: usize, first_index: usize) -> Value {
    json!({
        "error": format!("本次调用已返回足够多的内容，后 {remaining} 个文件未内联（未读取，不是读取失败）"),
        "firstPendingIndex": first_index,
        "remaining": remaining,
        "next": "把它们分成更小的批次重新调用 read_files（每批 1–3 个），或用 startLine/endLine 只读需要的段。",
    })
}

pub async fn handle(args: ReadFilesArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let cached_roots = state.cached_roots();
    let mut results = Vec::new();
    // 累计已内联的字符数：多文件一次性全给同样会越线（客户端看的是整条结果），
    // 所以除单文件门禁外还要有总量门禁——但超出的文件是「挪到下次读」，不是「拒绝读」。
    //
    // 512 是外层信封（`{"content":[{"type":"text","text":"…"}]}`）与数组括号/逗号的位置。
    let limit = MAX_INLINE_CHARS.saturating_sub(512);
    // 一条占位对象的长度上界（路径 + 两句话）。剩余预算连它都放不下时直接收尾，
    // **不再读盘**——否则剩下的文件会白读一遍再把占位挤进来。
    const MARKER_RESERVE: usize = 1024;
    let mut used = 0usize;

    for (i, item) in args.files.iter().enumerate() {
        if used + MARKER_RESERVE > limit {
            results.push(skipped_marker(args.files.len() - i, i + 1));
            break;
        }
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

        let outcome = match read_single_file(
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
            Ok(o) => o,
            Err(e) => {
                // 错误条目同样占字符：几百个失败文件累加也能顶过门槛。
                let v = json!({ "path": file_path, "error": e });
                used += wire_chars(&v);
                results.push(v);
                continue;
            }
        };

        let size = wire_chars(&outcome.value);
        // 每个文件**只记一次**账：正文记自身大小（wire 口径，见 [`wire_chars`]——
        // 只数一层序列化会把换行/引号密集的文件估小 15%+，实测 44,666 → 67,023），
        // 占位对象记它自己那一小段。
        // （内联分支曾先 `used += size` 又统一追记一次 → 预算被吃两倍，后面的小文件
        //  会被误判成「该延后」。这条路径没有现成断言能发现，靠读代码改掉的。）
        //
        // 🔴 `used > 0 &&` 不能省：`limit` 比单文件上限 `MAX_INLINE_CHARS` 小 512，
        // 于是「序列化后 44,488–45,000 字符」这一带的文件会被判「延后」。而提示叫模型
        // 「单独再读一次」，单独读时 used 仍为 0 —— 若这里也判延后，就变成**永远读不到**
        // 的死循环。首个文件必须按单文件上限放行，累计上限只用来约束「后面还有东西要放」。
        let marker = if size > MAX_INLINE_CHARS {
            Some(too_large_marker(file_path, size, &outcome))
        } else if used > 0 && used + size > limit {
            Some(deferred_marker(file_path))
        } else {
            None
        };

        match marker {
            Some(m) => {
                let msize = wire_chars(&m);
                if used + msize > limit {
                    // 连这一条占位都放不下（超长路径等极端情形）：与上面同一条收尾路径。
                    results.push(skipped_marker(args.files.len() - i, i + 1));
                    break;
                }
                used += msize;
                results.push(m);
            }
            None => {
                used += size;
                results.push(outcome.value);
            }
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
) -> Result<ReadOutcome, String> {
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
    let total_bytes = metadata.len();
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
        .await
        .map(|value| ReadOutcome {
            value,
            total_bytes,
            full_read: false,
        });
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

        Ok(ReadOutcome {
            value: json!({
                "path": file_path,
                "content": selected.join("\n"),
                "startLine": from,
                "endLine": actual_end,
                "encoding": enc_name,
                "newline": newline,
            }),
            total_bytes,
            // 走了全读路径但只截取了一段：对调用方而言仍是「范围读」，
            // 超限建议应是「把这一段拆小」而不是「按全文行数分页」。
            full_read: false,
        })
    } else {
        Ok(ReadOutcome {
            value: json!({ "path": file_path, "content": content, "encoding": enc_name, "newline": newline }),
            total_bytes,
            full_read: true,
        })
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

    // ==== 内联上限（方案 §3.5「超限即拒」）====
    //
    // 这组测试守的是**功能完整性**的两个方向：
    // ① 超限时不能返回残文（模型会把残文当全文改代码）；
    // ② 超限时必须给出可执行的下一步（否则模型只会原样重试，白烧一轮往返）。

    fn big_text_file(dir: &Path, name: &str, lines: usize, cols: usize) -> PathBuf {
        let body: String = (0..lines)
            .map(|i| format!("{:0width$}\n", i, width = cols.saturating_sub(1)))
            .collect();
        let p = dir.join(name);
        std::fs::write(&p, body).expect("seed");
        p
    }

    /// 读一个文件并解出内层 JSON（`read_files` 的结果是「JSON 里套一段 JSON 文本」）。
    async fn read_one_async(state: &Arc<AppState>, path: &Path) -> Value {
        let args = ReadFilesArgs {
            files: vec![FileRef::Simple(path.to_string_lossy().into_owned())],
            start_line: None,
            end_line: None,
            encoding: None,
        };
        let out = handle(args, state).await.expect("read");
        let text = out["content"][0]["text"].as_str().expect("text block");
        serde_json::from_str::<Value>(text).expect("parse")
    }

    /// 超限：不回正文、给出总行数与分段读取示例。
    #[tokio::test]
    async fn oversized_file_is_refused_with_actionable_hint() {
        let (state, dir) = make_state(|_| {});
        // 900 行 × 80 列 ≈ 72,000 字符 > 45,000。
        let f = big_text_file(&dir, "big.txt", 900, 80);
        let v = read_one_async(&state, &f).await;
        let first = &v[0];
        assert!(
            first.get("content").is_none(),
            "超限不得返回正文（残文会被当成全文）：{first}"
        );
        assert!(first["error"].as_str().unwrap_or("").contains("上限"));
        assert_eq!(first["totalLines"], 900, "必须给出总行数才能分段");
        let next = first["next"].as_str().unwrap_or("");
        assert!(
            next.contains("startLine"),
            "必须给出可复制的分段示例：{next}"
        );
        assert_eq!(
            first["fileBytes"].as_u64(),
            Some(std::fs::metadata(&f).unwrap().len())
        );
    }

    /// 单行巨型文件（压缩/单行 JSON）：按行分页无效，必须改口给别的路。
    #[tokio::test]
    async fn single_line_huge_file_hints_search_not_paging() {
        let (state, dir) = make_state(|_| {});
        let p = dir.join("min.js");
        std::fs::write(&p, "x".repeat(60_000)).expect("seed");
        let v = read_one_async(&state, &p).await;
        let next = v[0]["next"].as_str().unwrap_or("");
        assert!(
            next.contains("search_files"),
            "单行文件应改口指向检索：{next}"
        );
        assert!(
            !next.contains("endLine\":600"),
            "对单行文件给「读 1-600 行」是错建议：{next}"
        );
    }

    /// 小文件行为完全不变（默认路径零回归）。
    #[tokio::test]
    async fn small_file_is_returned_verbatim() {
        let (state, dir) = make_state(|_| {});
        let p = dir.join("small.txt");
        std::fs::write(&p, "hello\nworld\n").expect("seed");
        let v = read_one_async(&state, &p).await;
        assert_eq!(v[0]["content"], "hello\nworld\n");
        assert!(v[0].get("error").is_none());
    }

    /// 每个文件**只记一次预算**。回归：内联分支曾先 `used += size` 又统一追记一次，
    /// 于是一个 32K 的文件被记成 64K，紧跟着的小文件被误判「该延后」——
    /// 结果是模型必须多发一次调用读一个 20 字符的文件。
    #[tokio::test]
    async fn budget_is_charged_once_per_file() {
        let (state, dir) = make_state(|_| {});
        let big = big_text_file(&dir, "big.txt", 400, 80); // ≈32,400 字符（序列化后）
        let small = dir.join("small.txt");
        std::fs::write(&small, "tiny").expect("seed");
        let args = ReadFilesArgs {
            files: vec![
                FileRef::Simple(big.to_string_lossy().into_owned()),
                FileRef::Simple(small.to_string_lossy().into_owned()),
            ],
            start_line: None,
            end_line: None,
            encoding: None,
        };
        let out = handle(args, &state).await.expect("read");
        let v: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(v[0].get("content").is_some(), "第一个文件应内联：{}", v[0]);
        assert_eq!(
            v[1]["content"], "tiny",
            "第二个小文件必须正常返回（预算不该被算两次）：{}",
            v[1]
        );
    }

    /// 多文件累计超限：**后续文件是「下次再读」，不是「读不到」**——
    /// 这条区分很重要：如果直接报错，模型会以为文件不存在或无权限。
    #[tokio::test]
    async fn cumulative_limit_defers_remaining_files() {
        let (state, dir) = make_state(|_| {});
        let a = big_text_file(&dir, "a.txt", 400, 80); // ≈ 32,000 字符，单独看没超
        let b = big_text_file(&dir, "b.txt", 400, 80);
        let args = ReadFilesArgs {
            files: vec![
                FileRef::Simple(a.to_string_lossy().into_owned()),
                FileRef::Simple(b.to_string_lossy().into_owned()),
            ],
            start_line: None,
            end_line: None,
            encoding: None,
        };
        let out = handle(args, &state).await.expect("read");
        let v: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(v[0].get("content").is_some(), "第一个文件应正常内联：{v}");
        let second = &v[1];
        assert!(
            second.get("content").is_none(),
            "第二个文件应延后：{second}"
        );
        assert!(
            second["error"].as_str().unwrap_or("").contains("未内联"),
            "措辞必须说明是「未内联」而不是失败：{second}"
        );
        assert!(second["next"].as_str().unwrap_or("").contains("read_files"));
    }

    /// **建议必须能被照做**：按 `next` 里给的行数读一段，不能又被拒一次。
    ///
    /// 回归：`per_page` 原本写死 600 行，而 900 行 × 80 列的文件读 600 行序列化后是
    /// 48,698 字符，照样越线 ⇒ 模型照建议做，白跑一个来回。
    #[tokio::test]
    async fn suggested_page_size_actually_fits() {
        let (state, dir) = make_state(|_| {});
        let f = big_text_file(&dir, "big.txt", 900, 80);
        let first = read_one_async(&state, &f).await;
        let n = first[0]["totalLines"].as_u64().expect("totalLines") as usize;
        // 🔴 必须读**返回消息里**的建议值，不能自己再算一遍：
        // 自己算等于把被测逻辑抄了一遍，注入 bug 也照样绿（第一次就踩了这个坑）。
        let per_page = first[0]["suggestedLines"]
            .as_u64()
            .expect("超限时必须给出 suggestedLines") as usize;
        assert!(per_page >= 1 && per_page < n, "建议行数应有效：{per_page}");

        let args = ReadFilesArgs {
            files: vec![FileRef::Simple(f.to_string_lossy().into_owned())],
            start_line: Some(1),
            end_line: Some(per_page as u32),
            encoding: None,
        };
        let out = handle(args, &state).await.expect("read");
        let v: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(
            v[0].get("content").is_some(),
            "按建议读 {per_page} 行仍被拒，建议是错的：{}",
            v[0]
        );
    }

    /// 单个文件**永远不该被判「延后」**。
    ///
    /// 回归（死循环）：累计上限是 `MAX_INLINE_CHARS - 512`，而单文件上限是 `MAX_INLINE_CHARS`，
    /// 于是序列化后落在这 512 字符带里的文件会被判「延后」，提示又叫模型「单独再读一次」——
    /// 单独读时预算仍是空的（`used == 0`），照旧判延后 ⇒ **这个文件永远读不到**。
    ///
    /// 尺寸按 **wire 口径**（[`wire_chars`]）落在带内才有效：只数一层序列化时
    /// 44,712 字符的文件最终上线是 45,166，实际已经被单文件门禁拒掉，测不到那条带。
    #[tokio::test]
    async fn single_file_inside_the_margin_band_is_never_deferred() {
        let (state, dir) = make_state(|_| {});
        // 437 行 × 100 字节：wire ≈ 44,66x 字符，正好落在 (MAX-512, MAX] 这条带里。
        let f = big_text_file(&dir, "band.txt", 437, 100);
        let v = read_one_async(&state, &f).await;
        let first = &v[0];
        assert!(
            first.get("content").is_some(),
            "单文件调用不得返回「延后」（再调一次也还是延后 ⇒ 死循环）：{first}"
        );
        let size = wire_chars(first);
        assert!(
            size > MAX_INLINE_CHARS - 512 && size <= MAX_INLINE_CHARS,
            "这条测试要盯的正是那条带，但文件 wire 尺寸 {size} 不在 ({}, {MAX_INLINE_CHARS}] 内",
            MAX_INLINE_CHARS - 512
        );
    }

    /// 🔴 wire 口径回归（2026-10-23 复查实测）：只数一层序列化时，22,300 个换行的文件
    /// 按旧口径量出 44,666 ≤ 45,000 会被放行，但最终上线 JSON 是 **67,023** 字符——
    /// 客户端按 wire 分档（门槛 ≈ 49,823），整条被降级成 2KB 预览，恰好是这套上限要防的事故。
    /// 换成 `wire_chars`（含 text 外层的二次转义）后这类文件必须被拒。
    #[tokio::test]
    async fn newline_dense_file_is_measured_on_wire_chars() {
        let (state, dir) = make_state(|_| {});
        let p = dir.join("dense.txt");
        std::fs::write(&p, "\n".repeat(22_300)).expect("seed");
        let v = read_one_async(&state, &p).await;
        let first = &v[0];
        assert!(
            first.get("content").is_none(),
            "wire 67,023 字符的结果不得内联（客户端会整条降级）：{first}"
        );
        assert!(first["error"].as_str().unwrap_or("").contains("上限"));
        assert_eq!(first["fileBytes"].as_u64(), Some(22_300));
    }

    /// 预算耗尽后：**不再逐条写占位，合并成一条收尾**，整条结果不得越线。
    ///
    /// 回归：占位对象本身也占字符（每个几百），文件多时 N 个占位累加会把整条结果顶过
    /// 客户端门槛——用「防越线」的机制造成越线，而且那些文件根本没被读，纯白花字节。
    #[tokio::test]
    async fn budget_exhaustion_aggregates_the_rest() {
        let (state, dir) = make_state(|_| {});
        // 第一个文件内联掉大部分预算（430 × 100 ≈ 43,300 字符，仍在单文件上限内）。
        let mut files = vec![FileRef::Simple(
            big_text_file(&dir, "a.txt", 430, 100)
                .to_string_lossy()
                .into_owned(),
        )];
        // 后面 6 个都是超限文件（450 × 100 ≈ 45,300 > 45,000），每个都只能给占位。
        for i in 0..6 {
            files.push(FileRef::Simple(
                big_text_file(&dir, &format!("x{i}.txt"), 450, 100)
                    .to_string_lossy()
                    .into_owned(),
            ));
        }
        let out = handle(
            ReadFilesArgs {
                files,
                start_line: None,
                end_line: None,
                encoding: None,
            },
            &state,
        )
        .await
        .expect("read");
        let text = out["content"][0]["text"].as_str().unwrap();
        let v: Value = serde_json::from_str(text).unwrap();
        let last = v.as_array().unwrap().last().unwrap();
        assert!(
            last.get("remaining").is_some(),
            "预算耗尽后应合并成一条收尾，而不是逐条写占位：{last}"
        );
        assert!(
            v.as_array().unwrap().len() < 7,
            "收尾条目必须替代剩余那些占位：{}",
            v.as_array().unwrap().len()
        );
        let chars = text.chars().count();
        assert!(
            chars <= MAX_INLINE_CHARS,
            "整条结果不得越线（占位也要计预算）：{chars}"
        );
    }
}
