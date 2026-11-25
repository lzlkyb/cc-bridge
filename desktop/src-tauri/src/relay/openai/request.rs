//! Anthropic Messages → OpenAI Chat Completions。
//!
//! 两家的结构差得最远的一处是**工具结果的位置**：Anthropic 把 `tool_result` 塞在
//! `user` 消息的 content 数组里，OpenAI 要求它是独立的 `{role:"tool"}` 消息。
//! 一条 user 消息里同时有文本和多个工具结果时，顺序必须保持不变（文本 → 工具结果
//! → 后续文本），否则模型会读到错误的时间线。
//!
//! 另一处是 `arguments`：Anthropic 的 `input` 是**对象**，OpenAI 要的是**JSON 字符串**。
//! 忘了 `to_string` 会得到 `arguments: {...}`，多数上游会静默当成空参数。
//!
//! 其余都是平移：`system` 变首条消息、`tools[].input_schema` 变 `parameters`、
//! `tool_choice: any` 变 `required`、`stop_sequences` 变 `stop`。
//!
//! `cache_control` 一律丢弃：OpenAI 侧没有对应物，留着会被严格网关拒。

use serde_json::{json, Map, Value};

/// 转换一份 Anthropic 请求体。返回 OpenAI chat/completions 的 body。
pub fn convert(body: &Value) -> Result<Value, String> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "请求体缺少 messages 数组。".to_string())?;

    let mut out = Map::new();
    out.insert(
        "model".into(),
        body.get("model").cloned().unwrap_or(Value::Null),
    );

    let mut converted: Vec<Value> = Vec::new();
    if let Some(system) = body.get("system").and_then(system_text) {
        converted.push(json!({ "role": "system", "content": system }));
    }
    for message in messages {
        convert_message(message, &mut converted);
    }
    out.insert("messages".into(), Value::Array(converted));

    // ── 直接平移的字段 ────────────────────────────────────────────────
    // `max_tokens` 与 `max_completion_tokens` 二选一：o 系 / gpt-5 只认后者，
    // 同时发两个会被当成未知参数拒掉。自愈（repair）改名后从这里透传。
    if body.get("max_completion_tokens").is_some() {
        copy(body, &mut out, "max_completion_tokens");
    } else {
        copy(body, &mut out, "max_tokens");
    }
    copy(body, &mut out, "temperature");
    copy(body, &mut out, "top_p");
    if let Some(stop) = body.get("stop_sequences").cloned() {
        out.insert("stop".into(), stop);
    }

    // ── 工具 ──────────────────────────────────────────────────────────
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let converted: Vec<Value> = tools
            .iter()
            .filter_map(|tool| {
                let name = tool.get("name").and_then(Value::as_str)?;
                let mut function = Map::new();
                function.insert("name".into(), Value::String(name.to_string()));
                if let Some(desc) = tool.get("description").and_then(Value::as_str) {
                    function.insert("description".into(), Value::String(desc.to_string()));
                }
                // 没有 schema 也要给一个合法的空对象 schema，否则上游会拒。
                let parameters = tool
                    .get("input_schema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
                function.insert("parameters".into(), parameters);
                Some(json!({ "type": "function", "function": function }))
            })
            .collect();
        if !converted.is_empty() {
            out.insert("tools".into(), Value::Array(converted));
        }
    }
    if let Some(choice) = body.get("tool_choice").and_then(convert_tool_choice) {
        out.insert("tool_choice".into(), choice);
    }

    // ── 流式 ──────────────────────────────────────────────────────────
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    if stream {
        out.insert("stream".into(), Value::Bool(true));
        // 不带这个，OpenAI 在流里不回 usage，中转的用量统计会一直是空的。
        out.insert("stream_options".into(), json!({ "include_usage": true }));
    }

    // thinking / cache_control / metadata 等不进 OpenAI：没有对应字段，
    // 带过去只会被严格网关拒（profile 里的 `thinking: Strip` 与此一致）。
    Ok(Value::Object(out))
}

fn copy(from: &Value, to: &mut Map<String, Value>, key: &str) {
    if let Some(value) = from.get(key) {
        to.insert(key.to_string(), value.clone());
    }
}

/// `system` 可能是字符串，也可能是 block 数组。
fn system_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => (!text.trim().is_empty()).then(|| text.clone()),
        Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n\n"))
        }
        _ => None,
    }
}

/// 一条 Anthropic 消息 → 零到多条 OpenAI 消息。
fn convert_message(message: &Value, out: &mut Vec<Value>) {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("user");

    let Some(content) = message.get("content") else {
        return;
    };
    // 字符串形态：直接平移。
    if let Some(text) = content.as_str() {
        out.push(json!({ "role": role, "content": text }));
        return;
    }
    let Some(blocks) = content.as_array() else {
        return;
    };

    if role == "assistant" {
        convert_assistant(blocks, out);
    } else {
        convert_user(blocks, out);
    }
}

/// assistant：文本进 `content`，`tool_use` 进 `tool_calls`。
fn convert_assistant(blocks: &[Value], out: &mut Vec<Value>) {
    let mut text = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();

    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(part) = block.get("text").and_then(Value::as_str) {
                    text.push_str(part);
                }
            }
            Some("tool_use") => {
                let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                // `input` 是对象，OpenAI 要字符串。缺省给 `{}`，不能给空串——
                // 空串不是合法 JSON，不少上游会 400。
                let arguments = block
                    .get("input")
                    .map(|input| input.to_string())
                    .unwrap_or_else(|| "{}".into());
                tool_calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": arguments }
                }));
            }
            // thinking 块不进 OpenAI：跨厂商的签名是过期票据。
            _ => {}
        }
    }

    let mut message = Map::new();
    message.insert("role".into(), Value::String("assistant".into()));
    // 只有工具调用时 content 必须是 null（空串会被部分上游当成「有文本」）。
    if text.is_empty() && !tool_calls.is_empty() {
        message.insert("content".into(), Value::Null);
    } else {
        message.insert("content".into(), Value::String(text));
    }
    if !tool_calls.is_empty() {
        message.insert("tool_calls".into(), Value::Array(tool_calls));
    }
    out.push(Value::Object(message));
}

/// user：`tool_result` 拆成独立的 `role: tool` 消息，文本与图片合成一条 user。
///
/// **工具结果必须全部前置。** OpenAI 的硬约束是 `role:"tool"` 紧跟在带
/// `tool_calls` 的 assistant 之后；Anthropic 则允许一条 user 消息里文本与工具
/// 结果混排。照原序发（文本 → 工具结果）会在两者之间插一条 user 消息，上游
/// 直接 400，而这类 400 没有可用的自愈指纹。
///
/// 代价是「文本在前」的原始时序被压到工具结果之后。实际会话里 Anthropic 的
/// 工具结果总排在 content 首位，这条只影响少见的混排形态。
fn convert_user(blocks: &[Value], out: &mut Vec<Value>) {
    // 第一步：工具结果，保持它们之间的相对顺序。
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let id = block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // 工具结果是 block 数组时只取文本；图片结果 OpenAI 侧没有对应位。
        let content = match block.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        out.push(json!({
            "role": "tool",
            "tool_call_id": id,
            "content": content
        }));
    }

    // 第二步：文本与图片合成一条 user 消息（没有内容就不发空消息）。
    let mut parts: Vec<Value> = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    texts.push(text.to_string());
                }
            }
            Some("image") => {
                if let Some(source) = block.get("source") {
                    let media = source
                        .get("media_type")
                        .and_then(Value::as_str)
                        .unwrap_or("image/png");
                    let data = source
                        .get("data")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    parts.push(json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{media};base64,{data}") }
                    }));
                }
            }
            _ => {}
        }
    }

    if parts.is_empty() {
        if !texts.is_empty() {
            out.push(json!({ "role": "user", "content": texts.join("") }));
        }
        return;
    }
    // 混排（图 + 文）：文本也转成 part，接在图片之后。
    if !texts.is_empty() {
        parts.push(json!({ "type": "text", "text": texts.join("") }));
    }
    out.push(json!({ "role": "user", "content": Value::Array(parts) }));
}

fn convert_tool_choice(choice: &Value) -> Option<Value> {
    match choice.get("type").and_then(Value::as_str)? {
        "auto" => Some(Value::String("auto".into())),
        // Anthropic 的 any = 必须调一个工具；OpenAI 叫 required。
        "any" => Some(Value::String("required".into())),
        "none" => Some(Value::String("none".into())),
        "tool" => {
            let name = choice.get("name").and_then(Value::as_str)?;
            Some(json!({ "type": "function", "function": { "name": name } }))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_and_system_are_translated() {
        let body = json!({
            "model": "gpt-x",
            "system": "你是助手",
            "max_tokens": 100,
            "messages": [{ "role": "user", "content": "你好" }]
        });
        let out = convert(&body).unwrap();
        assert_eq!(out["model"], "gpt-x");
        assert_eq!(out["max_tokens"], 100);
        assert_eq!(out["messages"][0]["role"], "system");
        assert_eq!(out["messages"][0]["content"], "你是助手");
        assert_eq!(out["messages"][1]["content"], "你好");
        assert!(out.get("stream").is_none());
    }

    #[test]
    fn system_blocks_are_joined() {
        let body = json!({
            "model": "m",
            "system": [{ "type": "text", "text": "第一段" }, { "type": "text", "text": "第二段" }],
            "messages": []
        });
        let out = convert(&body).unwrap();
        assert_eq!(out["messages"][0]["content"], "第一段\n\n第二段");
    }

    #[test]
    fn tool_use_becomes_tool_calls_with_string_arguments() {
        let body = json!({
            "model": "m",
            "messages": [{
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "我查一下" },
                    { "type": "tool_use", "id": "toolu_1", "name": "search",
                      "input": { "q": "rust" } }
                ]
            }]
        });
        let out = convert(&body).unwrap();
        let msg = &out["messages"][0];
        assert_eq!(msg["content"], "我查一下");
        assert_eq!(msg["tool_calls"][0]["id"], "toolu_1");
        assert_eq!(msg["tool_calls"][0]["function"]["name"], "search");
        // 必须是字符串，不是对象
        let args = msg["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments 必须是 JSON 字符串");
        assert_eq!(
            serde_json::from_str::<Value>(args).unwrap(),
            json!({ "q": "rust" })
        );
    }

    #[test]
    fn tool_only_assistant_has_null_content() {
        let body = json!({
            "model": "m",
            "messages": [{
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": "t", "name": "f", "input": {} }]
            }]
        });
        let out = convert(&body).unwrap();
        assert!(out["messages"][0]["content"].is_null());
        assert_eq!(
            out["messages"][0]["tool_calls"][0]["function"]["arguments"],
            "{}"
        );
    }

    /// 一条 user 消息里文本与多个工具结果混排：拆成 tool → tool → user。
    ///
    /// 工具结果必须排在文本前面——OpenAI 要求 `role:"tool"` 紧跟 assistant 的
    /// `tool_calls`，中间插一条 user 文本会被上游 400。
    #[test]
    fn tool_results_are_hoisted_before_text() {
        let body = json!({
            "model": "m",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "结果如下" },
                    { "type": "tool_result", "tool_use_id": "a", "content": "A" },
                    { "type": "tool_result", "tool_use_id": "b",
                      "content": [{ "type": "text", "text": "B1" }, { "type": "text", "text": "B2" }] }
                ]
            }]
        });
        let out = convert(&body).unwrap();
        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "tool");
        assert_eq!(msgs[0]["tool_call_id"], "a");
        assert_eq!(msgs[0]["content"], "A");
        assert_eq!(msgs[1]["role"], "tool");
        assert_eq!(msgs[1]["tool_call_id"], "b");
        assert_eq!(msgs[1]["content"], "B1\nB2");
        // 文本后置，且只产生一条 user 消息
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"], "结果如下");
    }

    /// 只有工具结果时不能凭空多出一条空的 user 消息。
    #[test]
    fn tool_only_user_message_has_no_empty_text() {
        let out = convert(&json!({
            "model": "m",
            "messages": [{
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": "a", "content": "A" }]
            }]
        }))
        .unwrap();
        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "tool");
    }

    #[test]
    fn tools_and_tool_choice_are_mapped() {
        let body = json!({
            "model": "m",
            "messages": [],
            "tools": [
                { "name": "a", "description": "d", "input_schema": { "type": "object" } },
                { "name": "no_schema" }
            ],
            "tool_choice": { "type": "any" }
        });
        let out = convert(&body).unwrap();
        assert_eq!(out["tools"][0]["type"], "function");
        assert_eq!(out["tools"][0]["function"]["name"], "a");
        assert_eq!(out["tools"][0]["function"]["parameters"]["type"], "object");
        assert_eq!(out["tools"][1]["function"]["parameters"]["type"], "object");
        assert_eq!(out["tool_choice"], "required");
    }

    #[test]
    fn tool_choice_tool_names_one_function() {
        let body = json!({
            "model": "m",
            "messages": [],
            "tool_choice": { "type": "tool", "name": "search" }
        });
        let out = convert(&body).unwrap();
        assert_eq!(out["tool_choice"]["type"], "function");
        assert_eq!(out["tool_choice"]["function"]["name"], "search");
    }

    #[test]
    fn stream_turns_on_usage_in_stream() {
        let body = json!({ "model": "m", "messages": [], "stream": true });
        let out = convert(&body).unwrap();
        assert_eq!(out["stream"], true);
        assert_eq!(out["stream_options"]["include_usage"], true);
    }

    #[test]
    fn cache_control_and_thinking_are_dropped() {
        let body = json!({
            "model": "m",
            "thinking": { "type": "enabled" },
            "messages": [{
                "role": "user",
                "content": [{ "type": "text", "text": "hi", "cache_control": { "type": "ephemeral" } }]
            }]
        });
        let out = convert(&body).unwrap();
        assert!(out.get("thinking").is_none());
        assert!(out["messages"][0]["content"].get("cache_control").is_none());
    }

    #[test]
    fn images_become_image_url_parts() {
        let body = json!({
            "model": "m",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "看图" },
                    { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "QUJD" } }
                ]
            }]
        });
        let out = convert(&body).unwrap();
        let content = out["messages"][0]["content"].as_array().unwrap();
        let image = content.iter().find(|p| p["type"] == "image_url").unwrap();
        assert_eq!(image["image_url"]["url"], "data:image/jpeg;base64,QUJD");
    }

    /// 自愈把 `max_tokens` 改名后要能从这里透传；两个同时存在时只发新的那个
    /// （OpenAI 会把多出来的当未知参数拒掉）。
    #[test]
    fn max_completion_tokens_wins_over_max_tokens() {
        let out = convert(&json!({
            "model": "gpt-5.5",
            "max_tokens": 128,
            "max_completion_tokens": 64,
            "messages": [{ "role": "user", "content": "hi" }]
        }))
        .unwrap();
        assert_eq!(out["max_completion_tokens"], 64);
        assert!(out.get("max_tokens").is_none(), "不能同时带两个字段");
    }
}
