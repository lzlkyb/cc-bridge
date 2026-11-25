//! OpenAI 流式 chunk → Anthropic SSE 事件序列。
//!
//! 这一层决定「能不能用」：Claude Code 只会按 Anthropic 的事件逐条消费，
//! 少一条 `message_start` 或 block index 跳号，工具调用就会卡死。
//!
//! 四个必须处理的坑（都在测试里钉着）：
//!
//! 1. **`tool_calls` 是分片的**：首片只有 `id` 与 `name`，后续片只有
//!    `arguments` 片段，靠 `index` 聚合。
//! 2. **block index 必须严格递增**：文本块与工具块各占一个，关闭后才开下一个。
//! 3. **空 delta 要跳过**：只有 `role` 的 chunk 若照发，会多出一个空 text block。
//! 4. **`usage` 可能不来**：请求时已加 `stream_options.include_usage`，仍不来就
//!    按 0 报，界面标「仅包含已收到字段」。
//!
//! 输入缓冲用 `Vec<u8>` 而不是 `String`：一个 UTF-8 汉字可能被切成两个 chunk，
//! 先转字符串会把它变成两个替换字符，中文回复里就会出现连续的「�」。

use std::collections::HashMap;

use serde_json::{json, Value};

/// 一次流式转换的状态机。**按请求新建**，不要复用。
pub struct Translator {
    buffer: Vec<u8>,
    model: String,
    started: bool,
    /// 下一个可用的 content block index。
    next_index: usize,
    /// 当前打开的文本块。`None` = 没有开着的文本块。
    ///
    /// 工具块**不**放在这里：OpenAI 的并行工具调用会把多个 call 的分片交错发来，
    /// 用单个 `Option` 表达「当前块」就必然写出「关掉 A、重开 A」这种非法事件
    /// （同一 index 两次 `content_block_start`）。工具块的进度只记在
    /// [`Self::tool_blocks`] 与 [`Self::pending_tools`] 里。
    open_text: Option<usize>,
    /// OpenAI 的 `tool_calls[].index` → 我们分配的 block index。
    tool_blocks: HashMap<u64, usize>,
    /// 已 start、尚未 stop 的工具块，按分配顺序（即 block index 升序）。
    pending_tools: Vec<usize>,
    stop_reason: &'static str,
    input_tokens: u64,
    output_tokens: u64,
    /// 上游自报的模型名。只进日志，不进响应——响应里填的是客户端请求的名字。
    reported_model: Option<String>,
    done: bool,
}

impl Translator {
    pub fn new(model: &str) -> Self {
        Self {
            buffer: Vec::new(),
            model: model.to_string(),
            started: false,
            next_index: 0,
            open_text: None,
            tool_blocks: HashMap::new(),
            pending_tools: Vec::new(),
            stop_reason: "end_turn",
            input_tokens: 0,
            output_tokens: 0,
            reported_model: None,
            done: false,
        }
    }

    /// 喂一块上游字节，返回要写给客户端的 Anthropic SSE 字节（可能为空）。
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.done {
            return Vec::new();
        }
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some((index, sep)) = find_boundary(&self.buffer) {
            let event: Vec<u8> = self.buffer.drain(..index + sep).collect();
            self.handle_event(&event, &mut out);
            if self.done {
                break;
            }
        }
        out
    }

    /// 上游流结束（或被判定为结束）时收尾。幂等。
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        self.finish_into(&mut out);
        out
    }

    /// 已收集到的 (输入, 输出) token。上游没回就是 0——宁可少报，不要编一个数。
    pub fn usage(&self) -> (u64, u64) {
        (self.input_tokens, self.output_tokens)
    }

    /// 上游在 chunk 里报的模型名。给日志用——客户端收到的是请求名。
    pub fn reported_model(&self) -> Option<&str> {
        self.reported_model.as_deref()
    }

    fn handle_event(&mut self, event: &[u8], out: &mut Vec<u8>) {
        let text = String::from_utf8_lossy(event);
        let mut data = String::new();
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                data.push_str(rest.trim_start());
            }
        }
        if data.is_empty() {
            return;
        }
        if data.trim() == "[DONE]" {
            self.finish_into(out);
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            // 半截 JSON / 上游的自定义心跳：丢掉，不打断整条流。
            return;
        };
        self.handle_chunk(&value, out);
    }

    fn handle_chunk(&mut self, value: &Value, out: &mut Vec<u8>) {
        self.ensure_started(out);

        // 上游每个 chunk 都可能带 model。记第一次见到的就够——同一个流里它不会变。
        if self.reported_model.is_none() {
            if let Some(model) = value.get("model").and_then(Value::as_str) {
                self.reported_model = Some(model.to_string());
            }
        }

        if let Some(usage) = value.get("usage").filter(|u| !u.is_null()) {
            if let Some(n) = usage.get("prompt_tokens").and_then(Value::as_u64) {
                self.input_tokens = n;
            }
            if let Some(n) = usage.get("completion_tokens").and_then(Value::as_u64) {
                self.output_tokens = n;
            }
        }

        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|c| c.first())
        else {
            return;
        };

        if let Some(delta) = choice.get("delta") {
            // 文本。空串跳过——否则会多开一个空 block。
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                if !text.is_empty() {
                    let index = self.ensure_text_block(out);
                    emit(
                        out,
                        "content_block_delta",
                        json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "text_delta", "text": text }
                        }),
                    );
                }
            }

            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    self.handle_tool_delta(call, out);
                }
            }
        }

        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.stop_reason = match reason {
                "length" => "max_tokens",
                "tool_calls" => "tool_use",
                _ => "end_turn",
            };
        }
    }

    fn ensure_started(&mut self, out: &mut Vec<u8>) {
        if self.started {
            return;
        }
        self.started = true;
        emit(
            out,
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": "msg_relay",
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": Value::Null,
                    "stop_sequence": Value::Null,
                    "usage": { "input_tokens": 0, "output_tokens": 0 }
                }
            }),
        );
    }

    fn ensure_text_block(&mut self, out: &mut Vec<u8>) -> usize {
        if let Some(index) = self.open_text {
            return index;
        }
        // 文本来在工具块之后：先把工具块收掉，再开新块（Anthropic 的文本块
        // 不会跨在工具块中间）。
        self.close_tools(out);
        let index = self.next_index;
        self.next_index += 1;
        emit(
            out,
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": index,
                "content_block": { "type": "text", "text": "" }
            }),
        );
        self.open_text = Some(index);
        index
    }

    /// 处理一个 `tool_calls[]` 分片。
    ///
    /// **每个 call 恰好一次 `content_block_start`、一次 `content_block_stop`。**
    /// 并行调用时上游把两个 call 的参数分片交错发来（`0,1,0,1`），这里按
    /// `tool_blocks` 各记各的 index 与参数，不关别人的块——早先的写法在「换一个
    /// call」时关掉当前块再重开同一 index，既是非法事件，又把交错来的参数整段丢弃。
    fn handle_tool_delta(&mut self, call: &Value, out: &mut Vec<u8>) {
        let call_index = call.get("index").and_then(Value::as_u64).unwrap_or(0);

        // 文本块与工具块不共存：来工具就先收文本。
        self.close_text(out);

        let block = match self.tool_blocks.get(&call_index) {
            Some(&block) => block,
            None => {
                let block = self.next_index;
                self.next_index += 1;
                self.tool_blocks.insert(call_index, block);
                self.pending_tools.push(block);
                emit(
                    out,
                    "content_block_start",
                    json!({
                        "type": "content_block_start",
                        "index": block,
                        "content_block": {
                            "type": "tool_use",
                            "id": call
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            "name": call
                                .get("function")
                                .and_then(|f| f.get("name"))
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            "input": {}
                        }
                    }),
                );
                block
            }
        };

        // 参数增量：按**这个 call 自己的** block index 发，与其它块是否开着无关。
        if let Some(args) = call
            .get("function")
            .and_then(|f| f.get("arguments"))
            .and_then(Value::as_str)
        {
            if !args.is_empty() {
                emit(
                    out,
                    "content_block_delta",
                    json!({
                        "type": "content_block_delta",
                        "index": block,
                        "delta": { "type": "input_json_delta", "partial_json": args }
                    }),
                );
            }
        }
    }

    fn close_text(&mut self, out: &mut Vec<u8>) {
        if let Some(index) = self.open_text.take() {
            emit(
                out,
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": index }),
            );
        }
    }

    /// 关掉所有还开着的工具块，按分配顺序（index 升序）。
    fn close_tools(&mut self, out: &mut Vec<u8>) {
        for index in std::mem::take(&mut self.pending_tools) {
            emit(
                out,
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": index }),
            );
        }
    }

    fn finish_into(&mut self, out: &mut Vec<u8>) {
        if self.done {
            return;
        }
        self.done = true;
        self.ensure_started(out);
        self.close_text(out);
        self.close_tools(out);
        emit(
            out,
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": self.stop_reason, "stop_sequence": Value::Null },
                "usage": {
                    "input_tokens": self.input_tokens,
                    "output_tokens": self.output_tokens
                }
            }),
        );
        emit(out, "message_stop", json!({ "type": "message_stop" }));
    }
}

fn emit(out: &mut Vec<u8>, event: &str, data: Value) {
    out.extend_from_slice(format!("event: {event}\ndata: {data}\n\n").as_bytes());
}

/// 找 SSE 事件边界。返回（事件内容长度，分隔符长度）。
///
/// 同时认 `\n\n` 与 `\r\n\r\n`：有的网关用 CRLF，只认前者会让整个流卡在缓冲里
/// 直到结束才一次性吐出。
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 把输出拆成 (event 名, data JSON)。
    fn events(bytes: &[u8]) -> Vec<(String, Value)> {
        let text = String::from_utf8(bytes.to_vec()).expect("必须是 UTF-8");
        text.split("\n\n")
            .filter(|block| !block.trim().is_empty())
            .map(|block| {
                let mut name = String::new();
                let mut data = String::new();
                for line in block.lines() {
                    if let Some(rest) = line.strip_prefix("event:") {
                        name = rest.trim().to_string();
                    } else if let Some(rest) = line.strip_prefix("data:") {
                        data.push_str(rest.trim());
                    }
                }
                (name, serde_json::from_str(&data).expect("data 必须是 JSON"))
            })
            .collect()
    }

    fn chunk(delta: Value, finish: Option<&str>) -> String {
        format!(
            "data: {}\n\n",
            json!({
                "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }]
            })
        )
    }

    #[test]
    fn text_stream_produces_anthropic_events() {
        let mut t = Translator::new("gpt-x");
        let mut out = Vec::new();
        out.extend(t.push(chunk(json!({ "role": "assistant" }), None).as_bytes()));
        out.extend(t.push(chunk(json!({ "content": "你" }), None).as_bytes()));
        out.extend(t.push(chunk(json!({ "content": "好" }), None).as_bytes()));
        out.extend(t.push(chunk(json!({}), Some("stop")).as_bytes()));
        out.extend(t.push(b"data: [DONE]\n\n"));

        let evs = events(&out);
        let names: Vec<&str> = evs.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop"
            ]
        );
        // 空 delta 不该额外开块
        assert_eq!(evs[1].1["content_block"]["type"], "text");
        assert_eq!(evs[2].1["delta"]["text"], "你");
        assert_eq!(evs[3].1["delta"]["text"], "好");
        assert_eq!(evs[5].1["delta"]["stop_reason"], "end_turn");
    }

    /// 分片的 tool_calls：首片带 id/name，后续片只有 arguments 片段。
    #[test]
    fn fragmented_tool_calls_merge_into_one_block() {
        let mut t = Translator::new("m");
        let mut out = Vec::new();
        out.extend(
            t.push(
                chunk(
                    json!({ "tool_calls": [{
                        "index": 0, "id": "call_1", "type": "function",
                        "function": { "name": "search", "arguments": "" }
                    }]}),
                    None,
                )
                .as_bytes(),
            ),
        );
        out.extend(
            t.push(
                chunk(
                    json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "{\"q\":" } }] }),
                    None,
                )
                .as_bytes(),
            ),
        );
        out.extend(
            t.push(
                chunk(
                    json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "\"rust\"}" } }] }),
                    Some("tool_calls"),
                )
                .as_bytes(),
            ),
        );
        out.extend(t.finish());

        let evs = events(&out);
        let start = evs
            .iter()
            .find(|(n, d)| n == "content_block_start" && d["content_block"]["type"] == "tool_use")
            .expect("应有 tool_use 块");
        assert_eq!(start.1["content_block"]["id"], "call_1");
        assert_eq!(start.1["content_block"]["name"], "search");

        let partial: String = evs
            .iter()
            .filter(|(n, d)| n == "content_block_delta" && d["delta"]["type"] == "input_json_delta")
            .map(|(_, d)| {
                d["delta"]["partial_json"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect();
        let parsed: Value = serde_json::from_str(&partial).expect("拼起来应是合法 JSON");
        assert_eq!(parsed, json!({ "q": "rust" }));

        let stop = evs
            .iter()
            .find(|(n, _)| n == "message_delta")
            .expect("应有 message_delta");
        assert_eq!(stop.1["delta"]["stop_reason"], "tool_use");
    }

    /// 文本 + 工具混排：块 index 必须严格递增，不能复用文本块的 index。
    #[test]
    fn text_then_tool_uses_increasing_block_indexes() {
        let mut t = Translator::new("m");
        let mut out = Vec::new();
        out.extend(t.push(chunk(json!({ "content": "先查一下" }), None).as_bytes()));
        out.extend(
            t.push(
                chunk(
                    json!({ "tool_calls": [{ "index": 0, "id": "c1", "function": { "name": "f", "arguments": "{}" } }] }),
                    Some("tool_calls"),
                )
                .as_bytes(),
            ),
        );
        out.extend(t.finish());

        let starts: Vec<u64> = events(&out)
            .iter()
            .filter(|(n, _)| n == "content_block_start")
            .map(|(_, d)| d["index"].as_u64().unwrap())
            .collect();
        assert_eq!(starts, vec![0, 1]);
    }

    /// 一个汉字被切成两个 chunk：不能让替换字符混进回复。
    #[test]
    fn split_multibyte_character_survives() {
        let payload = chunk(json!({ "content": "中文" }), None);
        let bytes = payload.as_bytes();
        let cut = payload.find('中').unwrap() + 1; // 切在三字节字符中间
        let mut t = Translator::new("m");
        let mut out = Vec::new();
        out.extend(t.push(&bytes[..cut]));
        out.extend(t.push(&bytes[cut..]));
        out.extend(t.finish());

        let text: String = events(&out)
            .iter()
            .filter(|(n, _)| n == "content_block_delta")
            .map(|(_, d)| d["delta"]["text"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(text, "中文");
        assert!(!text.contains('\u{FFFD}'));
    }

    #[test]
    fn usage_is_carried_into_message_delta() {
        let mut t = Translator::new("m");
        let mut out = Vec::new();
        out.extend(t.push(chunk(json!({ "content": "x" }), None).as_bytes()));
        out.extend(
            t.push(
                format!(
                    "data: {}\n\n",
                    json!({ "choices": [], "usage": { "prompt_tokens": 11, "completion_tokens": 4 } })
                )
                .as_bytes(),
            ),
        );
        out.extend(t.push(b"data: [DONE]\n\n"));
        let delta = events(&out)
            .into_iter()
            .find(|(n, _)| n == "message_delta")
            .unwrap()
            .1;
        assert_eq!(delta["usage"]["input_tokens"], 11);
        assert_eq!(delta["usage"]["output_tokens"], 4);
    }

    /// 上游只回一个 [DONE]，也得给出完整骨架，否则客户端会一直等。
    #[test]
    fn empty_stream_still_closes() {
        let mut t = Translator::new("m");
        let out = t.push(b"data: [DONE]\n\n");
        let names: Vec<String> = events(&out).into_iter().map(|(n, _)| n).collect();
        assert_eq!(
            names,
            vec!["message_start", "message_delta", "message_stop"]
        );
    }

    #[test]
    fn crlf_boundaries_are_recognized() {
        let mut t = Translator::new("m");
        let payload = "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\r\n\r\n";
        let out = t.push(payload.as_bytes());
        assert!(String::from_utf8_lossy(&out).contains("text_delta"));
    }

    /// 并行工具调用：两个 call 的分片**交错**发来（`0,1,0,1`）。
    ///
    /// 三件事同时钉住：每个 index 只 start 一次（重开是非法的）、交错来的参数
    /// 一个字节都不能丢、每块恰好一次 stop。早期实现把「换 call」当成「关块再
    /// 重开同一 index」，既发非法事件又把后到的参数整段丢掉。
    #[test]
    fn interleaved_tool_calls_keep_one_start_per_block() {
        let mut t = Translator::new("m");
        let mut out = Vec::new();
        out.extend(
            t.push(
                chunk(
                    json!({ "tool_calls": [{ "index": 0, "id": "c0",
                        "function": { "name": "A", "arguments": "{\"x\":" } }] }),
                    None,
                )
                .as_bytes(),
            ),
        );
        out.extend(
            t.push(
                chunk(
                    json!({ "tool_calls": [{ "index": 1, "id": "c1",
                        "function": { "name": "B", "arguments": "{\"y\":" } }] }),
                    None,
                )
                .as_bytes(),
            ),
        );
        // 交错回到 call 0 / call 1 的尾片
        out.extend(
            t.push(
                chunk(
                    json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "1}" } }] }),
                    None,
                )
                .as_bytes(),
            ),
        );
        out.extend(
            t.push(
                chunk(
                    json!({ "tool_calls": [{ "index": 1, "function": { "arguments": "2}" } }] }),
                    None,
                )
                .as_bytes(),
            ),
        );
        out.extend(t.push(chunk(json!({}), Some("tool_calls")).as_bytes()));
        out.extend(t.finish());

        let evs = events(&out);
        let starts: Vec<(u64, String)> = evs
            .iter()
            .filter(|(n, _)| n == "content_block_start")
            .map(|(_, d)| {
                (
                    d["index"].as_u64().unwrap(),
                    d["content_block"]["name"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                )
            })
            .collect();
        assert_eq!(
            starts,
            vec![(0, "A".into()), (1, "B".into())],
            "每块只 start 一次"
        );

        for (index, expected) in [(0u64, json!({ "x": 1 })), (1, json!({ "y": 2 }))] {
            let partial: String = evs
                .iter()
                .filter(|(n, d)| n == "content_block_delta" && d["index"].as_u64() == Some(index))
                .map(|(_, d)| {
                    d["delta"]["partial_json"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string()
                })
                .collect();
            assert_eq!(
                serde_json::from_str::<Value>(&partial).expect("参数应能拼成合法 JSON"),
                expected,
                "block {index} 的参数被丢了"
            );
        }

        let stops: Vec<u64> = evs
            .iter()
            .filter(|(n, _)| n == "content_block_stop")
            .map(|(_, d)| d["index"].as_u64().unwrap())
            .collect();
        assert_eq!(stops, vec![0, 1], "每块恰好一次 stop");
    }

    /// 文本 → 工具 → 文本：第三个块必须是新 index，且前两个块都已关闭。
    #[test]
    fn text_after_tool_opens_a_new_block() {
        let mut t = Translator::new("m");
        let mut out = Vec::new();
        out.extend(t.push(chunk(json!({ "content": "先查" }), None).as_bytes()));
        out.extend(
            t.push(
                chunk(
                    json!({ "tool_calls": [{ "index": 0, "id": "c0",
                        "function": { "name": "f", "arguments": "{}" } }] }),
                    None,
                )
                .as_bytes(),
            ),
        );
        out.extend(t.push(chunk(json!({ "content": "再补一句" }), None).as_bytes()));
        out.extend(t.finish());

        let evs = events(&out);
        let starts: Vec<u64> = evs
            .iter()
            .filter(|(n, _)| n == "content_block_start")
            .map(|(_, d)| d["index"].as_u64().unwrap())
            .collect();
        assert_eq!(starts, vec![0, 1, 2]);
        let stops: Vec<u64> = evs
            .iter()
            .filter(|(n, _)| n == "content_block_stop")
            .map(|(_, d)| d["index"].as_u64().unwrap())
            .collect();
        assert_eq!(stops, vec![0, 1, 2], "index 顺序必须与 start 一致");
    }

    #[test]
    fn finish_is_idempotent() {
        let mut t = Translator::new("m");
        let _ = t.push(b"data: [DONE]\n\n");
        assert!(t.finish().is_empty(), "第二次收尾不该再发事件");
    }
}
