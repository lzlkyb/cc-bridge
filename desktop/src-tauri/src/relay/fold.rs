//! `tool_addition` / `tool_removal` 块的折叠。
//!
//! **为什么是折叠不是剥离**（§4.4）：这两类块承载的是 ToolSearch 动态注册的工具
//! 定义。直接丢掉等于让模型看不见那些工具，它会回答"我没有这个工具"或凭空编造——
//! 请求虽然 200，行为已经错了。折叠把这些定义翻译进顶层 `tools`，模型才能正常认领。
//!
//! 三条边界，每条都对应一个真实踩过的形态：
//!
//! 1. **块出现在 `role:"system"` 的消息里**，不是 assistant。所以这里不按 role 筛。
//! 2. **`tool_addition` 有两种形态**：`tool_definition`（内联完整定义）与
//!    `tool_reference`（只有名字）。前者能折叠，后者只能在已有同名工具时不添乱。
//! 3. **被掏空的消息保留在原位并填占位文本**，不删除整条——删了会破坏 user/assistant
//!    交替，还可能让后续 `tool_result` 与它的 `tool_use` 脱钩（§4.4）。
//!
//! 这是一个纯函数：进出都是 `serde_json::Value`，不碰网络、不读配置。所有验收用例
//! 都能直接喂它，不需要起服务。

use serde_json::{json, Value};

/// 被掏空的消息用什么占位。
///
/// 不能用 `""`（上游当非法请求），也不能删整条（破坏交替）。这句是 LiteLLM 在同类
/// 场景已用的文本，语义中性、不引入新指令（§4.4）。
pub const PLACEHOLDER_TEXT: &str = "Please continue.";

/// 折叠过程中的一个发现。路径形如 `messages[3].content[0]`，与 §4.2 的日志一致。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FoldFinding {
    pub path: String,
    pub action: FoldAction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FoldAction {
    /// 工具定义并入顶层 `tools`。`replaced` 表示覆盖了同名旧定义。
    ToolMerged { name: String, replaced: bool },
    /// 从顶层 `tools` 删掉了一个名字。
    ToolRemoved { name: String },
    /// `tool_reference` 只有名字，且顶层 `tools` 里没有同名定义 → 无法折叠，块被丢弃。
    ReferenceUnresolved { name: String },
    /// 块形不成工具（缺 name 或缺定义）。块被丢弃。
    Malformed { reason: &'static str },
    /// 消息被掏空，填了占位文本。
    PlaceholderFilled,
}

/// 折叠结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FoldResult {
    /// body 是否真的被改过。`false` 时调用方**必须原样转发**（保缓存前缀）。
    pub folded: bool,
    pub findings: Vec<FoldFinding>,
}

impl FoldResult {
    /// 供日志记录的一行摘要，如 `messages[1].content[0] · merged(web_search)`。
    pub fn summary(&self) -> Option<String> {
        findings_summary(&self.findings)
    }

    /// 被折叠过的工具名（去重），日志与界面用。
    pub fn merged_names(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for f in &self.findings {
            if let FoldAction::ToolMerged { name, .. } = &f.action {
                if !out.contains(name) {
                    out.push(name.clone());
                }
            }
        }
        out
    }
}

/// 把发现列表压成一行摘要。第一个发现的路径 + 动作 + 其余处数。
pub fn findings_summary(findings: &[FoldFinding]) -> Option<String> {
    let first = findings.first()?;
    let what = match &first.action {
        FoldAction::ToolMerged { name, replaced } => {
            if *replaced {
                format!("merged({name}, 覆盖同名)")
            } else {
                format!("merged({name})")
            }
        }
        FoldAction::ToolRemoved { name } => format!("removed({name})"),
        FoldAction::ReferenceUnresolved { name } => format!("unresolved({name})"),
        FoldAction::Malformed { reason } => format!("malformed({reason})"),
        FoldAction::PlaceholderFilled => "placeholder".to_string(),
    };
    let extra = if findings.len() > 1 {
        format!(" 等 {} 处", findings.len())
    } else {
        String::new()
    };
    Some(format!("{}{extra} · {what}", first.path))
}

/// 顶层 `tools` 的工作副本。所有增删都在这里做，最后一次性写回。
struct Tools {
    /// 原始 body 里有没有 `tools` 字段。没有的话，折叠出空表时不该凭空造一个。
    existed: bool,
    items: Vec<Value>,
}

impl Tools {
    fn from_body(body: &Value) -> Self {
        let items = body
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Self {
            existed: body.get("tools").is_some(),
            items,
        }
    }

    /// 按名字并入。同名则替换（**`tool_addition` 优先于顶层旧定义**），返回是否替换。
    fn merge(&mut self, tool: Value) -> Option<(String, bool)> {
        let name = tool_name(&tool)?.to_string();
        if let Some(idx) = self.position(&name) {
            self.items[idx] = tool;
            Some((name, true))
        } else {
            self.items.push(tool);
            Some((name, false))
        }
    }

    fn remove(&mut self, name: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|t| tool_name(t) != Some(name));
        self.items.len() != before
    }

    fn position(&self, name: &str) -> Option<usize> {
        self.items.iter().position(|t| tool_name(t) == Some(name))
    }

    fn has(&self, name: &str) -> bool {
        self.position(name).is_some()
    }

    /// 写回 body。空表且原本没有 `tools` → 什么都不加；空表且原本有 → 移除字段
    /// （`tools: []` 对上游没有意义，缺字段才是「没有工具」）。
    fn write_back(self, body: &mut Value) {
        let Some(obj) = body.as_object_mut() else {
            return;
        };
        if self.items.is_empty() {
            if self.existed {
                obj.remove("tools");
            }
        } else {
            obj.insert("tools".into(), Value::Array(self.items));
        }
    }
}

/// 取一个工具对象的名字。兼容 Anthropic（`name`）与 OpenAI（`function.name`）两种形态。
fn tool_name(tool: &Value) -> Option<&str> {
    tool.get("name")
        .and_then(Value::as_str)
        .or_else(|| tool.get("function")?.get("name")?.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// 判定一个 content block 是不是 `tool_*` 变更块。
///
/// **只认这两个类型。** 上游对「未知字段」宽松、对「未知 content block 类型」严格
/// （§4.4.3 第 2 条），所以这里多认一种类型就等于多折叠一种本不该折叠的东西。
fn change_block_kind(block: &Value) -> Option<ChangeKind> {
    match block.get("type").and_then(Value::as_str) {
        Some("tool_addition") => Some(ChangeKind::Addition),
        Some("tool_removal") => Some(ChangeKind::Removal),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChangeKind {
    Addition,
    Removal,
}

/// 只读预扫描：body 里到底有没有变更块。
///
/// 先扫一遍的意义是让「不含变更块」这条最常见的路径**完全不碰 body**——不是省事，
/// 是逐字节一致的硬保证（§4.4.1）。
fn has_change_blocks(body: &Value) -> bool {
    let blocks_have_change = |arr: &Vec<Value>| arr.iter().any(|b| change_block_kind(b).is_some());

    if body
        .get("system")
        .and_then(Value::as_array)
        .is_some_and(blocks_have_change)
    {
        return true;
    }
    body.get("messages")
        .and_then(Value::as_array)
        .is_some_and(|msgs| {
            msgs.iter().any(|m| {
                m.get("content")
                    .and_then(Value::as_array)
                    .is_some_and(blocks_have_change)
            })
        })
}

/// 折叠一份请求体。
///
/// 返回值里的 `folded` 为 `false` 时，body 未被改动——调用方据此决定「逐字节原样转发」。
pub fn fold_tool_blocks(body: &mut Value) -> FoldResult {
    if !has_change_blocks(body) {
        return FoldResult::default();
    }

    let mut tools = Tools::from_body(body);
    let mut result = FoldResult::default();

    // 顶层 system（block 数组形态）。string 形态不会有变更块。
    if let Some(sys) = body.get_mut("system").and_then(Value::as_array_mut) {
        if fold_blocks(sys, "system", &mut tools, &mut result) {
            result.findings.push(FoldFinding {
                path: "system".into(),
                action: FoldAction::PlaceholderFilled,
            });
        }
    }

    // messages[*].content。**不按 role 筛**：变更块实际出现在 role:"system" 的消息里。
    if let Some(msgs) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for (idx, msg) in msgs.iter_mut().enumerate() {
            let Some(content) = msg.get_mut("content").and_then(Value::as_array_mut) else {
                continue;
            };
            let path = format!("messages[{idx}].content");
            if fold_blocks(content, &path, &mut tools, &mut result) {
                result.findings.push(FoldFinding {
                    path,
                    action: FoldAction::PlaceholderFilled,
                });
            }
        }
    }

    if result.findings.is_empty() {
        // 理论上走不到：预扫描说有变更块，处理时必然会产出发现。留着是因为
        // 「静默改了 body 却没记发现」比多一次判断更糟。
        return FoldResult::default();
    }

    tools.write_back(body);
    result.folded = true;
    result
}

/// 处理一个 content 数组，返回它是否被掏空（需要填占位）。
fn fold_blocks(
    arr: &mut Vec<Value>,
    prefix: &str,
    tools: &mut Tools,
    result: &mut FoldResult,
) -> bool {
    let mut kept: Vec<Value> = Vec::with_capacity(arr.len());
    let mut removed_any = false;

    for (i, block) in std::mem::take(arr).into_iter().enumerate() {
        let Some(kind) = change_block_kind(&block) else {
            kept.push(block);
            continue;
        };
        removed_any = true;
        let path = format!("{prefix}[{i}]");
        apply_change_block(kind, &block, &path, tools, result);
    }

    let emptied = removed_any && kept.is_empty();
    if emptied {
        kept.push(json!({ "type": "text", "text": PLACEHOLDER_TEXT }));
    }
    *arr = kept;
    emptied
}

/// `tool_removal` 的目标名：可能是 `tool_reference`（name 在块上）、
/// `tool_definition`（name 在 definition 里），或直接铺开的工具对象。
fn removal_name(payload: &Value) -> Option<&str> {
    payload
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| payload.get("definition").and_then(tool_name))
        .or_else(|| tool_name(payload))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn reference_name(payload: &Value) -> Option<&str> {
    payload
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// 按块类型执行合并 / 删除。
fn apply_change_block(
    kind: ChangeKind,
    block: &Value,
    path: &str,
    tools: &mut Tools,
    result: &mut FoldResult,
) {
    // 块的形态有两种：`{"tool": {...}}`（文档给的）与定义直接铺在块上。
    let payload = block.get("tool").unwrap_or(block);
    let mut push = |action: FoldAction| {
        result.findings.push(FoldFinding {
            path: path.to_string(),
            action,
        })
    };

    match kind {
        ChangeKind::Addition => match payload.get("type").and_then(Value::as_str) {
            // 内联完整定义：直接并进 tools
            Some("tool_definition") => match payload.get("definition") {
                None => push(FoldAction::Malformed {
                    reason: "tool_definition 缺 definition",
                }),
                Some(def) => match tools.merge(def.clone()) {
                    Some((name, replaced)) => push(FoldAction::ToolMerged { name, replaced }),
                    None => push(FoldAction::Malformed {
                        reason: "definition 缺 name",
                    }),
                },
            },
            // 只有名字：定义得已经在 tools 里。没有就折叠不出来，块丢弃并记发现。
            Some("tool_reference") => match reference_name(payload) {
                Some(name) if tools.has(name) => push(FoldAction::ToolMerged {
                    name: name.to_string(),
                    replaced: false,
                }),
                Some(name) => push(FoldAction::ReferenceUnresolved {
                    name: name.to_string(),
                }),
                None => push(FoldAction::Malformed {
                    reason: "tool_reference 缺 name",
                }),
            },
            // 没写 type：把 payload 当完整工具定义试一次（宽容一档，不猜语义）
            _ => match tools.merge(payload.clone()) {
                Some((name, replaced)) => push(FoldAction::ToolMerged { name, replaced }),
                None => push(FoldAction::Malformed {
                    reason: "tool_addition 无法识别",
                }),
            },
        },
        ChangeKind::Removal => match removal_name(payload) {
            Some(name) => {
                if tools.remove(name) {
                    push(FoldAction::ToolRemoved {
                        name: name.to_string(),
                    });
                } else {
                    // 删一个本来就没有的工具：无害，记下来便于对齐远端配置。
                    push(FoldAction::ReferenceUnresolved {
                        name: name.to_string(),
                    });
                }
            }
            None => push(FoldAction::Malformed {
                reason: "tool_removal 缺 name",
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 折叠后必须能从顶层 tools 里找到那个工具——这是「不丢信息」的直接断言。
    fn tool_names(body: &Value) -> Vec<String> {
        body.get("tools")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(tool_name)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn text_of(msg: &Value) -> Vec<String> {
        msg.get("content")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| b.get("text").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn request_without_change_blocks_is_byte_identical() {
        // 不含 tool_* 块的请求必须 Unchanged —— 保缓存前缀的第一条保证。
        let mut body = json!({
            "model": "claude-sonnet-5-5",
            "max_tokens": 1024,
            "messages": [{ "role": "user", "content": "你好" }],
            "tools": [{ "name": "Read", "input_schema": { "type": "object" } }]
        });
        let before = serde_json::to_string(&body).unwrap();
        let result = fold_tool_blocks(&mut body);
        assert!(!result.folded, "不应改动");
        assert_eq!(serde_json::to_string(&body).unwrap(), before);
        assert!(result.findings.is_empty());
    }

    #[test]
    fn tool_definition_is_merged_into_top_level_tools() {
        let mut body = json!({
            "model": "m",
            "messages": [{
                "role": "system",
                "content": [
                    { "type": "text", "text": "记一下这些工具" },
                    { "type": "tool_addition", "tool": {
                        "type": "tool_definition",
                        "definition": {
                            "name": "web_search",
                            "description": "搜网",
                            "input_schema": { "type": "object", "properties": { "q": { "type": "string" } } }
                        }
                    }}
                ]
            }]
        });
        let result = fold_tool_blocks(&mut body);
        assert!(result.folded);
        assert_eq!(tool_names(&body), vec!["web_search"]);
        // 块被丢弃，文本块保留
        assert_eq!(text_of(&body["messages"][0]), vec!["记一下这些工具"]);
        // 定义完整搬过来了，不是只剩名字
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    }

    #[test]
    fn tool_reference_block_is_dropped_when_definition_already_present() {
        // 两种形态都要覆盖：reference 只带名字，定义已经在 tools 里就不添乱。
        let mut body = json!({
            "model": "m",
            "tools": [{ "name": "Grep", "input_schema": { "type": "object" } }],
            "messages": [{
                "role": "system",
                "content": [{ "type": "tool_addition", "tool": { "type": "tool_reference", "name": "Grep" } }]
            }]
        });
        let result = fold_tool_blocks(&mut body);
        assert!(result.folded);
        assert_eq!(tool_names(&body), vec!["Grep"]);
        // 消息被掏空 → 占位文本
        assert_eq!(text_of(&body["messages"][0]), vec![PLACEHOLDER_TEXT]);
    }

    #[test]
    fn unresolved_reference_is_reported_not_silently_swallowed() {
        let mut body = json!({
            "model": "m",
            "messages": [{
                "role": "system",
                "content": [{ "type": "tool_addition", "tool": { "type": "tool_reference", "name": "Ghost" } }]
            }]
        });
        let result = fold_tool_blocks(&mut body);
        assert!(result.folded);
        assert!(result.findings.iter().any(|f| matches!(
            &f.action,
            FoldAction::ReferenceUnresolved { name } if name == "Ghost"
        )));
        assert!(body.get("tools").is_none(), "不该凭空造一个空 tools");
    }

    #[test]
    fn emptied_message_keeps_position_and_placeholder() {
        // 一条消息只有 tool_addition 块 → 折叠后保留在原位、内容为 Please continue.
        let mut body = json!({
            "model": "m",
            "messages": [
                { "role": "user", "content": "第一句" },
                { "role": "system", "content": [
                    { "type": "tool_addition", "tool": { "type": "tool_definition",
                        "definition": { "name": "T", "input_schema": { "type": "object" } } } }
                ]},
                { "role": "assistant", "content": "第二句" }
            ]
        });
        fold_tool_blocks(&mut body);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3, "不能删整条消息");
        assert_eq!(msgs[1]["role"], "system", "原位保留");
        assert_eq!(text_of(&msgs[1]), vec![PLACEHOLDER_TEXT]);
        // 交替关系没被破坏
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[2]["role"], "assistant");
    }

    #[test]
    fn duplicate_tool_name_is_overridden_by_addition() {
        // 顶层已有同名项、tool_addition 定义不同 → 以 tool_addition 为准，去重后一项。
        let mut body = json!({
            "model": "m",
            "tools": [{ "name": "Read", "description": "旧定义", "input_schema": { "type": "object" } }],
            "messages": [{
                "role": "system",
                "content": [{ "type": "tool_addition", "tool": { "type": "tool_definition",
                    "definition": { "name": "Read", "description": "新定义", "input_schema": { "type": "object" } } } }]
            }]
        });
        fold_tool_blocks(&mut body);
        assert_eq!(tool_names(&body), vec!["Read"], "去重后只有一项");
        assert_eq!(body["tools"][0]["description"], "新定义");
    }

    #[test]
    fn tool_removal_drops_the_name_from_tools() {
        let mut body = json!({
            "model": "m",
            "tools": [
                { "name": "Read", "input_schema": { "type": "object" } },
                { "name": "Write", "input_schema": { "type": "object" } }
            ],
            "messages": [{
                "role": "system",
                "content": [{ "type": "tool_removal", "tool": { "type": "tool_reference", "name": "Read" } }]
            }]
        });
        fold_tool_blocks(&mut body);
        assert_eq!(tool_names(&body), vec!["Write"]);
        assert_eq!(text_of(&body["messages"][0]), vec![PLACEHOLDER_TEXT]);
    }

    #[test]
    fn addition_and_removal_in_same_message_applied_in_order() {
        let mut body = json!({
            "model": "m",
            "tools": [{ "name": "Old", "input_schema": { "type": "object" } }],
            "messages": [{
                "role": "system",
                "content": [
                    { "type": "tool_removal", "tool": { "type": "tool_reference", "name": "Old" } },
                    { "type": "tool_addition", "tool": { "type": "tool_definition",
                        "definition": { "name": "New", "input_schema": { "type": "object" } } } }
                ]
            }]
        });
        fold_tool_blocks(&mut body);
        assert_eq!(tool_names(&body), vec!["New"]);
    }

    #[test]
    fn non_change_blocks_are_untouched() {
        // tool_use / tool_result / thinking 一律保留，只有 tool_* 变更块被处理。
        let mut body = json!({
            "model": "m",
            "messages": [
                { "role": "assistant", "content": [
                    { "type": "thinking", "thinking": "想一想" },
                    { "type": "tool_use", "id": "tu_1", "name": "Read", "input": {} }
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "tu_1", "content": "内容" },
                    { "type": "text", "text": "继续" }
                ]}
            ]
        });
        let before = serde_json::to_string(&body).unwrap();
        let result = fold_tool_blocks(&mut body);
        assert!(!result.folded);
        assert_eq!(serde_json::to_string(&body).unwrap(), before);
    }

    #[test]
    fn system_string_form_is_left_alone() {
        // system 是字符串时不会有变更块，不能被误判成数组处理。
        let mut body = json!({
            "model": "m",
            "system": "你是助手",
            "messages": [{ "role": "user", "content": "hi" }]
        });
        let result = fold_tool_blocks(&mut body);
        assert!(!result.folded);
        assert_eq!(body["system"], "你是助手");
    }

    #[test]
    fn findings_carry_json_path() {
        let mut body = json!({
            "model": "m",
            "messages": [
                { "role": "user", "content": "x" },
                { "role": "system", "content": [
                    { "type": "text", "text": "a" },
                    { "type": "tool_addition", "tool": { "type": "tool_definition",
                        "definition": { "name": "T", "input_schema": { "type": "object" } } } }
                ]}
            ]
        });
        let result = fold_tool_blocks(&mut body);
        let merged = result
            .findings
            .iter()
            .find(|f| matches!(f.action, FoldAction::ToolMerged { .. }))
            .expect("应有合并发现");
        assert_eq!(merged.path, "messages[1].content[1]");
    }

    #[test]
    fn malformed_definition_is_reported() {
        let mut body = json!({
            "model": "m",
            "messages": [{
                "role": "system",
                "content": [{ "type": "tool_addition", "tool": { "type": "tool_definition", "definition": { "description": "没有名字" } } }]
            }]
        });
        let result = fold_tool_blocks(&mut body);
        assert!(result
            .findings
            .iter()
            .any(|f| matches!(f.action, FoldAction::Malformed { .. })));
        // 仍然不删消息
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn openai_style_function_name_is_recognised() {
        // P3 会用到；这里先保证去重不会因为形态不同而漏掉同名工具。
        let mut body = json!({
            "model": "m",
            "tools": [{ "type": "function", "function": { "name": "Read" } }],
            "messages": [{
                "role": "system",
                "content": [{ "type": "tool_removal", "tool": { "type": "tool_reference", "name": "Read" } }]
            }]
        });
        fold_tool_blocks(&mut body);
        assert!(body.get("tools").is_none(), "删空后应移除 tools 字段");
    }

    #[test]
    fn summary_names_the_merged_tool() {
        let mut body = json!({
            "model": "m",
            "messages": [{
                "role": "system",
                "content": [{ "type": "tool_addition", "tool": { "type": "tool_definition",
                    "definition": { "name": "web_search", "input_schema": { "type": "object" } } } }]
            }]
        });
        let result = fold_tool_blocks(&mut body);
        let summary = result.summary().expect("应有摘要");
        assert!(summary.contains("web_search"), "{summary}");
        assert_eq!(result.merged_names(), vec!["web_search"]);
    }
}
