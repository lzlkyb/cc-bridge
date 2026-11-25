//! 响应里的模型名回填（model masking）。
//!
//! 中转在请求侧把客户端认的名字换成上游认的名字（`server.rs` 的
//! `out_json["model"] = decision.upstream_model`），响应侧必须换回来。否则下游
//! 客户端会把上游真名写进会话记录，并拿它去查上下文窗口和价目表——按一张错的
//! 能力表工作。
//!
//! 三条路径的改写点不同，但目标一致：
//!
//! | 路径 | 改在哪 |
//! |---|---|
//! | Anthropic 非流式 | 整条 JSON 的 `model` |
//! | Anthropic 流式 | **只改首个事件块**里的 `message_start.message.model` |
//! | OpenAI 方言 | 不在这里——事件本来就是我们造的，填名字时直接用请求名 |
//!
//! 流式只要读一个事件块，是因为 Anthropic 协议保证 `message_start` 是第一个事件，
//! 之后不会再出现 `model`。所以不需要全程解析：缓冲到第一个 `\n\n`，改完就永久
//! 转入透传，后面几十 MB 的内容一个字节都不碰。
//!
//! **失败一律降级为透传**，并把原因记进日志。改写失败不能让请求坏掉——宁可名字
//! 不对，也不能让流断在半路。但降级必须可见：静默降级等于「永远查不出为什么这次
//! 又是真实名」。
//!
//! 设计上刻意**不**复用 `UsageObserver`：它已经在逐行解析整条流，看似能顺手改，
//! 但它是纯观察——坏了不影响转发。让它同时输出，观察器的 bug 就直接变成用户流量
//! 损坏。用不到 1KB 的首块再解析一次，换这个隔离很划算。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 首个事件块的缓冲上限。
///
/// `message_start` 通常不到 1KB。设上限是为了防上游发垃圾（或根本不是 SSE）时
/// 无限缓冲把内存撑爆——超了就放弃改写，原样放行。
const PEEK_LIMIT: usize = 16 * 1024;

/// 非流式响应整条缓冲的上限。
///
/// 非流式本来就要等整条响应，缓冲它不额外增加等待。上限只防极端大响应把内存
/// 翻倍——超了就原样发出去，不改名。
const JSON_LIMIT: usize = 8 * 1024 * 1024;

/// 这次改写的结果。写进日志，**包括失败**。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRewrite {
    /// 改成功了。
    Rewritten,
    /// 首个事件不是 `message_start`（上游没按协议开头）。
    NotMessageStart,
    /// 响应里没有 `message` / `model` 字段，没得改。
    NoModel,
    /// 首块或整条响应超过缓冲上限。
    TooLarge,
    /// 不是 UTF-8、不是 JSON、或 data 行不止一行。
    Unparsable,
}

impl ModelRewrite {
    /// 是否是「名字对不上」的降级（客户端会看到上游真名）。
    ///
    /// 给日志用：界面据此把这一行标出来，而不是让用户自己比对名字。
    pub fn leaked_real_name(self) -> bool {
        matches!(
            self,
            ModelRewrite::NotMessageStart | ModelRewrite::TooLarge | ModelRewrite::Unparsable
        )
    }
}

/// `push` 的返回值：告诉转发层「这一块怎么发」。
pub enum Emit {
    /// 原样转发入参，零拷贝。
    Raw,
    /// 还在缓冲，这一块暂时不发。
    Buffered,
    /// 发送这些字节（改写结果、或缓冲冲出来的残料）。
    Bytes(Vec<u8>),
}

pub struct ModelRewriter {
    /// 要写进去的名字（客户端请求的那个）。
    model: String,
    stream: bool,
    done: bool,
    buffer: Vec<u8>,
    /// 已经决定要原样发出、但还没交给转发层的字节。
    ///
    /// 只在一种情况下非空：流开头来了 SSE 注释块，我们放它过去、同时继续等
    /// 真正的第一个事件。攒起来一次交出去，避免多写一次发送。
    pending: Vec<u8>,
    outcome: Option<ModelRewrite>,
}

impl ModelRewriter {
    pub fn new(model: impl Into<String>, stream: bool) -> Self {
        Self {
            model: model.into(),
            stream,
            done: false,
            buffer: Vec::new(),
            pending: Vec::new(),
            outcome: None,
        }
    }

    /// 这次改写的结果。`None` = 还没结束。
    pub fn outcome(&self) -> Option<ModelRewrite> {
        self.outcome
    }

    pub fn push(&mut self, chunk: &[u8]) -> Emit {
        if self.done {
            return Emit::Raw;
        }
        self.buffer.extend_from_slice(chunk);
        if self.stream {
            self.pump_stream()
        } else if self.buffer.len() > JSON_LIMIT {
            self.outcome = Some(ModelRewrite::TooLarge);
            self.done = true;
            Emit::Bytes(std::mem::take(&mut self.buffer))
        } else {
            Emit::Buffered
        }
    }

    /// 上游读完了。把缓冲里剩下的东西冲出去。
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = std::mem::take(&mut self.pending);
        if self.done {
            out.extend(std::mem::take(&mut self.buffer));
            return out;
        }
        if self.buffer.is_empty() {
            return out;
        }
        self.done = true;

        if self.stream {
            // 流结束了还没等到完整事件：多半上游发的是半截或根本不是 SSE。
            // 原样放出去，别把已经收到的内容吞掉。
            self.outcome.get_or_insert(ModelRewrite::Unparsable);
            out.extend(std::mem::take(&mut self.buffer));
            return out;
        }

        match rewrite_json(&self.buffer, &self.model) {
            Ok(Some(bytes)) => {
                self.outcome = Some(ModelRewrite::Rewritten);
                out.extend(bytes);
            }
            Ok(None) => {
                self.outcome.get_or_insert(ModelRewrite::NoModel);
                out.extend(std::mem::take(&mut self.buffer));
            }
            Err(reason) => {
                self.outcome = Some(reason);
                out.extend(std::mem::take(&mut self.buffer));
            }
        }
        out
    }

    /// 流式：等到第一个**真正的**事件块就改，之后永久透传。
    fn pump_stream(&mut self) -> Emit {
        while let Some((index, sep)) = find_boundary(&self.buffer) {
            let rest = self.buffer.split_off(index + sep);
            let block = std::mem::replace(&mut self.buffer, rest);

            // 不含 data 字段的块是 SSE 注释或心跳。原样放过去，但**不算**
            // 「第一个事件」——真正的事件还在后面。不少网关会在流开头插一行
            // 注释，把它当首个事件就会白白放弃改写。
            if !has_data_line(&block) {
                self.pending.extend_from_slice(&block);
                continue;
            }

            self.done = true;
            match self.rewrite_event(&block) {
                Ok(bytes) => {
                    self.outcome = Some(ModelRewrite::Rewritten);
                    self.pending.extend(bytes);
                }
                Err(reason) => {
                    self.outcome = Some(reason);
                    self.pending.extend_from_slice(&block);
                }
            }
            // 同一个 chunk 里排在后面的事件原样发出：从这一刻起我们不再解析。
            self.pending.extend_from_slice(&self.buffer);
            self.buffer.clear();
            break;
        }

        if !self.done && self.buffer.len() > PEEK_LIMIT {
            self.outcome = Some(ModelRewrite::TooLarge);
            self.done = true;
            self.pending.extend(std::mem::take(&mut self.buffer));
        }

        if self.pending.is_empty() {
            Emit::Buffered
        } else {
            Emit::Bytes(std::mem::take(&mut self.pending))
        }
    }

    /// 改写一个完整事件块（含结尾分隔符）。失败时返回原因，调用方用原始字节。
    fn rewrite_event(&self, block: &[u8]) -> Result<Vec<u8>, ModelRewrite> {
        let text = std::str::from_utf8(block).map_err(|_| ModelRewrite::Unparsable)?;

        let mut event_name: Option<&str> = None;
        let mut data: Option<&str> = None;
        for line in text.split_inclusive('\n') {
            let body = line.trim_end_matches(['\n', '\r']);
            if let Some(rest) = body.strip_prefix("event:") {
                event_name = Some(rest.trim());
            } else if let Some(rest) = body.strip_prefix("data:") {
                // 多行 data（协议允许，Anthropic 不用）：拼起来会更复杂，
                // 这类上游极罕见，直接放弃改写。
                if data.is_some() {
                    return Err(ModelRewrite::Unparsable);
                }
                data = Some(rest.trim_start());
            }
        }

        // 客户端按 `event:` 行分派。有这一行且不是 message_start 就没我们的事。
        if let Some(name) = event_name {
            if name != "message_start" {
                return Err(ModelRewrite::NotMessageStart);
            }
        }

        let data = data.ok_or(ModelRewrite::Unparsable)?;
        let mut value: Value = serde_json::from_str(data).map_err(|_| ModelRewrite::Unparsable)?;
        if event_name.is_none()
            && value.get("type").and_then(Value::as_str) != Some("message_start")
        {
            return Err(ModelRewrite::NotMessageStart);
        }
        if value
            .get("message")
            .and_then(|message| message.get("model"))
            .is_none()
        {
            return Err(ModelRewrite::NoModel);
        }
        value["message"]["model"] = Value::String(self.model.clone());

        let new_data = value.to_string();
        // 重建整块：只换 data 行，`event:` 行与空白原样保留。
        let mut out = String::with_capacity(block.len() + new_data.len());
        for line in text.split_inclusive('\n') {
            let body = line.trim_end_matches(['\n', '\r']);
            if body.starts_with("data:") {
                out.push_str("data: ");
                out.push_str(&new_data);
                // 保留原来的行尾（`\r\n` 或 `\n`）。
                out.push_str(&line[body.len()..]);
            } else {
                out.push_str(line);
            }
        }
        Ok(out.into_bytes())
    }
}

/// 非流式：整条 JSON 换 `model`。
fn rewrite_json(body: &[u8], model: &str) -> Result<Option<Vec<u8>>, ModelRewrite> {
    let mut value: Value = serde_json::from_slice(body).map_err(|_| ModelRewrite::Unparsable)?;
    if value.get("model").is_none() {
        return Ok(None);
    }
    value["model"] = Value::String(model.to_string());
    serde_json::to_vec(&value)
        .map(Some)
        .map_err(|_| ModelRewrite::Unparsable)
}

/// 这个块里有没有 SSE 的 data 字段。
///
/// 没有的话它就是注释行或纯心跳——可以原样转发，但不该被当成「第一个事件」。
fn has_data_line(block: &[u8]) -> bool {
    block.split(|byte| *byte == b'\n').any(|line| {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        line.starts_with(b"data:")
    })
}

fn find_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0;
    while index + 1 < buffer.len() {
        if buffer[index] == b'\n' && buffer[index + 1] == b'\n' {
            return Some((index, 2));
        }
        if buffer[index] == b'\r'
            && buffer[index + 1] == b'\n'
            && index + 3 < buffer.len()
            && buffer[index + 2] == b'\r'
            && buffer[index + 3] == b'\n'
        {
            return Some((index, 4));
        }
        index += 1;
    }
    None
}

/// 上游自报的模型名和预期的名字对不上吗？
///
/// **只用于日志标记**，跟改写无关——改写是无条件的（请求了别名就改回别名，
/// 不需要判断）。这个判定的唯一用途是回答「上游有没有把我的模型偷偷换掉」。
///
/// 规则刻意只容忍**写法差异**，不容忍**型号差异**：
///
/// - 大小写、`vendor/` 前缀、`-latest` 后缀 → 一致
/// - 日期快照后缀（`-20250514` / `-2025-05-14`）→ 一致
/// - 版本分隔符（`5-5` 与 `5.5`）→ 一致
/// - `gpt-5` 与 `gpt-5-mini` → **不一致**（确实换了型号，这是要报警的情形）
pub fn is_substituted(reported: &str, expected: &[&str]) -> bool {
    let reported = normalize_model(reported);
    if reported.is_empty() {
        return false;
    }
    // 空期望要过滤掉：`[""]` 不能匹配一切，也不能反过来把每个模型都判成被替换。
    // 一个可用期望都没有时，这条判断就无从下手，报「不一致」只是噪音。
    let candidates: Vec<String> = expected
        .iter()
        .map(|name| normalize_model(name))
        .filter(|name| !name.is_empty())
        .collect();
    if candidates.is_empty() {
        return false;
    }
    !candidates.iter().any(|name| name == &reported)
}

fn normalize_model(name: &str) -> String {
    let lower = name.trim().to_ascii_lowercase();
    // `anthropic/claude-sonnet-5` → `claude-sonnet-5`
    let tail = lower.rsplit('/').next().unwrap_or(&lower).trim();
    let stripped = strip_date_tail(tail);
    let stripped = stripped.strip_suffix("-latest").unwrap_or(stripped);
    unify_version_separators(stripped)
}

fn strip_date_tail(s: &str) -> &str {
    let Some((head, last)) = s.rsplit_once('-') else {
        return s;
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());

    // `-20250514`
    if last.len() == 8 && digits(last) {
        return head;
    }
    // `-2025-05-14`
    if last.len() == 2 && digits(last) {
        if let Some((head2, mid)) = head.rsplit_once('-') {
            if mid.len() == 2 && digits(mid) {
                if let Some((head3, year)) = head2.rsplit_once('-') {
                    if year.len() == 4 && year.starts_with("20") && digits(year) {
                        return head3;
                    }
                }
            }
        }
    }
    s
}

/// `claude-opus-4-5` 与 `claude-opus-4.5` 是同一个版本的两种写法。
fn unify_version_separators(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    for (index, ch) in s.char_indices() {
        let between_digits = index > 0
            && bytes[index - 1].is_ascii_digit()
            && bytes.get(index + 1).is_some_and(u8::is_ascii_digit);
        if matches!(ch, '-' | '_' | '.') && between_digits {
            out.push('.');
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message_start(model: &str) -> String {
        format!(
            "event: message_start\ndata: {}\n\n",
            serde_json::json!({
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [],
                    "usage": { "input_tokens": 12, "output_tokens": 1 }
                }
            })
        )
    }

    fn text_of(emit: Emit) -> String {
        match emit {
            Emit::Bytes(bytes) => String::from_utf8(bytes).expect("必须是 UTF-8"),
            Emit::Raw => panic!("不该原样透传"),
            Emit::Buffered => String::new(),
        }
    }

    #[test]
    fn stream_rewrites_only_the_first_event() {
        let mut rewriter = ModelRewriter::new("claude-sonnet-5-5", true);
        let head = text_of(rewriter.push(message_start("deepseek-v4.1-flash").as_bytes()));
        assert!(head.contains("claude-sonnet-5-5"));
        assert!(!head.contains("deepseek"));
        assert_eq!(rewriter.outcome(), Some(ModelRewrite::Rewritten));

        // 之后的事件必须原样透传，一个字节都不碰。
        let tail =
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0}\n\n";
        assert!(matches!(rewriter.push(tail.as_bytes()), Emit::Raw));
    }

    #[test]
    fn split_first_event_is_reassembled() {
        let full = message_start("gpt-6-astra");
        let cut = full.len() / 2;
        let mut rewriter = ModelRewriter::new("claude-opus-5", true);

        assert!(matches!(
            rewriter.push(&full.as_bytes()[..cut]),
            Emit::Buffered
        ));
        let out = text_of(rewriter.push(&full.as_bytes()[cut..]));
        assert!(out.contains("\"model\":\"claude-opus-5\""));
        assert!(out.ends_with("\n\n"), "分隔符不能丢");
    }

    #[test]
    fn second_event_in_the_same_chunk_is_forwarded() {
        let mut rewriter = ModelRewriter::new("m", true);
        let whole = format!(
            "{}{}",
            message_start("real"),
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
        );
        let out = text_of(rewriter.push(whole.as_bytes()));
        assert!(out.contains("\"model\":\"m\""));
        assert!(out.contains("message_stop"), "同块里的第二个事件不能吞");
    }

    #[test]
    fn non_message_start_degrades_and_says_why() {
        let mut rewriter = ModelRewriter::new("m", true);
        let block = "event: error\ndata: {\"type\":\"error\",\"error\":{\"message\":\"boom\"}}\n\n";
        let out = text_of(rewriter.push(block.as_bytes()));
        assert_eq!(out, block, "失败必须原样放出去");
        assert_eq!(rewriter.outcome(), Some(ModelRewrite::NotMessageStart));
        assert!(rewriter.outcome().unwrap().leaked_real_name());
    }

    #[test]
    fn missing_model_is_not_invented() {
        let mut rewriter = ModelRewriter::new("m", true);
        let block = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"x\"}}\n\n";
        let out = text_of(rewriter.push(block.as_bytes()));
        assert_eq!(out, block);
        assert_eq!(rewriter.outcome(), Some(ModelRewrite::NoModel));
    }

    #[test]
    fn bad_json_degrades() {
        let mut rewriter = ModelRewriter::new("m", true);
        let block = "event: message_start\ndata: {not json\n\n";
        assert_eq!(text_of(rewriter.push(block.as_bytes())), block);
        assert_eq!(rewriter.outcome(), Some(ModelRewrite::Unparsable));
    }

    #[test]
    fn oversized_head_is_flushed_verbatim() {
        let mut rewriter = ModelRewriter::new("m", true);
        let noise = vec![b'x'; PEEK_LIMIT + 1];
        let out = text_of(rewriter.push(&noise));
        assert_eq!(out.len(), noise.len());
        assert_eq!(rewriter.outcome(), Some(ModelRewrite::TooLarge));
        // 之后一律原样透传，不再尝试。
        assert!(matches!(rewriter.push(b"anything"), Emit::Raw));
    }

    #[test]
    fn comment_before_message_start_does_not_abort_rewriting() {
        let mut rewriter = ModelRewriter::new("claude-opus-5", true);
        // 不少网关在流开头发一行 SSE 注释做保活。它是「一个完整块」但不是
        // 一个事件——要是把它当首个事件，改写就白白放弃了。
        let first = text_of(rewriter.push(b": ping\n\n"));
        assert_eq!(first, ": ping\n\n", "注释块要原样、且立刻转发");
        assert_eq!(rewriter.outcome(), None, "注释块不该决定改写结果");

        let out = text_of(rewriter.push(message_start("real").as_bytes()));
        assert!(out.contains("\"model\":\"claude-opus-5\""), "{out}");
        assert_eq!(rewriter.outcome(), Some(ModelRewrite::Rewritten));
    }

    #[test]
    fn finish_flushes_partial_stream() {
        let mut rewriter = ModelRewriter::new("m", true);
        assert!(matches!(
            rewriter.push(b"event: message_st"),
            Emit::Buffered
        ));
        assert_eq!(rewriter.finish(), b"event: message_st".to_vec());
        assert_eq!(rewriter.outcome(), Some(ModelRewrite::Unparsable));
    }

    #[test]
    fn crlf_events_keep_their_line_endings() {
        let mut rewriter = ModelRewriter::new("m", true);
        let block = message_start("real").replace('\n', "\r\n");
        let out = text_of(rewriter.push(block.as_bytes()));
        assert!(out.contains("\"model\":\"m\""));
        assert!(out.contains("\r\n"), "行尾不能被改成 LF");
    }

    #[test]
    fn json_response_gets_the_requested_name() {
        let body = serde_json::json!({
            "id": "msg_1", "type": "message", "model": "step-5-preview",
            "content": [{ "type": "text", "text": "hi" }]
        });
        let mut rewriter = ModelRewriter::new("claude-opus-5", false);
        assert!(matches!(
            rewriter.push(body.to_string().as_bytes()),
            Emit::Buffered
        ));
        let out = rewriter.finish();
        let value: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(value["model"], "claude-opus-5");
        assert_eq!(value["content"][0]["text"], "hi", "其余字段不能动");
        assert_eq!(rewriter.outcome(), Some(ModelRewrite::Rewritten));
    }

    #[test]
    fn json_without_model_is_returned_byte_for_byte() {
        let body = br#"{"input_tokens":42}"#;
        let mut rewriter = ModelRewriter::new("m", false);
        rewriter.push(body);
        assert_eq!(rewriter.finish(), body.to_vec());
        assert_eq!(rewriter.outcome(), Some(ModelRewrite::NoModel));
    }

    #[test]
    fn substitution_tolerates_spelling_not_model_changes() {
        // 写法差异：一致。
        assert!(!is_substituted(
            "claude-sonnet-4-20250514",
            &["claude-sonnet-4"]
        ));
        assert!(!is_substituted(
            "claude-sonnet-4-2025-05-14",
            &["claude-sonnet-4"]
        ));
        assert!(!is_substituted(
            "anthropic/claude-sonnet-4",
            &["claude-sonnet-4"]
        ));
        assert!(!is_substituted(
            "claude-sonnet-4-latest",
            &["claude-sonnet-4"]
        ));
        assert!(!is_substituted("Claude-Opus-4-5", &["claude-opus-4.5"]));
        // 型号差异：不一致。
        assert!(is_substituted("gpt-5-mini", &["gpt-5"]));
        assert!(is_substituted("deepseek-chat", &["deepseek-v4.1-flash"]));
        // 空值不能匹配一切。
        assert!(!is_substituted("", &["claude-sonnet-4"]));
        assert!(!is_substituted("claude-sonnet-4", &[""]));
    }
}
