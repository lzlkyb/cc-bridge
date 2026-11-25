//! 三态清洗器：`Unchanged` / `Sanitized` / `Refused`（§4.4.2）。
//!
//! 结构照 LiteLLM PR #42731：**一次性**把请求校验成带类型的视图，而不是边转发边
//! 判断；每个发现是一条 finding（带请求路径与归属开关）；拒绝错误只有一个出口生成。
//!
//! 这套结构的价值不在优雅，在**可测**——finding 是纯数据结构，可以直接喂录制样本
//! 断言，不需要起服务。P1 的验收用例全部打在这一层。
//!
//! 三种结果在这里落成两个类型：
//!
//! | 文档里的三态 | 本模块的表示 |
//! |---|---|
//! | `Unchanged` | `Ok(Prepared { changed: false, .. })`，`bytes` 就是入参原始字节 |
//! | `Sanitized(f)` | `Ok(Prepared { changed: true, findings, .. })` |
//! | `Refused(cause)` | `Err(Refusal)` |
//!
//! 用 `changed` 而不是三个 enum 变体，是因为转发层对前两者的动作只差一件事：
//! 发哪份字节。多一个分支只会多一处可能写错的地方。

use serde_json::{json, Value};

use super::chain;
use super::config::Provider;
use super::fold::{self, FoldFinding};

/// 一次请求被处理后的形态。
pub struct Prepared {
    /// 实际要发给上游的字节。`changed == false` 时**逐字节等于**入参。
    pub bytes: Vec<u8>,
    /// 解析后的视图（已应用确定性改写）。路由从这里读 `model`。
    pub json: Value,
    /// 是否改动过。
    pub changed: bool,
    /// 折叠发现，带 `messages[i].content[j]` 路径。
    pub findings: Vec<FoldFinding>,
    /// schema 正则归一化的发现，带 `tools[i](名字).…pattern` 路径。
    pub schema_notes: Vec<String>,
    /// 触发过的改写种类，日志里给一行摘要：`strip_suffix` / `fold` / `clamp` / `pattern`。
    pub rewrites: Vec<&'static str>,
}

impl std::fmt::Debug for Prepared {
    /// 手写而不是 derive：body 可能几百 KB，panic 时把它整块打进终端会把真正
    /// 有用的断言信息冲掉。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Prepared")
            .field("bytes_len", &self.bytes.len())
            .field("changed", &self.changed)
            .field("rewrites", &self.rewrites)
            .field("findings", &self.findings.len())
            .field("schema_notes", &self.schema_notes.len())
            .finish()
    }
}

impl Prepared {
    /// 日志里「改写」那一列的取值。没改过返回 `None`。
    pub fn rewrite_label(&self) -> Option<String> {
        if self.rewrites.is_empty() {
            return None;
        }
        Some(self.rewrites.join("+"))
    }

    /// 折叠摘要（第一个发现 + 总数），日志详情用。
    pub fn fold_summary(&self) -> Option<String> {
        if self.findings.is_empty() {
            return None;
        }
        fold::findings_summary(&self.findings)
    }

    /// schema 归一化摘要（第一条 + 总数），日志详情用。
    ///
    /// 与折叠摘要分开两个字段：折叠是「动了消息结构」，这里只是「换了个转义写法」，
    /// 混在一起会让排障时分不清哪条导致了上游行为变化。
    pub fn schema_summary(&self) -> Option<String> {
        let first = self.schema_notes.first()?;
        Some(match self.schema_notes.len() {
            1 => first.clone(),
            n => format!("{first} 等 {n} 处"),
        })
    }
}

/// 拒绝原因。**错误文案只在这里生成**（§4.4.2 第 4 条）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefusalCause {
    /// 请求体不是合法 JSON。
    InvalidJson(String),
    /// 合法 JSON 但不是对象。
    NotObject,
    /// 缺 `model` 字段或为空串。
    MissingModel,
    /// `messages` 不是数组（上游会 400，但那时信息更模糊）。
    InvalidMessages,
}

impl RefusalCause {
    pub fn message(&self) -> String {
        match self {
            RefusalCause::InvalidJson(e) => {
                format!("请求体不是合法 JSON：{e}。中转没有改动它，请检查客户端发出的内容。")
            }
            RefusalCause::NotObject => "请求体必须是 JSON 对象。".into(),
            RefusalCause::MissingModel => {
                "请求体缺少 model 字段。中转需要它来判断该用哪一档上游模型。".into()
            }
            RefusalCause::InvalidMessages => "请求体的 messages 必须是数组。".into(),
        }
    }
}

/// 拒绝响应。状态码与错误体形态按 Anthropic Messages 的约定，客户端能正常解析。
#[derive(Clone, Debug)]
pub struct Refusal {
    pub cause: RefusalCause,
}

impl Refusal {
    pub fn new(cause: RefusalCause) -> Self {
        Self { cause }
    }

    pub fn status(&self) -> u16 {
        400
    }

    /// Anthropic 错误体。**不要包成自己的格式**——上游/客户端都按这个结构读
    /// （`type:error` + `error.type` + `error.message`）。
    pub fn body(&self) -> Value {
        json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": self.cause.message(),
            }
        })
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.cause.message())
    }
}

/// 把原始请求体清洗成可转发的形态。
///
/// 结构是「校验 → 规则链 → 决定发哪份字节」。规则**做什么、按什么顺序做**都在
/// `chain.rs`，这里只管三件与转发有关的事：
///
/// 1. 请求体得是个能处理的 JSON 对象、`messages` 是数组、`model` 存在；
/// 2. 跑完规则链后 `model` 仍不能是空串（去后缀可能把它削成 `""`）；
/// 3. 改过才重新序列化——没改必须逐字节等于入参（prompt 缓存的前提）。
pub fn sanitize(raw: &[u8], provider: &Provider) -> Result<Prepared, Refusal> {
    let mut json: Value = serde_json::from_slice(raw)
        .map_err(|e| Refusal::new(RefusalCause::InvalidJson(e.to_string())))?;
    if !json.is_object() {
        return Err(Refusal::new(RefusalCause::NotObject));
    }
    if let Some(msgs) = json.get("messages") {
        if !msgs.is_array() {
            return Err(Refusal::new(RefusalCause::InvalidMessages));
        }
    }
    // 先确认有 model 再进规则链：缺了它连「该用哪一档」都不知道，
    // 而规则链里的 strip 对缺失字段是静默跳过的。
    if json.get("model").and_then(Value::as_str).is_none() {
        return Err(Refusal::new(RefusalCause::MissingModel));
    }

    // 怪癖一次性解析出来：规则只跟这里打交道，不再各处读裸字段。
    let quirks = provider.quirks();
    let outcome = chain::run(
        &mut json,
        &chain::Context {
            quirks,
            fold_tool_blocks: provider.fold_tool_blocks,
        },
    );

    // 去后缀之后仍可能是空串（`"[]"` 这类），上游会 400 且信息更模糊。
    if json
        .get("model")
        .and_then(Value::as_str)
        .is_none_or(|m| m.trim().is_empty())
    {
        return Err(Refusal::new(RefusalCause::MissingModel));
    }

    let changed = outcome.changed();
    let bytes = if changed {
        // 只有真改动过才重新序列化。Unchanged 路径必须保持原始字节——
        // 重新序列化会按字母序重排 key，白改一次请求（§4.4.1「逐字节一致」）。
        serde_json::to_vec(&json)
            .map_err(|e| Refusal::new(RefusalCause::InvalidJson(format!("重新序列化失败：{e}"))))?
    } else {
        raw.to_vec()
    };

    Ok(Prepared {
        bytes,
        json,
        changed,
        findings: outcome.findings,
        schema_notes: outcome.notes,
        rewrites: outcome.rewrites,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::config::Tier;

    fn provider(fold: bool) -> Provider {
        Provider {
            base_url: "https://host/apps/anthropic/v1/messages".into(),
            api_key: "sk".into(),
            fold_tool_blocks: fold,
            tiers: vec![Tier {
                tier: crate::relay::config::TierKind::Default,
                upstream_model: "qwen4-max-preview".into(),
            }],
            ..Provider::default()
        }
    }

    fn body_with_tool_block() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "model": "claude-sonnet-5-5",
            "messages": [{
                "role": "system",
                "content": [{ "type": "tool_addition", "tool": { "type": "tool_definition",
                    "definition": { "name": "web_search", "input_schema": { "type": "object" } } } }]
            }]
        }))
        .unwrap()
    }

    /// 不含 `tool_*` 块的请求必须 Unchanged，且转发字节与客户端发出的**逐字节一致**。
    #[test]
    fn plain_request_is_byte_identical() {
        let raw = serde_json::to_vec(&json!({
            "model": "claude-sonnet-5-5",
            "max_tokens": 1024,
            "messages": [{ "role": "user", "content": "hi" }]
        }))
        .unwrap();
        let prepared = sanitize(&raw, &provider(true)).expect("应通过");
        assert!(!prepared.changed, "普通请求不该被改");
        assert_eq!(prepared.bytes, raw, "必须逐字节一致");
        assert!(prepared.rewrites.is_empty());
        assert!(prepared.findings.is_empty());
    }

    #[test]
    fn tool_block_triggers_fold_and_records_finding() {
        let prepared = sanitize(&body_with_tool_block(), &provider(true)).expect("应通过");
        assert!(prepared.changed);
        assert_eq!(prepared.rewrites, vec!["fold"]);
        assert!(prepared
            .fold_summary()
            .unwrap_or_default()
            .contains("web_search"));
        // 折叠后的 body 里工具在顶层 tools
        assert_eq!(prepared.json["tools"][0]["name"], "web_search");
    }

    /// 关掉折叠时**一个字节都不改**：让上游的原始错误返回给用户。
    #[test]
    fn fold_disabled_keeps_body_untouched() {
        let raw = body_with_tool_block();
        let prepared = sanitize(&raw, &provider(false)).expect("应通过");
        assert!(!prepared.changed);
        assert_eq!(prepared.bytes, raw);
    }

    #[test]
    fn model_suffix_is_stripped_and_written_back() {
        let raw = serde_json::to_vec(&json!({
            "model": "claude-sonnet-4-5[1m]",
            "messages": [{ "role": "user", "content": "hi" }]
        }))
        .unwrap();
        let prepared = sanitize(&raw, &provider(true)).expect("应通过");
        assert!(prepared.changed);
        assert_eq!(prepared.rewrites, vec!["strip_suffix"]);
        assert_eq!(prepared.json["model"], "claude-sonnet-4-5");
    }

    #[test]
    fn clamp_applies_only_when_limit_set() {
        let raw = serde_json::to_vec(&json!({
            "model": "m",
            "max_tokens": 128000,
            "messages": [{ "role": "user", "content": "hi" }]
        }))
        .unwrap();

        // 默认不压
        let prepared = sanitize(&raw, &provider(true)).expect("应通过");
        assert!(!prepared.changed);

        let mut p = provider(true);
        p.max_tokens_limit = Some(8192);
        let prepared = sanitize(&raw, &p).expect("应通过");
        assert!(prepared.changed);
        assert_eq!(prepared.rewrites, vec!["clamp"]);
        assert_eq!(prepared.json["max_tokens"], 8192);
    }

    #[test]
    fn invalid_json_is_refused_with_readable_message() {
        let refusal = sanitize(b"{ not json", &provider(true)).unwrap_err();
        assert!(matches!(refusal.cause, RefusalCause::InvalidJson(_)));
        assert_eq!(refusal.status(), 400);
        let body = refusal.body();
        assert_eq!(body["type"], "error");
        assert_eq!(body["error"]["type"], "invalid_request_error");
        assert!(body["error"]["message"].as_str().unwrap().contains("JSON"));
    }

    #[test]
    fn missing_model_is_refused() {
        let raw = serde_json::to_vec(&json!({ "messages": [] })).unwrap();
        let refusal = sanitize(&raw, &provider(true)).unwrap_err();
        assert_eq!(refusal.cause, RefusalCause::MissingModel);
    }

    #[test]
    fn non_object_body_is_refused() {
        let refusal = sanitize(b"[1,2,3]", &provider(true)).unwrap_err();
        assert_eq!(refusal.cause, RefusalCause::NotObject);
    }

    #[test]
    fn non_array_messages_is_refused() {
        let raw = serde_json::to_vec(&json!({ "model": "m", "messages": "oops" })).unwrap();
        let refusal = sanitize(&raw, &provider(true)).unwrap_err();
        assert_eq!(refusal.cause, RefusalCause::InvalidMessages);
    }

    /// 泛化 400 不误判：非法 role 的请求我们**不碰**，原样透传，让上游自己报错。
    /// 这条是「按 provider 能力表预折叠」而非「按错误信息猜」的直接验收。
    #[test]
    fn illegal_role_is_passed_through_untouched() {
        let raw = serde_json::to_vec(&json!({
            "model": "m",
            "messages": [{ "role": "wizard", "content": "hi" }]
        }))
        .unwrap();
        let prepared = sanitize(&raw, &provider(true)).expect("应通过");
        assert!(!prepared.changed, "非法 role 不该触发折叠");
        assert_eq!(prepared.bytes, raw);
    }

    /// 确定性：同一请求两次处理，产出的字节完全一致（prompt 缓存能命中的前提）。
    #[test]
    fn sanitize_is_deterministic_across_calls() {
        let raw = body_with_tool_block();
        let a = sanitize(&raw, &provider(true)).expect("应通过");
        let b = sanitize(&raw, &provider(true)).expect("应通过");
        assert_eq!(a.bytes, b.bytes);
        assert_eq!(a.findings, b.findings);
    }

    #[test]
    fn rewrite_label_lists_all_rules() {
        let raw = serde_json::to_vec(&json!({
            "model": "claude-sonnet-4-5[1m]",
            "max_tokens": 64000,
            "messages": [{ "role": "system", "content": [
                { "type": "tool_addition", "tool": { "type": "tool_definition",
                    "definition": { "name": "T", "input_schema": { "type": "object" } } } }
            ]}]
        }))
        .unwrap();
        let mut p = provider(true);
        p.max_tokens_limit = Some(8192);
        let prepared = sanitize(&raw, &p).expect("应通过");
        assert_eq!(prepared.rewrite_label().unwrap(), "strip_suffix+clamp+fold");
    }

    /// Artifact 那类 schema：只换一个转义，转发字节里不能再出现 `\0`。
    #[test]
    fn tool_pattern_is_normalized_and_reported() {
        let raw = serde_json::to_vec(&json!({
            "model": "deepseek-v4.1-flash",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{
                "name": "Artifact",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "file_paths": { "type": "array",
                            "items": { "type": "string", "pattern": "^[^\\0]*$" } }
                    }
                }
            }]
        }))
        .unwrap();
        let prepared = sanitize(&raw, &provider(true)).expect("应通过");
        assert!(prepared.changed);
        assert_eq!(prepared.rewrites, vec!["pattern"]);
        let text = String::from_utf8(prepared.bytes.clone()).expect("仍是 UTF-8");
        assert!(
            text.contains("^[^\\\\x00]*$"),
            "转发字节里应是 \\x00：{text}"
        );
        assert!(!text.contains("\\\\0"), "不能再把 \\0 发出去：{text}");
        assert_eq!(
            prepared.schema_summary().unwrap(),
            "tools[0](Artifact).input_schema.properties.file_paths.items.pattern：\\0 → \\x00"
        );
    }

    #[test]
    fn pattern_normalization_can_be_disabled() {
        let raw = serde_json::to_vec(&json!({
            "model": "m",
            "messages": [],
            "tools": [{ "name": "T", "input_schema": { "type": "object",
                "properties": { "s": { "type": "string", "pattern": "^[^\\0]*$" } } } }]
        }))
        .unwrap();
        let mut p = provider(true);
        p.normalize_tool_patterns = Some(false);
        let prepared = sanitize(&raw, &p).expect("应通过");
        assert!(!prepared.changed, "关掉就该一个字节都不改");
        assert_eq!(prepared.bytes, raw);
        assert!(prepared.schema_summary().is_none());
    }

    /// 折叠搬进顶层 `tools` 的定义也必须被扫到——这就是 schema 归一化排在
    /// 折叠之后的原因。顺序反了这条会红。
    #[test]
    fn folded_definition_is_also_normalized() {
        let raw = serde_json::to_vec(&json!({
            "model": "m",
            "messages": [{ "role": "system", "content": [
                { "type": "tool_addition", "tool": { "type": "tool_definition",
                    "definition": { "name": "Late", "input_schema": { "type": "object",
                        "properties": { "s": { "type": "string", "pattern": "^[^\\0]*$" } } } } } }
            ]}]
        }))
        .unwrap();
        let prepared = sanitize(&raw, &provider(true)).expect("应通过");
        assert_eq!(prepared.rewrite_label().unwrap(), "fold+pattern");
        assert_eq!(
            prepared.json["tools"][0]["input_schema"]["properties"]["s"]["pattern"],
            "^[^\\x00]*$"
        );
    }
}
