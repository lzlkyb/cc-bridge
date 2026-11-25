//! 规则链：把「按顺序改请求体」变成一张可装配的表。
//!
//! 之前 `sanitize` 里是一串写死的 `if`，加一条规则要动主流程、动 `Prepared`、
//! 动前端徽章的映射。这里的形状是：一条规则一个类型，声明「我什么时候该跑」
//! 和「我怎么改」，顺序由 [`ORDER`] 决定。
//!
//! 加一条规则 = 写一个 `impl Rule` + 在 `ORDER` 里插一行。`sanitize` 与界面
//! 的改写徽章都不用改（徽章读的是规则自己报的名字）。
//!
//! **顺序本身是设计的一部分**，五点都在测试里钉着：
//!
//! 1. 去后缀必须最先——路由靠档位映射名精确匹配，带 `[1m]` 会漏。
//! 2. 剥 thinking 紧随其后——它只删消息内容块，早删一步，后面 fold 报的
//!    `messages[i].content[j]` 路径才与最终 body 对得上（先 fold 再删，j 就错位了）。
//! 3. 折叠必须在 schema 归一化之前——`tool_addition` 里的工具定义要到折叠时
//!    才并进顶层 `tools`，先扫就扫不到。
//! 4. clamp 在折叠前：它只碰 `max_tokens`，位置其实无关，但固定下来能避免
//!    以后有人把它挪到 fold 后面时，findings 路径与最终 body 对不上。
//! 5. schema 归一化最后：它对 `tools` 的**最终形态**做处理。
//!
//! 关于「影子模式」：方案里曾计划新旧两套实现并行跑、比对结果。落地时改成
//! **用测试钉等价性**——现有测试已经逐字节断言了输出、rewrites 顺序与 finding
//! 内容，比生产日志比对更严格，也不会为每个请求多遍历一遍几十 KB 的 body。

use serde_json::Value;

use super::fold::{self, FoldFinding};
use super::profile::{Quirks, Thinking};
use super::{repair, rules, schema};

/// 规则运行时能看到的东西。**只有这里的内容会影响规则是否执行**。
pub struct Context {
    pub quirks: Quirks,
    /// 与 `quirks` 分开：折叠不是厂商差异，是产品决策（默认开、可关）。
    pub fold_tool_blocks: bool,
}

/// 一次清洗的产出。
#[derive(Default, Debug)]
pub struct Outcome {
    /// 触发过的规则名，按执行顺序。日志/界面的「改写」列直接用它。
    pub rewrites: Vec<&'static str>,
    pub findings: Vec<FoldFinding>,
    /// schema 归一化这类「只换写法、不动结构」的说明。
    pub notes: Vec<String>,
}

impl Outcome {
    pub fn changed(&self) -> bool {
        !self.rewrites.is_empty()
    }
}

trait Rule {
    fn name(&self) -> &'static str;
    /// 是否该跑。返回值只看 `Context`，不读 body——「按能力表预折叠」而不是
    /// 「按错误信息猜」，这是整套清洗能保持确定性的前提。
    fn applies(&self, ctx: &Context) -> bool;
    /// 跑一次。返回是否真的改动了 body。`ctx` 再传一次，是因为规则的**参数**
    /// （上限、开关）都在里面，让规则自己拿结构体存一份只会多一处可能过期的副本。
    fn apply(&self, body: &mut Value, ctx: &Context, out: &mut Outcome) -> bool;
}

/// 去客户端私有后缀（`claude-sonnet-4-5[1m]` → `claude-sonnet-4-5`）。
struct StripSuffix;

impl Rule for StripSuffix {
    fn name(&self) -> &'static str {
        "strip_suffix"
    }

    fn applies(&self, _: &Context) -> bool {
        true
    }

    fn apply(&self, body: &mut Value, _: &Context, _: &mut Outcome) -> bool {
        let Some(model) = body.get("model").and_then(Value::as_str) else {
            return false;
        };
        let (stripped, changed) = rules::strip_model_suffix(model);
        if changed {
            body["model"] = Value::String(stripped);
        }
        changed
    }
}

/// 剥掉跨厂商不通用的 `thinking` 块（含顶层开关）。
///
/// 与 `repair` 里的同名修复共用一份实现：一个是「按能力表预清理」，一个是
/// 「400 之后补救」，两者对「什么算 thinking」必须完全一致。
struct StripThinking;

impl Rule for StripThinking {
    fn name(&self) -> &'static str {
        "thinking"
    }

    fn applies(&self, ctx: &Context) -> bool {
        ctx.quirks.thinking == Thinking::Strip
    }

    fn apply(&self, body: &mut Value, _: &Context, _: &mut Outcome) -> bool {
        repair::strip_thinking(body)
    }
}

/// 把 `max_tokens` 压到画像/用户给的上限。
struct ClampMaxTokens;

impl Rule for ClampMaxTokens {
    fn name(&self) -> &'static str {
        "clamp"
    }

    fn applies(&self, ctx: &Context) -> bool {
        ctx.quirks.clamp_max_tokens.is_some()
    }

    fn apply(&self, body: &mut Value, ctx: &Context, _: &mut Outcome) -> bool {
        rules::clamp_max_tokens(body, ctx.quirks.clamp_max_tokens).is_some()
    }
}

/// 折叠 `tool_*` 变更块。上游不接受这类块，所以并进顶层 `tools`。
struct FoldToolBlocks;

impl Rule for FoldToolBlocks {
    fn name(&self) -> &'static str {
        "fold"
    }

    fn applies(&self, ctx: &Context) -> bool {
        ctx.fold_tool_blocks
    }

    fn apply(&self, body: &mut Value, _: &Context, out: &mut Outcome) -> bool {
        let result = fold::fold_tool_blocks(body);
        out.findings.extend(result.findings);
        result.folded
    }
}

/// 工具 schema 里的 `\0` → `\x00`。
struct NormalizePatterns;

impl Rule for NormalizePatterns {
    fn name(&self) -> &'static str {
        "pattern"
    }

    fn applies(&self, ctx: &Context) -> bool {
        ctx.quirks.normalize_null_escape
    }

    fn apply(&self, body: &mut Value, _: &Context, out: &mut Outcome) -> bool {
        let notes = schema::normalize_null_escapes(body);
        let changed = !notes.is_empty();
        out.notes.extend(notes);
        changed
    }
}

const STRIP: StripSuffix = StripSuffix;
const THINKING: StripThinking = StripThinking;
const CLAMP: ClampMaxTokens = ClampMaxTokens;
const FOLD: FoldToolBlocks = FoldToolBlocks;
const PATTERNS: NormalizePatterns = NormalizePatterns;

/// 执行顺序。**加规则改这里，不要改 `run`。**
const ORDER: [&dyn Rule; 5] = [&STRIP, &THINKING, &CLAMP, &FOLD, &PATTERNS];

/// 按 [`ORDER`] 跑一遍。返回的 `Outcome.rewrites` 与执行顺序一致。
pub fn run(body: &mut Value, ctx: &Context) -> Outcome {
    let mut out = Outcome::default();
    for rule in ORDER {
        if !rule.applies(ctx) {
            continue;
        }
        if rule.apply(body, ctx, &mut out) {
            out.rewrites.push(rule.name());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> Context {
        Context {
            quirks: Quirks::DEFAULT,
            fold_tool_blocks: true,
        }
    }

    fn tool_block_body() -> Value {
        json!({
            "model": "claude-sonnet-4-5[1m]",
            "messages": [{ "role": "system", "content": [
                { "type": "tool_addition", "tool": { "type": "tool_definition",
                    "definition": { "name": "T", "input_schema": { "type": "object",
                        "properties": { "s": { "type": "string", "pattern": "^[^\\0]*$" } } } } } }
            ]}]
        })
    }

    #[test]
    fn rules_run_in_declared_order() {
        let mut body = tool_block_body();
        let out = run(&mut body, &ctx());
        assert_eq!(out.rewrites, vec!["strip_suffix", "fold", "pattern"]);
        assert_eq!(body["model"], "claude-sonnet-4-5");
    }

    /// 折叠把定义搬进顶层 tools 之后，schema 归一化还能扫到它。
    /// 顺序反过来这条会红——这就是「顺序是设计」的验收。
    #[test]
    fn folded_definition_is_normalized() {
        let mut body = tool_block_body();
        let out = run(&mut body, &ctx());
        assert_eq!(
            body["tools"][0]["input_schema"]["properties"]["s"]["pattern"],
            "^[^\\x00]*$"
        );
        assert_eq!(out.notes.len(), 1);
    }

    #[test]
    fn disabled_rules_do_not_run() {
        let mut body = tool_block_body();
        let out = run(
            &mut body,
            &Context {
                quirks: Quirks {
                    normalize_null_escape: false,
                    ..Quirks::DEFAULT
                },
                fold_tool_blocks: false,
            },
        );
        assert_eq!(out.rewrites, vec!["strip_suffix"]);
        assert!(out.notes.is_empty());
        assert!(out.findings.is_empty());
    }

    #[test]
    fn clamp_only_reports_when_it_actually_clamps() {
        let mut body = json!({ "model": "m", "max_tokens": 100 });
        let out = run(
            &mut body,
            &Context {
                quirks: Quirks {
                    clamp_max_tokens: Some(8192),
                    ..Quirks::DEFAULT
                },
                ..ctx()
            },
        );
        // 100 < 8192，没改就不该报 clamp
        assert!(out.rewrites.is_empty(), "没改就不该报：{:?}", out.rewrites);
        assert_eq!(body["max_tokens"], 100);
    }

    /// 同一份 body 跑两遍，第二遍必须什么都不报（幂等）。
    #[test]
    fn second_run_is_a_noop() {
        let mut body = tool_block_body();
        let first = run(&mut body, &ctx());
        assert!(first.changed());
        let second = run(&mut body, &ctx());
        assert!(!second.changed(), "第二遍不该再改：{:?}", second.rewrites);
    }

    fn thinking_body() -> Value {
        json!({
            "model": "m",
            "thinking": { "type": "enabled", "budget_tokens": 1024 },
            "messages": [{ "role": "assistant", "content": [
                { "type": "thinking", "thinking": "…", "signature": "sig" },
                { "type": "text", "text": "hi" }
            ]}]
        })
    }

    /// 画像没标 `Strip` 时，「thinking」这个词进不了 rewrites：默认必须逐字节不动。
    #[test]
    fn thinking_is_kept_unless_the_profile_strips_it() {
        let mut body = thinking_body();
        let original = body.clone();
        let out = run(&mut body, &ctx());
        assert!(out.rewrites.is_empty(), "{:?}", out.rewrites);
        assert_eq!(body, original, "Passthrough 下不能动任何东西");
    }

    #[test]
    fn thinking_is_stripped_when_the_profile_says_so() {
        let mut body = thinking_body();
        let out = run(
            &mut body,
            &Context {
                quirks: Quirks {
                    thinking: Thinking::Strip,
                    ..Quirks::DEFAULT
                },
                fold_tool_blocks: false,
            },
        );
        assert_eq!(out.rewrites, vec!["thinking"]);
        assert!(body.get("thinking").is_none(), "顶层开关也要删");
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
    }

    /// 顺序守卫：thinking 先删，fold 报的 `content[j]` 才与最终 body 对得上。
    ///
    /// fold 用的是**遍历时的原始索引**。thinking 块留在前面，工具块就是 `[1]`，
    /// 而删块之后它在 body 里已经是 `[0]`——路径就指向了不存在的块。
    #[test]
    fn thinking_is_stripped_before_fold_reports_paths() {
        let mut body = json!({
            "model": "m",
            "messages": [{ "role": "assistant", "content": [
                { "type": "thinking", "thinking": "…", "signature": "sig" },
                { "type": "tool_addition", "tool": { "type": "tool_definition",
                    "definition": { "name": "T", "input_schema": { "type": "object" } } } }
            ]}]
        });
        let out = run(
            &mut body,
            &Context {
                quirks: Quirks {
                    thinking: Thinking::Strip,
                    normalize_null_escape: false,
                    ..Quirks::DEFAULT
                },
                fold_tool_blocks: true,
            },
        );
        assert_eq!(out.rewrites, vec!["thinking", "fold"]);
        let paths: Vec<&str> = out.findings.iter().map(|f| f.path.as_str()).collect();
        // 第二条是「掏空后填占位」，指向整个 content 数组而不是某个块。
        assert_eq!(
            paths,
            vec!["messages[0].content[0]", "messages[0].content"],
            "路径要指向最终 body"
        );
        // 折叠把变更块取走后 content 被掏空，填了占位文本。
        assert_eq!(body["messages"][0]["content"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["content"][0]["type"], "text");
        assert!(body["tools"].is_array(), "定义应已并入 tools");
    }
}
