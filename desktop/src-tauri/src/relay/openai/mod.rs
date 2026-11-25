//! OpenAI 方言：请求转过去、响应转回来。
//!
//! 只在 `profile::Dialect::OpenAi` 时启用。Anthropic 兼容上游（国内主流厂商
//! 基本都是）走的是原样透传，不经过这里——转换一层就多一层可能出错的映射，
//! 能用透传就别转。
//!
//! 三个文件各管一段：
//!
//! - `request.rs`：Anthropic Messages → chat/completions
//! - `response.rs`：非流式响应 → Anthropic message
//! - `stream.rs`：流式 chunk → Anthropic SSE 事件
//!
//! `count_tokens` 在 OpenAI 侧没有对应端点，只能本地估算（见
//! [`estimate_input_tokens`]）——Anthropic 的客户端拿它做上下文预算，估得太离谱
//! 会让它在错误的时机压缩历史。

use serde_json::{json, Value};

pub mod request;
pub mod response;
pub mod stream;

/// 本地估算输入 token 数。
///
/// **这是估算，不是真值。** OpenAI 的 tokenizer 与 Anthropic 不同，各家的
/// 中文切分也不一样，任何本地计算都只能是量级正确。按 3 字符/token 折算
/// （中英混排的折中值，纯英文约 4、纯中文约 1.5–2）。
///
/// 宁可略微高估：低估会让客户端以为还有余量，直到某次请求被上游以
/// `context length exceeded` 拒掉。
pub fn estimate_input_tokens(body: &Value) -> u64 {
    let mut chars = 0usize;
    collect_chars(body.get("system"), &mut chars);
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            collect_chars(message.get("content"), &mut chars);
            // tool_calls 里的 arguments 也是输入的一部分，常被漏掉。
            collect_chars(message.get("tool_calls"), &mut chars);
        }
    }
    if let Some(tools) = body.get("tools") {
        chars += tools.to_string().chars().count();
    }
    // 每条消息的固定开销（role、分隔符）按 4 个 token 计。
    let overhead = body
        .get("messages")
        .and_then(Value::as_array)
        .map_or(0, |m| m.len() as u64 * 4);
    (chars as u64 / 3).saturating_add(overhead).max(1)
}

fn collect_chars(value: Option<&Value>, out: &mut usize) {
    match value {
        Some(Value::String(text)) => *out += text.chars().count(),
        Some(Value::Array(items)) => {
            for item in items {
                collect_chars(Some(item), out);
            }
        }
        Some(Value::Object(map)) => {
            for key in ["text", "content", "arguments", "data"] {
                if let Some(value) = map.get(key) {
                    collect_chars(Some(value), out);
                }
            }
        }
        _ => {}
    }
}

/// Anthropic `count_tokens` 端点的响应形状。
pub fn count_tokens_body(body: &Value) -> Value {
    json!({ "input_tokens": estimate_input_tokens(body) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_grows_with_content() {
        let small = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        let large = json!({ "messages": [{ "role": "user", "content": "hi".repeat(300) }] });
        assert!(estimate_input_tokens(&large) > estimate_input_tokens(&small));
    }

    #[test]
    fn never_returns_zero() {
        // 空请求也回 1：客户端拿 0 会当成「上下文没用」，除法里还可能炸。
        assert_eq!(estimate_input_tokens(&json!({ "messages": [] })), 1);
    }

    #[test]
    fn counts_system_and_tools() {
        let base = json!({ "messages": [{ "role": "user", "content": "x" }] });
        let with_system = json!({
            "system": "很长的系统提示".repeat(20),
            "messages": [{ "role": "user", "content": "x" }]
        });
        let with_tools = json!({
            "messages": [{ "role": "user", "content": "x" }],
            "tools": [{ "name": "t", "description": "d".repeat(200), "input_schema": { "type": "object" } }]
        });
        assert!(estimate_input_tokens(&with_system) > estimate_input_tokens(&base));
        assert!(estimate_input_tokens(&with_tools) > estimate_input_tokens(&base));
    }

    #[test]
    fn response_shape_matches_count_tokens() {
        let body = count_tokens_body(&json!({ "messages": [{ "role": "user", "content": "hi" }] }));
        assert!(body["input_tokens"].as_u64().unwrap() >= 1);
    }
}
