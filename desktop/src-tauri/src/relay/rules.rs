//! 确定性改写规则（纯函数）。
//!
//! §4.4 把规则分成两类：一类是**透传路径必需**（`strip_model_suffix`），一类是
//! **OpenAI 路径必需**（`clamp_max_tokens` / `drop_thinking` / `drop_cache_control`）。
//! P1 只做 Anthropic 透传，所以这里只实现前两个，后两个留空壳并说明原因——
//! 「先写一个用不上的规则」会在上游真出问题时被当成已支持，比没有更糟。
//!
//! 所有函数都是纯的：进 `Value`/`&str`，出 `(结果, 是否改动)`。不需要起服务就能测。

use serde_json::Value;

/// 去掉模型名尾部的私有后缀，如 `claude-sonnet-4-5[1m]` → `claude-sonnet-4-5`。
///
/// Claude Code 用 `[1m]` 声明「我想要百万上下文」，这是 CLI 侧的私有约定，
/// 上游没有义务认它。真出问题时的表现是 400「请求体格式无效」——和 tool 块那个
/// 400 长得一模一样，很难往模型名上想。一条纯函数的成本远低于再查一次（§4.4）。
///
/// 只认「尾部方括号 + 短字母数字」，不碰模型名中间可能出现的其它字符。
pub fn strip_model_suffix(model: &str) -> (String, bool) {
    let trimmed = model.trim();
    let Some(open) = trimmed.rfind('[') else {
        return (trimmed.to_string(), false);
    };
    if !trimmed.ends_with(']') || open + 2 > trimmed.len() {
        return (trimmed.to_string(), false);
    }
    let inner = &trimmed[open + 1..trimmed.len() - 1];
    // 允许 1m / 1M / 200k 这类短标记；太长或带奇怪字符的不动，避免切坏正常名字。
    let plausible =
        !inner.is_empty() && inner.len() <= 8 && inner.chars().all(|c| c.is_ascii_alphanumeric());
    if !plausible {
        return (trimmed.to_string(), false);
    }
    let base = trimmed[..open].trim_end();
    if base.is_empty() {
        return (trimmed.to_string(), false);
    }
    (base.to_string(), true)
}

/// 把 `max_tokens` 钳到上游上限。`None` = 不压（默认）。
///
/// 返回 `(原值, 是否改动)`，供日志记录「压了多少」。透传路径默认不启用——
/// 用户没给上限就是没上限，替他把 128k 改成 8192 会静默改变行为。
pub fn clamp_max_tokens(body: &mut Value, limit: Option<u32>) -> Option<u32> {
    let limit = limit?;
    let original = body.get("max_tokens").and_then(Value::as_u64)?;
    if original <= u64::from(limit) {
        return None;
    }
    body["max_tokens"] = Value::from(limit);
    Some(original as u32)
}

// ── 以下两条在 P1 不启用，留位置和理由 ──────────────────────────────────

/// 剥 `thinking` 配置与块。**P1 不启用**：§4.4.3 实测上游对 `thinking` 一路通行，
/// 动了反而丢掉思考过程。等接严格上游（Bedrock 等）时按能力表打开。
pub fn drop_thinking(_body: &mut Value) -> bool {
    false
}

/// 移除 `cache_control` 标记。**P1 不启用**：上游认这个字段，且去掉会让缓存失效、
/// 成本上升。OpenAI 兼容路径才需要（那边没有这个概念）。
pub fn drop_cache_control(_body: &mut Value) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn suffix_is_stripped() {
        assert_eq!(
            strip_model_suffix("claude-sonnet-4-5[1m]"),
            ("claude-sonnet-4-5".into(), true)
        );
        assert_eq!(
            strip_model_suffix("claude-sonnet-4-5[1M]"),
            ("claude-sonnet-4-5".into(), true)
        );
        assert_eq!(
            strip_model_suffix("  claude-opus-4-1[200k]  "),
            ("claude-opus-4-1".into(), true)
        );
    }

    #[test]
    fn names_without_suffix_are_untouched() {
        for name in [
            "claude-sonnet-5-5",
            "qwen4-max-preview",
            "deepseek-v4.1-flash-1017",
            // 中括号但不在尾部 → 不动
            "weird[name]-model",
        ] {
            assert_eq!(
                strip_model_suffix(name),
                (name.to_string(), false),
                "{name} 不该被改"
            );
        }
    }

    #[test]
    fn implausible_brackets_are_not_stripped() {
        // 太长的方括号内容不当后缀，宁可不动也不要切坏正常名字。
        assert_eq!(
            strip_model_suffix("model[this-is-way-too-long]"),
            ("model[this-is-way-too-long]".into(), false)
        );
        assert_eq!(strip_model_suffix("model[]"), ("model[]".into(), false));
    }

    #[test]
    fn clamp_only_when_over_limit() {
        let mut body = json!({ "max_tokens": 128000 });
        assert_eq!(clamp_max_tokens(&mut body, Some(8192)), Some(128000));
        assert_eq!(body["max_tokens"], 8192);

        let mut body = json!({ "max_tokens": 1024 });
        assert_eq!(clamp_max_tokens(&mut body, Some(8192)), None);
        assert_eq!(body["max_tokens"], 1024);

        // limit 为 None 时不压（默认形态，不能替用户做决定）
        let mut body = json!({ "max_tokens": 128000 });
        assert_eq!(clamp_max_tokens(&mut body, None), None);
        assert_eq!(body["max_tokens"], 128000);
    }

    #[test]
    fn disabled_rules_never_change_body() {
        // P1 这两条必须是无操作，否则等于悄悄丢字段。
        let mut body = json!({ "thinking": { "type": "adaptive" } });
        assert!(!drop_thinking(&mut body));
        assert_eq!(body["thinking"]["type"], "adaptive");
        let mut body =
            json!({ "messages": [{ "content": [{ "cache_control": { "type": "ephemeral" } }] }] });
        assert!(!drop_cache_control(&mut body));
        assert!(body["messages"][0]["content"][0]
            .get("cache_control")
            .is_some());
    }
}
