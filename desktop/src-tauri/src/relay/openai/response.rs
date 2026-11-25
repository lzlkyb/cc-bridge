//! OpenAI Chat Completions 响应 → Anthropic Messages（非流式）。
//!
//! 结构不复杂，两处必须较真：
//!
//! - **`arguments` 是 JSON 字符串，要解析成对象。** 解析失败就报错，不能静默
//!   变成 `{}`——模型会拿着空参数去调工具，用户看到的是一次「莫名其妙失败」，
//!   而真正的原因（上游给了半截 JSON）被吞掉了。
//! - **`finish_reason` 与 `stop_reason` 不是一一对应。** `tool_calls` 要映射成
//!   `tool_use`，否则 Claude Code 不会去执行工具。

use serde_json::{json, Value};

/// 转换一份非流式响应。
pub fn convert(upstream: &Value, requested_model: &str) -> Result<Value, String> {
    let choice = upstream
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| "上游响应里没有 choices。".to_string())?;
    let message = choice
        .get("message")
        .ok_or_else(|| "上游响应的 choices[0] 没有 message。".to_string())?;

    let mut content: Vec<Value> = Vec::new();
    // `content` 可能是 null（纯工具调用）、字符串，或 parts 数组。
    match message.get("content") {
        Some(Value::String(text)) if !text.is_empty() => {
            content.push(json!({ "type": "text", "text": text }));
        }
        Some(Value::Array(parts)) => {
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    content.push(json!({ "type": "text", "text": text }));
                }
            }
        }
        _ => {}
    }

    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in tool_calls {
            let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
            let function = call
                .get("function")
                .ok_or_else(|| "上游返回的 tool_call 缺少 function。".to_string())?;
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let raw = function
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let input: Value = serde_json::from_str(raw).map_err(|e| {
                let head: String = raw.chars().take(160).collect();
                format!("上游返回的工具参数不是合法 JSON（{e}）：{head}")
            })?;
            content.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input
            }));
        }
    }

    let stop_reason = match choice.get("finish_reason").and_then(Value::as_str) {
        Some("length") => "max_tokens",
        Some("tool_calls") => "tool_use",
        // stop / content_filter / null 都归为正常结束：客户端对 end_turn 的处理
        // 最稳，未知取值落到它不会打断会话。
        _ => "end_turn",
    };

    let usage = upstream.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached = usage
        .and_then(|u| u.get("prompt_tokens_details"))
        .and_then(|d| d.get("cached_tokens"))
        .and_then(Value::as_u64);

    let mut usage_json = json!({
        "input_tokens": input_tokens,
        "output_tokens": output_tokens
    });
    if let Some(cached) = cached {
        usage_json["cache_read_input_tokens"] = Value::from(cached);
    }

    let id = upstream
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(|id| format!("msg_{id}"))
        .unwrap_or_else(|| "msg_relay".to_string());
    let model = upstream
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(requested_model);

    Ok(json!({
        "id": id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": Value::Null,
        "usage": usage_json
    }))
}

/// 把 OpenAI 的 4xx/5xx 错误体包成 Anthropic 的错误形态。
///
/// Claude Code 按 `{type:"error", error:{type, message}}` 判断该怎么处理：要不要
/// 重试、要不要提示「换个模型」、要不要当成额度问题。OpenAI 的
/// `{error:{message}}` 少那一层 `type`，客户端只能当未知错误——上游原话还在，
/// 但「这是限流还是参数错」的信息丢了。
///
/// 解析不出 JSON（HTML 错误页、纯文本）就返回 `None`，调用方原样透传：
/// 这种情况包装只会把可读的页面变成一句转义字符串。
pub fn wrap_error(body: &str, status: u16) -> Option<Value> {
    let value: Value = serde_json::from_str(body).ok()?;
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        // 部分网关把 message 放在顶层
        .or_else(|| value.get("message").and_then(Value::as_str))
        .unwrap_or(body)
        .to_string();
    let kind = match status {
        400 => "invalid_request_error",
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        529 => "overloaded_error",
        _ => "api_error",
    };
    Some(json!({
        "type": "error",
        "error": { "type": kind, "message": message }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_response_is_wrapped() {
        let upstream = json!({
            "id": "chatcmpl-1",
            "model": "gpt-x",
            "choices": [{ "message": { "role": "assistant", "content": "你好" }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 12, "completion_tokens": 3 }
        });
        let out = convert(&upstream, "fallback").unwrap();
        assert_eq!(out["type"], "message");
        assert_eq!(out["role"], "assistant");
        assert_eq!(out["content"][0]["type"], "text");
        assert_eq!(out["content"][0]["text"], "你好");
        assert_eq!(out["stop_reason"], "end_turn");
        assert_eq!(out["usage"]["input_tokens"], 12);
        assert_eq!(out["usage"]["output_tokens"], 3);
        assert_eq!(out["model"], "gpt-x");
    }

    #[test]
    fn tool_calls_become_tool_use_blocks() {
        let upstream = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "search", "arguments": "{\"q\":\"rust\"}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        });
        let out = convert(&upstream, "m").unwrap();
        assert_eq!(out["stop_reason"], "tool_use");
        let block = &out["content"][0];
        assert_eq!(block["type"], "tool_use");
        assert_eq!(block["id"], "call_1");
        assert_eq!(block["name"], "search");
        assert_eq!(block["input"]["q"], "rust");
        // 纯工具调用时不该多出一个空 text block
        assert_eq!(out["content"].as_array().unwrap().len(), 1);
    }

    /// 半截 JSON 必须报错，不能静默给空参数。
    #[test]
    fn broken_arguments_are_reported() {
        let upstream = json!({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{ "id": "c", "function": { "name": "f", "arguments": "{\"q\":" } }]
                },
                "finish_reason": "tool_calls"
            }]
        });
        let err = convert(&upstream, "m").unwrap_err();
        assert!(err.contains("不是合法 JSON"), "{err}");
    }

    #[test]
    fn length_maps_to_max_tokens() {
        let upstream = json!({
            "choices": [{ "message": { "content": "x" }, "finish_reason": "length" }]
        });
        assert_eq!(
            convert(&upstream, "m").unwrap()["stop_reason"],
            "max_tokens"
        );
    }

    #[test]
    fn missing_usage_becomes_zero_not_absent() {
        let upstream = json!({
            "choices": [{ "message": { "content": "x" }, "finish_reason": "stop" }]
        });
        let out = convert(&upstream, "m").unwrap();
        assert_eq!(out["usage"]["input_tokens"], 0);
        assert_eq!(out["usage"]["output_tokens"], 0);
        assert!(out["usage"].get("cache_read_input_tokens").is_none());
    }

    #[test]
    fn cached_tokens_map_to_cache_read() {
        let upstream = json!({
            "choices": [{ "message": { "content": "x" }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 2,
                       "prompt_tokens_details": { "cached_tokens": 7 } }
        });
        let out = convert(&upstream, "m").unwrap();
        assert_eq!(out["usage"]["cache_read_input_tokens"], 7);
    }

    #[test]
    fn missing_choices_is_an_error() {
        assert!(convert(&json!({ "error": {} }), "m").is_err());
    }

    #[test]
    fn openai_errors_are_wrapped_in_anthropic_shape() {
        let wrapped = wrap_error(
            r#"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}"#,
            429,
        )
        .expect("JSON 错误体应能包装");
        assert_eq!(wrapped["type"], "error");
        assert_eq!(wrapped["error"]["type"], "rate_limit_error");
        assert_eq!(
            wrapped["error"]["message"],
            "You exceeded your current quota"
        );

        // 400 归到参数错：客户端据此提示改配置，而不是重试
        let bad = wrap_error(r#"{"error":{"message":"model not found"}}"#, 400).unwrap();
        assert_eq!(bad["error"]["type"], "invalid_request_error");
    }

    /// 非 JSON（HTML 错误页、纯文本）原样透传，不包装。
    #[test]
    fn non_json_errors_are_not_wrapped() {
        assert!(wrap_error("<html>502 Bad Gateway</html>", 502).is_none());
    }
}
