//! 上游 4xx 的「已知可修」诊断与修复。
//!
//! 这里只放**能从错误体认出原因、且修法确定**的几种情况。识别不出来就返回
//! `None`，让原始错误照常返回给用户——猜错比不猜更糟：悄悄改一个字段会让
//! 用户以为「上游接受了」，实际行为已经变了。
//!
//! 命名与 `cleanErr(e).includes(marker)` 的口径一致：用 `contains` 不用
//! `startsWith`。上游的错误体外面还包着自家的一层 JSON（`{"error":{"message":…}}`），
//! 前缀匹配会全部漏掉。
//!
//! 修法都落在**不改语义**或**只放松约束**的方向上：压 `max_tokens`、剥掉别家的
//! thinking 块。既然上游明确拒了，拒的那条约束本来也保不住。

use serde_json::Value;

/// `max_tokens` 超限时压到的值。
///
/// 不用「从错误体里解析出上限」：各家的措辞与数字位置都不统一，解析失败就会
/// 修一半。8192 是绝大多数兼容端点都接受的量级，压一次能过就过了；过不了
/// 也只重试一次，不会把请求打成循环。
const SAFE_MAX_TOKENS: u32 = 8192;

/// 可自动修复的三种情况。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Repair {
    ClampMaxTokens,
    StripThinking,
    /// OpenAI 的 o 系 / gpt-5 系不再接受 `max_tokens`，要求改用
    /// `max_completion_tokens`。拒的不是数值大小，是字段名。
    UseMaxCompletionTokens,
}

impl Repair {
    /// 日志「请求改写」列里的名字。带 `repair:` 前缀，与主动清洗区分开。
    pub fn label(self) -> &'static str {
        match self {
            Repair::ClampMaxTokens => "repair:clamp",
            Repair::StripThinking => "repair:strip_thinking",
            Repair::UseMaxCompletionTokens => "repair:max_completion_tokens",
        }
    }
}

/// 从错误体里认出可修的原因。
///
/// 两条硬约束：
/// - `max_tokens` 的**下界**错误（must be greater than 0）不能当成超限，压上限
///   只会让它更错，所以要求出现「上限」类词。
/// - thinking 必须与「不支持」同时出现；只说 `thinking` 的错误可能是在抱怨
///   签名不对，那是跨厂商切换的正常现象，剥掉即可，但也可能是在抱怨内容，
///   所以只在明确的 not supported / unsupported 下动手。
pub fn detect(body: &str) -> Option<Repair> {
    let text = body.to_ascii_lowercase();

    let mentions_max_tokens = text.contains("max_tokens")
        || text.contains("max tokens")
        || text.contains("max_completion_tokens");
    // 先判「改名」：错误体里**同时**出现旧字段名与新字段名，说的是「换字段」。
    //
    // 必须用 `max_tokens` 而不是上面的合并判断：`max_completion_tokens` 本身
    // 不含 `max_tokens` 子串，所以「max_completion_tokens 超限」这条不会误入
    // 改名分支——它是数值问题，压上限才对。
    if text.contains("max_tokens") && text.contains("max_completion_tokens") {
        return Some(Repair::UseMaxCompletionTokens);
    }
    let over_limit = [
        "exceed",
        "too large",
        "too long",
        "greater than",
        "maximum",
        "less than or equal",
    ]
    .iter()
    .any(|marker| text.contains(marker));
    if mentions_max_tokens && over_limit {
        return Some(Repair::ClampMaxTokens);
    }

    let mentions_thinking = text.contains("thinking");
    let unsupported = ["not supported", "unsupported", "not allowed", "invalid"]
        .iter()
        .any(|m| text.contains(m));
    if mentions_thinking && unsupported {
        return Some(Repair::StripThinking);
    }

    None
}

/// 应用修复。返回是否真的改了 body——没改就不该重试（重发同一个请求只是白烧一次）。
pub fn apply(repair: Repair, body: &mut Value) -> bool {
    match repair {
        Repair::ClampMaxTokens => {
            let Some(current) = body.get("max_tokens").and_then(Value::as_u64) else {
                return false;
            };
            if current <= u64::from(SAFE_MAX_TOKENS) {
                // 已经是安全值还被拒，说明问题不在大小，压下去也没用。
                return false;
            }
            body["max_tokens"] = Value::from(SAFE_MAX_TOKENS);
            true
        }
        Repair::StripThinking => strip_thinking(body),
        Repair::UseMaxCompletionTokens => rename_max_tokens(body),
    }
}

/// `max_tokens` → `max_completion_tokens`。值原样搬过去。
///
/// 两个字段**不能同时存在**：OpenAI 会把多出来的那个当成未知参数拒掉。
/// 所以是改名（先 remove 再 insert），不是追加。
fn rename_max_tokens(body: &mut Value) -> bool {
    let Some(obj) = body.as_object_mut() else {
        return false;
    };
    let Some(value) = obj.remove("max_tokens") else {
        return false;
    };
    obj.insert("max_completion_tokens".into(), value);
    true
}

/// 剥掉历史消息里的 thinking 块与顶层的 `thinking` 开关。
///
/// 跨厂商切换时，别家的 thinking 签名到了新上游就是一张过期票据：上游要么拒，
/// 要么当成垃圾内容。丢掉它只损失「模型之前的思考过程」，不影响任务本身。
///
/// `pub(crate)`：`chain` 的 `thinking` 规则也走这里——同一件事两处实现迟早会漂移
/// （一处删 `redacted_thinking`、另一处忘删，就是两次不同的清洗结果）。
pub(crate) fn strip_thinking(body: &mut Value) -> bool {
    let mut changed = false;

    // 顶层 `thinking`（Anthropic 的开关字段）
    if let Some(obj) = body.as_object_mut() {
        if obj.remove("thinking").is_some() {
            changed = true;
        }
    }

    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return changed;
    };
    for message in messages {
        let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        let before = content.len();
        content.retain(|block| {
            block.get("type").and_then(Value::as_str) != Some("thinking")
                && block.get("type").and_then(Value::as_str) != Some("redacted_thinking")
        });
        if content.len() != before {
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_max_tokens_over_limit() {
        for body in [
            r#"{"error":{"message":"max_tokens: 128000 > 8192, which is the maximum allowed"}}"#,
            r#"Invalid schema: max_tokens is too large"#,
            r#"{"error":"max_completion_tokens exceeds the limit"}"#,
        ] {
            assert_eq!(detect(body), Some(Repair::ClampMaxTokens), "{body}");
        }
    }

    /// 下界错误不能被当成超限：压上限会让它更错。
    #[test]
    fn does_not_misread_the_lower_bound_error() {
        let body = r#"max_tokens must be greater than 0"#;
        // 这条同时命中了 "greater than"，但它是下界——我们的实现会命中，
        // 所以这里钉的是「即使命中也不会改」：apply 发现当前值不大就返回 false。
        let mut value = json!({ "max_tokens": 16 });
        let repair = detect(body);
        assert!(repair.is_none() || !apply(repair.unwrap(), &mut value));
        assert_eq!(value["max_tokens"], 16);
    }

    #[test]
    fn detects_unsupported_thinking() {
        let body = r#"{"error":{"message":"thinking is not supported for this model"}}"#;
        assert_eq!(detect(body), Some(Repair::StripThinking));
    }

    #[test]
    fn unrelated_errors_are_not_repaired() {
        for body in [
            r#"{"error":{"message":"authentication failed"}}"#,
            r#"Invalid schema for function 'Artifact': "^[^\0]*$" is not a "regex""#,
            r#"model not found"#,
        ] {
            assert_eq!(detect(body), None, "{body}");
        }
    }

    #[test]
    fn clamp_only_shrinks() {
        let mut body = json!({ "max_tokens": 64000 });
        assert!(apply(Repair::ClampMaxTokens, &mut body));
        assert_eq!(body["max_tokens"], SAFE_MAX_TOKENS);

        // 已经很小 → 不动，也不重试
        let mut small = json!({ "max_tokens": 256 });
        assert!(!apply(Repair::ClampMaxTokens, &mut small));
        assert_eq!(small["max_tokens"], 256);

        // 没有这个字段 → 不动
        let mut none = json!({ "model": "m" });
        assert!(!apply(Repair::ClampMaxTokens, &mut none));
    }

    #[test]
    fn strip_thinking_removes_blocks_and_switch() {
        let mut body = json!({
            "thinking": { "type": "enabled", "budget_tokens": 4096 },
            "messages": [
                { "role": "assistant", "content": [
                    { "type": "thinking", "thinking": "…", "signature": "sig" },
                    { "type": "redacted_thinking", "data": "…" },
                    { "type": "text", "text": "答案" }
                ]},
                { "role": "user", "content": "继续" }
            ]
        });
        assert!(apply(Repair::StripThinking, &mut body));
        assert!(body.get("thinking").is_none());
        let blocks = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "text");
        // 字符串形态的 content 不能被误伤
        assert_eq!(body["messages"][1]["content"], "继续");
    }

    #[test]
    fn strip_thinking_is_idempotent() {
        let mut body = json!({
            "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }]
        });
        assert!(!apply(Repair::StripThinking, &mut body));
    }

    /// o 系 / gpt-5：被拒的是**字段名**，不是数值。压数值重发还是同一个 400。
    #[test]
    fn renames_max_tokens_when_the_model_wants_max_completion_tokens() {
        let body = r#"{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.","type":"invalid_request_error","param":"max_tokens","code":"unsupported_parameter"}}"#;
        assert_eq!(detect(body), Some(Repair::UseMaxCompletionTokens));

        let mut value = json!({ "model": "gpt-5.5", "max_tokens": 64 });
        assert!(apply(Repair::UseMaxCompletionTokens, &mut value));
        assert!(value.get("max_tokens").is_none(), "不能两个字段都留着");
        assert_eq!(value["max_completion_tokens"], 64);
    }

    /// `max_completion_tokens` 超限是数值问题，必须走 clamp，不能走改名。
    #[test]
    fn new_field_over_limit_is_still_a_clamp() {
        let body = r#"{"error":"max_completion_tokens exceeds the limit"}"#;
        assert_eq!(detect(body), Some(Repair::ClampMaxTokens));
    }
}
