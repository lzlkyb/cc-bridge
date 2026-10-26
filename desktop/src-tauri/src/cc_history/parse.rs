//! CLI 的 jsonl → 我们的 `CcEvent`。
//!
//! ## 🔴 它不是一个「对话转录」，而是一份混合日志
//!
//! 2026-10-24 实测本机 62 个转录（最大 1MB），单个文件里的 `type` 分布：
//!
//! | 类型 | 条数 | 是什么 |
//! |---|---|---|
//! | `user` / `assistant` | 32 / 37 | **真正的对话**，只有这两种要 |
//! | `api-request-blob` / `api-request` | 32 / 35 | 请求原始载荷，**最大的一类噪声** |
//! | `attachment` | 66 | 钩子输出（`hook_success` 的 stdout 动辄几 KB） |
//! | `file-history-snapshot` / `file-history-delta` | 8 / 2 | 文件快照 |
//! | `mode` / `permission-mode` / `atis-latch` | 15 各 | 状态快照 |
//! | `ai-title` / `last-prompt` / `queue-operation` / `agent-name` / `cost-state` / `system/turn_duration` | 少量 | 边角元数据 |
//!
//! 所以这里**必须白名单**。任何「除了 X 都当消息」的写法都会把钩子输出渲染成聊天内容。
//!
//! ## 🔴 `block_id` 用行号，不用 `message.id`
//!
//! 实测同一条 assistant 消息会被**拆成多行**写进 jsonl（同一个 `message.id`
//! 出现 2~5 次，每行一个 content block，带各自的行内 `apiBlockIndex`）。
//! 若照实时流那条路用 `{message_id}:{块下标}`，多行之间会撞车 ——
//! 那正是 2026-10-24 修过的「同一段回复渲染两遍」的同源故障。
//!
//! 行号 + 块下标天然唯一，且对同一份文件是**确定**的（重复打开同一条历史，
//! 生成的 `block_id` 完全一样，前端 reducer 的按 id 合并才不会把内容叠两遍）。
//!
//! ## 🔴 `redacted_thinking` 必须丢
//!
//! 实测它的 `data` 是 5663 字符的加密串（`{"type":"redacted_thinking","data":"..."}`）。
//! 渲染出来是一屏乱码，存进库还白占几十 KB。跳过它只是少一段思考过程，
//! 而正文和工具卡都在。

use std::collections::BTreeMap;

use serde_json::Value;

use crate::cc_session::proto::CcEvent;

/// 单行上限。本机实测最大 171KB，这里留足余量；超过只可能是远端异常文件。
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// 单条工具结果保留多少字符。
///
/// 历史回放只为了「看懂当时发生了什么」，一个 `Bash` 的完整构建日志没有价值，
/// 而它有 100KB 时会把整页消息挤到卡。
const MAX_TOOL_RESULT_CHARS: usize = 16_000;

/// 会话的元信息。列表页只用这个，不碰事件。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Meta {
    pub session_id: String,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub version: Option<String>,
    /// CLI 自己生成的标题（`ai-title` 行）。**实测只有 2/62 的会话有**，
    /// 所以它只是「有就用」的加分项，主来源仍是首条用户消息。
    pub ai_title: Option<String>,
    /// 首条真实用户消息（已剥噪声、截 60 字）。标题的回退来源。
    pub first_user: Option<String>,
    /// 最后一条助手正文（截 120 字）。列表的副标题。
    pub preview: Option<String>,
    /// 用户消息条数。
    pub user_count: i64,
}

impl Meta {
    /// 列表要显示的标题。**不可为空**：空标题的条目在界面上是一个点不动的空白行。
    pub fn title(&self) -> String {
        self.ai_title
            .as_deref()
            .or(self.first_user.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "（没有用户消息）".to_string())
    }
}

/// 逐行吃 jsonl。
///
/// `keep_events=false` 时只采元信息（列表扫描走这条，省掉事件数组的内存与分配）。
pub struct Parser {
    keep_events: bool,
    events: Vec<CcEvent>,
    meta: Meta,
    /// 当前行号，只用来拼 `block_id`。
    line_no: u64,
    /// 最后一条助手正文，`preview` 用。
    last_text: Option<String>,
}

impl Parser {
    pub fn new(keep_events: bool) -> Self {
        Self {
            keep_events,
            events: Vec::new(),
            meta: Meta::default(),
            line_no: 0,
            last_text: None,
        }
    }

    /// 解析整份文本。`session_id` 由调用方从文件名给（比行里的 `sessionId` 稳）。
    pub fn parse_text(text: &str, session_id: &str, keep_events: bool) -> (Meta, Vec<CcEvent>) {
        let mut p = Self::new(keep_events);
        p.meta.session_id = session_id.to_string();
        for line in text.lines() {
            p.feed(line);
        }
        p.finish()
    }

    pub fn feed(&mut self, raw: &str) {
        self.line_no += 1;
        let line = raw.trim();
        if line.is_empty() || line.len() > MAX_LINE_BYTES {
            return;
        }
        let line = line.trim_start_matches('\u{feff}');
        if line.is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            // 坏行静默丢弃：CLI 会往同一个文件里追加，多进程并发时尾部可能是半行。
            return;
        };
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "user" => self.on_user(&value),
            "assistant" => self.on_assistant(&value),
            "ai-title" => {
                if let Some(t) = value
                    .get("aiTitle")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    // 标题会被反复重写，后到的覆盖先到的。
                    self.meta.ai_title = Some(t.to_string());
                }
            }
            _ => {}
        }
    }

    pub fn finish(mut self) -> (Meta, Vec<CcEvent>) {
        self.meta.preview = self.last_text.as_deref().map(|t| truncate(t, 120));
        (self.meta, self.events)
    }

    /// 采「这条会话在哪跑、什么版本」—— 每行都带，取到就走。
    fn note_place(&mut self, value: &Value) {
        if self.meta.cwd.is_none() {
            self.meta.cwd = value
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
        if self.meta.git_branch.is_none() {
            self.meta.git_branch = value
                .get("gitBranch")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
        if self.meta.version.is_none() {
            self.meta.version = value
                .get("version")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
    }

    fn on_user(&mut self, value: &Value) {
        // `isMeta` = CLI 自己注入的上下文（实测有 6 条），不是用户说的话。
        if value
            .get("isMeta")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return;
        }
        // `isSidechain` = 子代理的旁支会话，不属于主对话。
        if value
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return;
        }
        self.note_place(value);
        let Some(content) = value.get("message").and_then(|m| m.get("content")) else {
            return;
        };
        match content {
            // 实测：真人输入是**字符串** + `origin.kind = "human"`。
            Value::String(raw) => self.push_user(raw),
            Value::Array(blocks) => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" => {
                            self.push_user(block.get("text").and_then(Value::as_str).unwrap_or(""))
                        }
                        "tool_result" => self.push_tool_result(block),
                        // `image` 等块不还原：历史里还原图片没有意义，且会让
                        // 回放体积翻几倍。正文里的 `[Image #1]` 占位还在。
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    fn on_assistant(&mut self, value: &Value) {
        if value
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return;
        }
        self.note_place(value);
        let Some(message) = value.get("message") else {
            return;
        };
        let Some(blocks) = message.get("content").and_then(Value::as_array) else {
            return;
        };
        for (i, block) in blocks.iter().enumerate() {
            let block_id = format!("h{}:{}", self.line_no, i);
            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                    let flat = flatten(text);
                    if flat.is_empty() {
                        continue;
                    }
                    self.last_text = Some(flat);
                    self.push(CcEvent::Text {
                        block_id,
                        text: text.to_string(),
                        streaming: false,
                    });
                }
                "thinking" => {
                    let text = block.get("thinking").and_then(Value::as_str).unwrap_or("");
                    if text.trim().is_empty() {
                        continue;
                    }
                    self.push(CcEvent::Thinking {
                        block_id,
                        text: text.to_string(),
                        streaming: false,
                    });
                }
                // 加密思维链：`data` 是几千字符的密文，渲染出来是乱码。见模块文档。
                "redacted_thinking" => {}
                "tool_use" => {
                    let tool_use_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    // 没有 id 的结果无法回连到调用，收进来只会是一张永远转圈的卡。
                    let Some(tool_use_id) = tool_use_id else {
                        continue;
                    };
                    self.push(CcEvent::ToolUse {
                        tool_use_id: tool_use_id.to_string(),
                        name: block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        input: block.get("input").cloned().unwrap_or(Value::Null),
                    });
                }
                _ => {}
            }
        }
    }

    fn push_tool_result(&mut self, block: &Value) {
        let Some(tool_use_id) = block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            // 实测确实存在不带 `tool_use_id` 的 tool_result（内容是
            // `Launching skill: …` 这类内部元数据）。没有 id 就挂不到调用点上，
            // 前端 reducer 会把它丢掉 —— 与其留个孤儿，不如这里就丢。
            return;
        };
        let content = crate::cc_session::proto::flatten_content(block.get("content"));
        self.push(CcEvent::ToolResult {
            tool_use_id: tool_use_id.to_string(),
            content: truncate(&content, MAX_TOOL_RESULT_CHARS),
            is_error: block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            // 历史转录里没有实时计时，也就没有工具耗时（`parse.rs` 走的是
            // 落盘的 JSONL，不是活着的流）。`None` = 卡片不显示耗时。
            duration_ms: None,
        });
    }

    fn push_user(&mut self, raw: &str) {
        let Some(text) = clean_user_text(raw) else {
            return;
        };
        self.meta.user_count += 1;
        if self.meta.first_user.is_none() {
            self.meta.first_user = Some(truncate(&flatten(&text), 60));
        }
        // 🔴 `images: vec![]` 是**故意的**：这条路径是从 CLI 的转录文件恢复，
        //    里面能拿到的只有原图 base64（几十上百 KB 到几 MB），既不该塞进我们
        //    的流水，也没有办法在 Rust 侧缩略化（要引图像解码依赖）。
        //    所以「从 CLI 转录恢复」的会话看不到历史图片 —— 与我们自己落盘的
        //    流水（`CcEvent::UserMessage.images`）不是同一条路，界面上也不必区分。
        self.push(CcEvent::UserMessage {
            text,
            images: Vec::new(),
        });
    }

    fn push(&mut self, event: CcEvent) {
        if self.keep_events {
            self.events.push(event);
        }
    }
}

/// 判断一条「用户文本」到底是不是用户打的。
///
/// 实测存在的非对话文本：
/// - `<command-name>/clear</command-name>` 一类斜杠命令记录
/// - `<local-command-stdout>…</local-command-stdout>` 本地命令输出
/// - `[Request interrupted by user]` —— **这条要留**：它就是用户按下 Esc 的事实
fn clean_user_text(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    for noise in [
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<command-name>",
        "<command-message>",
        "<command-args>",
    ] {
        if text.starts_with(noise) {
            return None;
        }
    }
    Some(text.to_string())
}

/// 压平换行，用于标题与预览。
fn flatten(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 按**字符**截断。按字节切会把中文切成半个，落进 SQLite 是乱码。
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 把事件按「会话轮次」折叠，给列表用。
///
/// 第一版不做轮次折叠（界面是连续消息流），留着是因为搜索与「跳到某一轮」
/// 都要它 —— 但那是期三的事，现在不实现以免变成死代码。
#[allow(dead_code)]
pub fn group_turns(events: &[CcEvent]) -> BTreeMap<u64, u64> {
    let mut out = BTreeMap::new();
    for (i, e) in events.iter().enumerate() {
        if matches!(e, CcEvent::UserMessage { .. }) {
            out.insert(out.len() as u64, i as u64);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(lines: &[&str]) -> (Meta, Vec<CcEvent>) {
        Parser::parse_text(&lines.join("\n"), "sess-1", true)
    }

    /// 真人输入是字符串 content，必须变成 `UserMessage`。
    #[test]
    fn plain_string_user_becomes_user_message() {
        let (meta, events) = parse(&[
            r#"{"type":"user","message":{"content":"帮我看看构建为什么红了"},"cwd":"D:\\proj","timestamp":"2026-10-20T07:36:44.976Z"}"#,
        ]);
        assert_eq!(
            events,
            vec![CcEvent::UserMessage {
                text: "帮我看看构建为什么红了".into(),
                images: Vec::new(),
            }]
        );
        assert_eq!(meta.user_count, 1);
        assert_eq!(meta.cwd.as_deref(), Some("D:\\proj"));
        assert_eq!(meta.title(), "帮我看看构建为什么红了");
    }

    /// 🔴 实测：`isMeta: true` 的 user 行是 CLI 注入的上下文（6/32 条），
    /// 当消息渲染出来会是一段莫名其妙的系统提示。
    #[test]
    fn meta_user_is_skipped() {
        let (meta, events) = parse(&[
            r#"{"type":"user","isMeta":true,"message":{"content":[{"type":"text","text":"<EXTREMELY_IMPORTANT>你有超能力…"}]}}"#,
        ]);
        assert!(events.is_empty(), "{events:?}");
        assert_eq!(meta.user_count, 0);
    }

    /// 🔴 实测：钩子输出是同一个文件里的 `attachment` 行（66 条/文件），
    /// 里面的 stdout 动辄几 KB。白名单不认它，绝不能漏进来。
    #[test]
    fn hook_attachment_never_becomes_a_message() {
        let (_meta, events) = parse(&[
            r#"{"type":"attachment","attachment":{"type":"hook_success","hookName":"SessionStart:startup","stdout":"{\"hookSpecificOutput\":{\"additionalContext\":\"你是超能力者…\"}}"}}"#,
            r#"{"type":"api-request-blob","data":"AAAA…"}"#,
            r#"{"type":"file-history-snapshot","snapshot":{}}"#,
            r#"{"type":"mode","mode":"default"}"#,
        ]);
        assert!(events.is_empty(), "噪声行一条都不能进：{events:?}");
    }

    /// 🔴 实测：同一条 assistant 消息被拆成多行写进 jsonl（同 `message.id` 出现 2~5 次）。
    /// 用 `{msg_id}:{块下标}` 拼 block_id 会让多行互相覆盖 —— 界面上文字重复或丢失。
    /// 行号参与后天然唯一。
    #[test]
    fn split_assistant_lines_get_distinct_block_ids() {
        let (_meta, events) = parse(&[
            r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"thinking","thinking":"先看看"}]}}"#,
            r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"构建红了"}]}}"#,
            r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
        ]);
        let ids: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                CcEvent::Text { block_id, .. } | CcEvent::Thinking { block_id, .. } => {
                    Some(block_id.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1], "同一条消息的多行必须拿到不同 block_id");
    }

    /// 🔴 实测：`redacted_thinking` 的 `data` 是 5663 字符密文。渲染是乱码。
    #[test]
    fn redacted_thinking_is_dropped() {
        let (_meta, events) = parse(&[
            r#"{"type":"assistant","message":{"id":"m","content":[{"type":"redacted_thinking","data":"EqQBCkYI…long-cipher"}]}}"#,
        ]);
        assert!(events.is_empty(), "{events:?}");
    }

    /// tool_use 与 tool_result 要按 id 配成一对，否则前端卡片是空的。
    #[test]
    fn tool_use_and_result_pair_up() {
        let (_meta, events) = parse(&[
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"a.ts"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"第一行"},{"type":"image"}],"is_error":true}]}}"#,
        ]);
        assert_eq!(events.len(), 2);
        match &events[1] {
            CcEvent::ToolResult {
                tool_use_id,
                content,
                is_error,
                duration_ms,
            } => {
                assert_eq!(tool_use_id, "call_1");
                assert_eq!(content, "第一行\n[image]");
                assert!(is_error);
                // 历史转录不测速：没有实时计时源。
                assert_eq!(*duration_ms, None);
            }
            other => panic!("期望 ToolResult，实际 {other:?}"),
        }
    }

    /// 没有 `tool_use_id` 的 tool_result 挂不到任何调用点，丢掉。
    #[test]
    fn orphan_tool_result_is_dropped() {
        let (_meta, events) = parse(&[
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"Launching skill: x"}]}}"#,
        ]);
        assert!(events.is_empty(), "{events:?}");
    }

    /// 超长工具结果要截断，否则一个构建日志就能把整页挤爆。
    #[test]
    fn huge_tool_result_is_truncated() {
        let big = "x".repeat(50_000);
        let line = json!({
            "type": "user",
            "message": {"content": [{"type": "tool_result", "tool_use_id": "t", "content": big}]}
        })
        .to_string();
        let (_meta, events) = parse(&[&line]);
        match &events[0] {
            CcEvent::ToolResult { content, .. } => {
                assert!(content.chars().count() <= MAX_TOOL_RESULT_CHARS + 1);
            }
            other => panic!("期望 ToolResult，实际 {other:?}"),
        }
    }

    /// 斜杠命令与本地命令输出不是用户说的话。
    #[test]
    fn slash_command_noise_is_skipped() {
        let (_meta, events) = parse(&[
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","message":{"content":"<local-command-stdout>ok</local-command-stdout>"}}"#,
        ]);
        assert!(events.is_empty(), "{events:?}");
    }

    /// `[Request interrupted by user]` 是用户按了 Esc 的事实，要留。
    #[test]
    fn interrupt_marker_is_kept() {
        let (_meta, events) = parse(&[
            r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
        ]);
        assert_eq!(
            events,
            vec![CcEvent::UserMessage {
                text: "[Request interrupted by user]".into(),
                images: Vec::new(),
            }]
        );
    }

    /// `ai-title` 优先当标题；没有它才回退到首条用户消息（实测只 2/62 有）。
    #[test]
    fn ai_title_wins_over_first_message() {
        let (meta, _) = parse(&[
            r#"{"type":"user","message":{"content":"第一个问题"}}"#,
            r#"{"type":"ai-title","aiTitle":"Three.js 雨夜日式便利店"}"#,
        ]);
        assert_eq!(meta.title(), "Three.js 雨夜日式便利店");
        assert_eq!(meta.first_user.as_deref(), Some("第一个问题"));
    }

    /// 没有标题的会话（61/62 都是）必须回退到首条用户消息，不能是空白行。
    #[test]
    fn missing_title_falls_back_to_first_message() {
        let (meta, _) = parse(&[r#"{"type":"user","message":{"content":"帮我修构建"}}"#]);
        assert_eq!(meta.title(), "帮我修构建");
    }

    /// 一个字的用户消息都没有时给一句占位，而不是空串。
    #[test]
    fn empty_session_still_has_a_title() {
        let (meta, events) = parse(&[r#"{"type":"mode","mode":"plan"}"#]);
        assert!(events.is_empty());
        assert_eq!(meta.title(), "（没有用户消息）");
    }

    /// 坏行（半截 JSON、空行、超长行）不能掀翻整份解析。
    #[test]
    fn junk_lines_are_skipped() {
        let huge = format!(
            r#"{{"type":"user","message":{{"content":"{}"}}}}"#,
            "x".repeat(MAX_LINE_BYTES + 10)
        );
        let (_meta, events) = parse(&[
            "",
            "   ",
            "not json",
            r#"{"type":"user","message":{"content":"#,
            &huge,
            r#"{"type":"user","message":{"content":"真话"}}"#,
        ]);
        assert_eq!(
            events,
            vec![CcEvent::UserMessage {
                text: "真话".into(),
                images: Vec::new(),
            }],
            "只有最后一条合法且不超限"
        );
    }

    /// 子代理侧链不属于主对话。
    #[test]
    fn sidechain_is_skipped() {
        let (_meta, events) = parse(&[
            r#"{"type":"user","isSidechain":true,"message":{"content":"子代理的输入"}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"id":"m","content":[{"type":"text","text":"子代理的输出"}]}}"#,
        ]);
        assert!(events.is_empty(), "{events:?}");
    }

    /// 不保留事件时（列表扫描）事件数组必须是空的，元信息照旧。
    #[test]
    fn meta_only_mode_collects_no_events() {
        let text = r#"{"type":"user","message":{"content":"标题"}}"#;
        let (meta, events) = Parser::parse_text(text, "s", false);
        assert!(events.is_empty());
        assert_eq!(meta.title(), "标题");
        assert_eq!(meta.user_count, 1);
    }

    /// 中文标题按字符截断，不能按字节。
    #[test]
    fn title_truncates_by_chars() {
        let long = "中".repeat(200);
        let line = json!({"type": "user", "message": {"content": long}}).to_string();
        let (meta, _) = parse(&[&line]);
        let title = meta.title();
        assert_eq!(title.chars().count(), 61, "60 字 + 省略号");
    }
}
