//! 长输出的「保存」与「返回」两件事（方案 §3.3 定稿）。
//!
//! 这两件事必须分开，理由在 `docs/上下文消耗优化方案-2026-10-22.md` §3.3：
//!
//! - **保存**：后台命令的 `untilPattern` 匹配、`include`/`exclude`/`tailLines` 过滤、
//!   `get_command_output` 的字节偏移，全都要在**完整**输出上工作。把捕获缓冲本身压到
//!   32KB，中途出现的完成标记会被挤掉、`untilPattern` 永远等不到，偏移也会失去意义。
//!   所以缓冲仍保留约 1MB，但改成「头 1/8 固定 + 尾 7/8 滚动」——**尾部始终是真尾**。
//!   （旧实现是「保开头、丢结尾」，`tailLines` 在超过 1MB 时取到的是中段而不是真尾。）
//! - **返回**：进上下文的那一段必须压进约 32KB。客户端对单次 MCP 结果的序列化文本
//!   超过约 5 万字符就**整条落盘**、对话里只给前 2KB 预览（§2.2 第 5 条，实测），
//!   而 `64KB 原文` 序列化后必然越线。所以上限按**序列化后的 UTF-8 字节**算。
//!
//! 裁剪顺序固定为「**先过滤、再裁剪**」：让 `include` 先把无关行剔掉，剩下的才是真正
//! 要挤进上下文的内容；反过来做会把过滤本来能救回来的信息先裁掉。

use serde_json::{json, Map, Value};

/// 一路输出在内存里保留的上限（头 1/8 + 尾 7/8）。
pub const CAPTURE_CAP_BYTES: usize = 1024 * 1024;

/// 单次返回的硬上限：45,000 字节的 ASCII 恰好 45,000 字符，仍在客户端约 5 万字符的
/// 落盘门槛内；再大就会让整条结果落盘、只给前 2KB 预览，多一轮往返反而更贵。
pub const MAX_RETURN_LIMIT: usize = 45_000;

/// `run_command` / `wait_command` 的默认返回上限（`get_command_output` 用
/// [`MAX_RETURN_LIMIT`]——它本来就是靠翻页取全量的入口）。
pub const DEFAULT_RETURN_LIMIT: usize = 32 * 1024;

/// 中段关键行的关键词表。
///
/// 只用这一组简单词，不做打分组合——arXiv 2608.26130 的结论就是简单关键词胜过复杂打分，
/// 而复杂打分还会让「为什么这几行被选出来」变得不可解释。
const KEY_WORDS: &[&str] = &["error", "fail", "panic", "exception", "warning"];

/// 一路输出的保存缓冲：头部固定、尾部滚动、中间丢弃记账。
///
/// 不变量：`total_bytes() == head.len() + tail.len() + dropped_bytes()`。
#[derive(Debug)]
pub struct Capture {
    head: Vec<u8>,
    tail: Vec<u8>,
    head_cap: usize,
    tail_cap: usize,
    total: u64,
}

impl Capture {
    pub fn new(cap: usize) -> Self {
        let cap = cap.max(64);
        let head_cap = cap / 8;
        Self {
            head: Vec::new(),
            tail: Vec::new(),
            head_cap,
            tail_cap: cap - head_cap,
            total: 0,
        }
    }

    pub fn with_default_cap() -> Self {
        Self::new(CAPTURE_CAP_BYTES)
    }

    /// 追加一段输出。超过上限时从**中段**丢弃（先填满头部，其余进尾部滚动）。
    pub fn push(&mut self, chunk: &[u8]) {
        self.total += chunk.len() as u64;
        let mut rest = chunk;
        if self.head.len() < self.head_cap {
            let take = (self.head_cap - self.head.len()).min(rest.len());
            self.head.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
        }
        if rest.is_empty() {
            return;
        }
        self.tail.extend_from_slice(rest);
        // 松弛量与容量成比例（1/8，至少 64B）：攒够一小段才做一次 drain，避免每个 8KB
        // 分片都 memmove 整条尾部。🔴 不能用固定大值——小容量缓冲（如测试的 1KB）会
        // 因为永远攒不够 64KB 而从不清尾，`dropped_bytes` 恒为 0。
        let slack = (self.tail_cap / 8).max(64);
        if self.tail.len() > self.tail_cap + slack {
            let excess = self.tail.len() - self.tail_cap;
            self.tail.drain(..excess);
        }
    }

    /// 这条输出总共产生了多少字节（不是保留了多少）。
    pub fn total_bytes(&self) -> u64 {
        self.total
    }

    /// 中间被丢弃的字节数；0 表示保留的内容是连续的。
    pub fn dropped_bytes(&self) -> u64 {
        self.total - self.head.len() as u64 - self.tail.len() as u64
    }

    /// 头部保留区的结束位置（也是尾部保留区之前的缺口起点）。
    pub fn head_end(&self) -> u64 {
        self.head.len() as u64
    }

    /// 尾部保留区的起始位置。
    pub fn tail_start(&self) -> u64 {
        self.total - self.tail.len() as u64
    }

    /// 整份保留内容（头部 + 尾部）。丢弃的中段无法恢复——要恢复只能重新跑命令。
    pub fn snapshot(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(self.head.len() + self.tail.len());
        v.extend_from_slice(&self.head);
        v.extend_from_slice(&self.tail);
        v
    }

    /// 整份保留内容的文本形态（`untilPattern` 匹配、`include` 过滤都扫这个）。
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.snapshot()).into_owned()
    }

    /// 从 `offset`（整条输出里的真实字节位置）开始读保留的内容。
    pub fn read_from(&self, offset: u64) -> RangeRead {
        let head_end = self.head_end();
        let tail_start = self.tail_start();
        let mut parts: Vec<u8> = Vec::new();
        let mut cursor = offset.min(self.total);
        let mut gap_bytes = 0;

        if cursor < head_end {
            parts.extend_from_slice(&self.head[cursor as usize..head_end as usize]);
            cursor = head_end;
        }
        if cursor < tail_start {
            gap_bytes = tail_start - cursor;
            parts.extend_from_slice(gap_marker(gap_bytes).as_bytes());
            cursor = tail_start;
        }
        if cursor < self.total {
            let from = (cursor - tail_start) as usize;
            parts.extend_from_slice(&self.tail[from..]);
            cursor = self.total;
        }

        RangeRead {
            text: String::from_utf8_lossy(&parts).into_owned(),
            next_offset: cursor,
            gap_bytes,
        }
    }
}

/// [`Capture::read_from`] 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeRead {
    pub text: String,
    /// 下次从哪继续（整条输出里的真实字节位置）。
    pub next_offset: u64,
    /// 本次读取区间里被丢弃的字节数（>0 表示中间有缺口，缺口处已插标记）。
    pub gap_bytes: u64,
}

fn gap_marker(bytes: u64) -> String {
    format!("\n…[中间 {bytes} 字节已被省略（超出保存上限）]…\n")
}

/// 单路裁剪参数。
pub struct ClipOpts {
    /// 这段文本可用的预算（序列化前字节；最终由 [`fit_result`] 统一收敛）。
    pub budget: usize,
    /// 允许从被丢掉的中段里抽关键行。
    pub extract_key_lines: bool,
}

/// 单路裁剪：头 1/8 + 尾 7/8，中段关键行占预算 1/4。
///
/// 返回 `(裁剪后的文本, 是否裁剪过, 中段被省略的字节数)`。
pub fn clip_text(text: &str, opts: &ClipOpts) -> (String, bool, u64) {
    if text.len() <= opts.budget {
        return (text.to_string(), false, 0);
    }
    let budget = opts.budget.max(512);
    let key_quota = if opts.extract_key_lines {
        budget / 4
    } else {
        0
    };
    let rest = budget - key_quota;
    let head_quota = rest / 8;
    let tail_quota = rest - head_quota;

    let head_end = floor_char_boundary(text, head_quota);
    let tail_start = ceil_char_boundary(text, text.len().saturating_sub(tail_quota));
    let head_end = head_end.min(tail_start);
    // 预算贴着文本长度时（字符边界回退后可能刚好放得下整个文本），中段为空——
    // 这时不能插「中间 0 字节已被省略」的标记，也没发生任何裁剪。
    if head_end >= tail_start {
        return (text.to_string(), false, 0);
    }
    let middle = &text[head_end..tail_start];

    let mut out = String::with_capacity(budget + 512);
    out.push_str(&text[..head_end]);
    out.push_str(&gap_marker(middle.len() as u64));

    if key_quota > 0 && !middle.is_empty() {
        // 行号按「整条输出」算：头部已有的换行数 + 中段内偏移。
        let head_lines = text[..head_end].matches('\n').count();
        if let Some(section) = key_lines_section(middle, key_quota, head_lines) {
            out.push_str(&section);
        }
    }
    out.push_str(&text[tail_start..]);
    (out, true, middle.len() as u64)
}

/// 从被丢掉的中段里挑出含关键词的行（**取最靠近结尾的**，因为结论通常在后面）。
fn key_lines_section(middle: &str, quota: usize, head_lines: usize) -> Option<String> {
    let mut picked: Vec<(usize, String)> = Vec::new();
    let mut used = 0usize;
    let lines: Vec<&str> = middle.split('\n').collect();
    for (i, line) in lines.iter().enumerate().rev() {
        let lower = line.to_ascii_lowercase();
        if !KEY_WORDS.iter().any(|k| lower.contains(k)) {
            continue;
        }
        let entry = format!("{:>6}: {}\n", head_lines + i + 1, line.trim_end());
        if used + entry.len() > quota {
            break;
        }
        used += entry.len();
        picked.push((i, entry));
    }
    if picked.is_empty() {
        return None;
    }
    picked.reverse();
    let mut s = String::from("…[中段关键行]…\n");
    for (_, e) in picked {
        s.push_str(&e);
    }
    Some(s)
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// [`fit_result`] 的参数。
pub struct FitOpts {
    /// 整条返回的上限，**序列化后的 UTF-8 字节**。
    pub limit: usize,
    /// 调用方已传 `include` 时传 false：以调用方的过滤为准，不再抽中段关键行。
    pub extract_key_lines: bool,
    /// 这段输出结尾是否就是整条输出的结尾（命令还在跑 = false）。
    pub tail_is_final: bool,
    /// 是否给出 `nextStdoutOffset` / `nextStderrOffset`（只有 `get_command_output` 需要）。
    pub next_offsets: bool,
}

/// 把含 `stdout`/`stderr` 的结果对象压进上限。
///
/// 调用方先把**完整**文本塞进 `info`（同时给 `stdoutTotalBytes`/`stderrTotalBytes`），
/// 这里负责：两路分预算（stderr 保底 1/4）→ 头尾裁剪 + 中段关键行 → **反复序列化收敛**
/// 到 `opts.limit`。收敛是必须的：JSON 转义会把每行 CRLF 撑成 `\r\n`、彩色输出里每个
/// ESC 撑成 6 个字符的 `\u001b`，按原文字节估的预算必然偏乐观。
pub fn fit_result(info: Map<String, Value>, opts: &FitOpts) -> Map<String, Value> {
    let out_full = info
        .get("stdout")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let err_full = info
        .get("stderr")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let out_total = info
        .get("stdoutTotalBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(out_full.len() as u64);
    let err_total = info
        .get("stderrTotalBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(err_full.len() as u64);
    let out_dropped = info
        .get("stdoutDroppedBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let err_dropped = info
        .get("stderrDroppedBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // 先量一次「空正文」的固定开销，剩下的才是两路可分的预算。
    let mut probe = info.clone();
    probe.insert("stdout".into(), json!(""));
    probe.insert("stderr".into(), json!(""));
    let overhead = serde_json::to_string(&Value::Object(probe))
        .map(|s| s.len())
        .unwrap_or(0);
    let avail = opts.limit.saturating_sub(overhead);

    let mut scale = 1.0f64;
    let mut last = info.clone();
    for _ in 0..4 {
        let budget = ((avail as f64) * scale) as usize;
        let (sb, eb) = split_budget(out_full.len(), err_full.len(), budget);
        let (o_txt, o_cut, o_mid) = clip_text(
            &out_full,
            &ClipOpts {
                budget: sb,
                extract_key_lines: opts.extract_key_lines,
            },
        );
        let (e_txt, e_cut, e_mid) = clip_text(
            &err_full,
            &ClipOpts {
                budget: eb,
                extract_key_lines: opts.extract_key_lines,
            },
        );

        let mut trial = info.clone();
        trial.insert("stdout".into(), json!(o_txt));
        trial.insert("stderr".into(), json!(e_txt));
        trial.insert("stdoutTruncated".into(), json!(o_cut || out_dropped > 0));
        trial.insert("stderrTruncated".into(), json!(e_cut || err_dropped > 0));
        if opts.next_offsets {
            trial.insert("nextStdoutOffset".into(), json!(out_total));
            trial.insert("nextStderrOffset".into(), json!(err_total));
        }

        // 截断说明必须交代三件事：这次给的是哪一段、整条输出多大、结尾是不是真尾
        // （§2.2 第 2 条那个坑：尾不是真尾时，失败原因永远到不了模型）。
        let mut notes: Vec<String> = Vec::new();
        if o_cut || out_dropped > 0 {
            notes.push(stream_note(
                "stdout",
                out_total,
                o_mid,
                out_dropped,
                opts.tail_is_final,
                o_cut,
            ));
        }
        if e_cut || err_dropped > 0 {
            notes.push(stream_note(
                "stderr",
                err_total,
                e_mid,
                err_dropped,
                opts.tail_is_final,
                e_cut,
            ));
        }
        if !notes.is_empty() {
            let merged = notes.join(" ");
            let existing = trial
                .get("note")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let text = match existing {
                Some(e) if !e.is_empty() => format!("{e} {merged}"),
                _ => merged,
            };
            trial.insert("note".into(), json!(text));
        }

        let actual = serde_json::to_string(&Value::Object(trial.clone()))
            .map(|s| s.len())
            .unwrap_or(usize::MAX);
        last = trial;
        if actual <= opts.limit {
            return last;
        }
        // 转义膨胀超预期：按比例缩预算重来（最多 4 轮）。
        scale *= (opts.limit as f64) / (actual as f64) * 0.95;
        scale = scale.clamp(0.02, 1.0);
    }
    last
}

fn stream_note(
    name: &str,
    total: u64,
    mid_bytes: u64,
    dropped: u64,
    tail_is_final: bool,
    cut: bool,
) -> String {
    let tail = if tail_is_final {
        "结尾是整条输出的真实结尾"
    } else {
        "命令仍在运行，结尾不是最终结尾"
    };
    if dropped > 0 {
        format!("{name} 共 {total} 字节，但保存缓冲已丢弃中段 {dropped} 字节（无法恢复，需重跑命令）；本次展示头尾保留部分，{tail}。")
    } else if cut {
        format!(
            "{name} 共 {total} 字节，本次只展示头 1/8 + 尾 7/8（中间省略 {mid_bytes} 字节，已尽量摘出关键行）；{tail}。"
        )
    } else {
        String::new()
    }
}

/// 两路预算分配：放得下就全给；放不下按大小分，但 **stderr 保底 1/4**（报错通常在 stderr），
/// 同时给 stdout 留至少 1/8，避免一路把另一路挤成 0。
fn split_budget(out_len: usize, err_len: usize, budget: usize) -> (usize, usize) {
    let total = out_len + err_len;
    if total <= budget {
        return (out_len, err_len);
    }
    if err_len == 0 {
        return (budget, 0);
    }
    if out_len == 0 {
        return (0, budget);
    }
    let floor = budget / 4;
    let ceil = budget - budget / 8;
    let proportional = ((budget as f64) * (err_len as f64) / (total as f64)) as usize;
    let e = proportional.clamp(floor.min(budget), ceil.min(budget));
    (budget - e, e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_keeps_head_and_true_tail() {
        let mut c = Capture::new(1024);
        // 头 128 字节固定，尾 896 字节滚动。
        for i in 0..1000 {
            c.push(format!("line-{i:04}\n").as_bytes());
        }
        let text = c.text();
        assert!(text.starts_with("line-0000"), "头部必须保留");
        assert!(text.ends_with("line-0999\n"), "尾部必须是最新内容（真尾）");
        assert!(c.dropped_bytes() > 0, "超过上限后必须记录丢弃字节");
        assert_eq!(
            c.total_bytes(),
            c.head_end() + (c.total_bytes() - c.tail_start()) + c.dropped_bytes(),
            "不变量：total = head + tail + dropped"
        );
    }

    #[test]
    fn capture_below_cap_is_contiguous() {
        let mut c = Capture::new(4096);
        c.push(b"hello ");
        c.push(b"world");
        assert_eq!(c.dropped_bytes(), 0);
        assert_eq!(c.text(), "hello world");
        assert_eq!(c.total_bytes(), 11);
    }

    #[test]
    fn read_from_reports_gap() {
        let mut c = Capture::new(200);
        for i in 0..200 {
            c.push(format!("{i:03}").as_bytes());
        }
        // 从 0 读：先给头部，再给缺口标记，再给尾部。
        let r = c.read_from(0);
        assert!(r.gap_bytes > 0, "中段被丢弃时必须报缺口");
        assert!(r.text.contains("已被省略"));
        assert_eq!(r.next_offset, c.total_bytes());
        // 落在缺口里的偏移：直接从缺口开始报，不再回退。
        let mid = c.head_end() + 1;
        let r2 = c.read_from(mid);
        assert!(r2.gap_bytes > 0);
        assert_eq!(r2.next_offset, c.total_bytes());
    }

    #[test]
    fn clip_keeps_head_tail_and_marks_middle() {
        let text: String = (0..2000).map(|i| format!("row {i}\n")).collect();
        let (out, cut, mid) = clip_text(
            &text,
            &ClipOpts {
                budget: 1024,
                extract_key_lines: false,
            },
        );
        assert!(cut);
        assert!(mid > 0);
        assert!(out.starts_with("row 0\n"), "头要保留");
        assert!(out.ends_with("row 1999\n"), "尾要保留");
        assert!(out.contains("已被省略"));
        assert!(
            out.len() < text.len() / 2,
            "裁剪要真的省下大头：{} vs {}",
            out.len(),
            text.len()
        );
    }

    #[test]
    fn clip_extracts_key_lines_from_middle() {
        let mut text = String::new();
        for i in 0..2000 {
            if i == 1000 {
                text.push_str("ERROR: something exploded\n");
            } else {
                text.push_str(&format!("row {i}\n"));
            }
        }
        let (out, _, _) = clip_text(
            &text,
            &ClipOpts {
                budget: 2048,
                extract_key_lines: true,
            },
        );
        assert!(
            out.contains("ERROR: something exploded"),
            "中段的 error 行必须被摘出来：{out}"
        );
        assert!(out.contains("已被省略"), "必须说明中间省略了多少");
    }

    #[test]
    fn key_lines_are_not_extracted_when_disabled() {
        let mut text = String::new();
        for i in 0..2000 {
            if i == 1000 {
                text.push_str("ERROR: hidden\n");
            } else {
                text.push_str(&format!("row {i}\n"));
            }
        }
        let (out, _, _) = clip_text(
            &text,
            &ClipOpts {
                budget: 2048,
                extract_key_lines: false,
            },
        );
        assert!(!out.contains("ERROR: hidden"), "调用方已过滤时不再抽关键行");
    }

    #[test]
    fn clip_respects_char_boundaries() {
        // 全是 3 字节的汉字：按字节切会切碎字符，必须回退到边界。
        let text = "中文".repeat(2000);
        let (out, cut, _) = clip_text(
            &text,
            &ClipOpts {
                budget: 1024,
                extract_key_lines: false,
            },
        );
        assert!(cut);
        // 唯一要守的是「没把多字节字符切碎」：from_utf8_lossy 出现 U+FFFD 即为切碎。
        // （不能断言「全是中/文字符」——省略标记本身是 ASCII。）
        assert!(!out.contains('\u{FFFD}'), "切断了 UTF-8 字符会出 U+FFFD");
    }

    #[test]
    fn fit_result_stays_under_limit() {
        let mut info = Map::new();
        let big = "x".repeat(400_000);
        info.insert("stdout".into(), json!(big));
        info.insert("stderr".into(), json!(""));
        info.insert("exitCode".into(), json!(0));
        info.insert("stdoutTotalBytes".into(), json!(400_000));
        info.insert("stderrTotalBytes".into(), json!(0));
        let fitted = fit_result(
            info,
            &FitOpts {
                limit: 32 * 1024,
                extract_key_lines: true,
                tail_is_final: true,
                next_offsets: false,
            },
        );
        let actual = serde_json::to_string(&Value::Object(fitted)).unwrap().len();
        assert!(actual <= 32 * 1024, "序列化后必须压进上限，实际 {actual}");
    }

    #[test]
    fn split_budget_gives_stderr_a_floor() {
        // stdout 巨大、stderr 很小：按比例 stderr 会被挤成极小值，保底 1/4 要生效。
        let (s, e) = split_budget(1_000_000, 100, 10_000);
        assert!(e >= 2_500, "stderr 至少 1/4，实际 {e}");
        assert!(s > 0, "stdout 也要留位置");
        assert_eq!(s + e, 10_000);
    }
}
