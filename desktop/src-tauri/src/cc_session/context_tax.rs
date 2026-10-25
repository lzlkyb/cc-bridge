//! 上下文税仪表（批 4-1）：把「这一屏上下文被什么吃掉」算出来。
//!
//! ## 为什么叫「税」而不是「用量」
//!
//! 设置页的 `TokenUsageReport` 回答的是「我这几天花了多少」，是按天/按工具的账。
//! 这里回答的是另一个问题：**当前这条会话的上下文窗口，是被哪些调用占住的**。
//! 工具结果一旦进了上下文就一直占着（不是每轮清零），所以它们像是永久性开支。
//!
//! ## 口径：三层，不是一个数
//!
//! ```text
//! 当前上下文占用（前端 `contextBar(used)`，与批 2-1 同源）
//! ├─ 工具结果（经桥）    ← 本模块算出来的
//! └─ 其他                ← used − 工具结果（前端算）
//! ```
//!
//! 「其他」= 系统提示 + 对话正文 + CC **内置**工具（Read/Bash/Grep 不走桥）。
//! 必须显式给这一档：只报工具那一块，用户会问「工具才 8K，那 40K 哪来的」。
//!
//! 🔴 **不做「本轮」**：审计条目只有 `ccSessionId`、没有轮次号，精确到轮次得给
//! `CcSession` 加计数器并改日志字段。而 `used` 是累计值、工具结果也是累计占用，
//! 两者天然对齐 —— 硬切「本轮」反而会造出「本轮工具 2K、上下文 40K」这种没法解释的组合。
//!
//! ## 与 `read_usage_report` 的关系
//!
//! 同一个 `audit.log`、同一份 `AUDIT_CACHE`、同一个 `est_tokens`，**不新增扫描**。
//! 区别只是过滤维度：那边按天/按工具，这边按 `ccSessionId`。
//! 批 2-6 已定死「工具账 ≈ 对话账的子集，不能相加」，本模块不破坏这条：它只是把
//! 已有两个数摆进同一张分解里。

use std::path::Path;

use serde::Serialize;

use crate::audit::{self, AuditEntry};

/// 客户端分档线（**字符**）：越过就**整条降级成 2KB 预览** ——
/// 模型当轮看不到内容，也不会回读。实测见
/// `docs/上下文消耗优化方案-2026-10-22.md`（≤49,823 原样、52,116B 只剩前 2KB）。
///
/// 🔴 这个数与 `mcp/tools/mod.rs::MAX_INLINE_CHARS`（45,000）是**两个不同的阈值**，
/// 别合并：45,000 是我们自己主动裁剪到的线（结果完整到达，只是尾部被截），
/// 49,823 是客户端替我们做的降级（内容根本看不见）。前者是止损，后者是事故。
pub const CLIENT_DROP_CHARS: u64 = 49_823;

/// 我们自己的裁剪线（同源：`mcp::tools::MAX_INLINE_CHARS`，直接引用防漂移）。
pub const TOOL_INLINE_CHARS: u64 = crate::mcp::tools::MAX_INLINE_CHARS as u64;

/// 工具榜最多列几个。再多浮层就比消息区还高了。
const MAX_TOOLS: usize = 12;

/// 越线条目最多列几条。列表本身只是「举证」，不需要把 50 条全铺出来。
const MAX_HITS: usize = 20;

/// 一条会话的上下文构成。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextTax {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// 归属到这条会话的调用次数（含 batch 容器）。
    pub calls: u64,
    /// 工具结果合计（字节，**不含** batch 容器 —— 见 `aggregate` 里的说明）。
    #[serde(rename = "resultBytes")]
    pub result_bytes: u64,
    /// 估算 token（`result_bytes / 4`，与 `audit::est_tokens` 同源）。
    ///
    /// 🔴 **只算结果、不含入参**：面板上「工具结果」那一行要能等于下面各工具行之和，
    /// 而入参（`params_bytes`）是另一件事（模型自己写出来的工具调用参数），
    /// 混进来会让两处数字对不上，用户会以为算错了。
    #[serde(rename = "estTokens")]
    pub est_tokens: u64,
    /// 入参合计（字节）。不在主分解里显示，只进 tooltip —— 量级通常只有结果的零头。
    #[serde(rename = "paramsBytes")]
    pub params_bytes: u64,
    /// 按结果字节倒序，最多 [`MAX_TOOLS`] 条。
    pub tools: Vec<ContextTaxTool>,
    /// 单次结果的 wire 字符数 ≥ [`TOOL_INLINE_CHARS`] 的条目，倒序，最多 [`MAX_HITS`] 条。
    pub oversized: Vec<ContextTaxHit>,
    /// 越线条目**总数**（`oversized` 只是截断后的展示）。
    #[serde(rename = "oversizedTotal")]
    pub oversized_total: u64,
    /// 其中「确定已越过客户端降级线」的条数（wire 字符 ≥ [`CLIENT_DROP_CHARS`]）。
    #[serde(rename = "droppedTotal")]
    pub dropped_total: u64,
    /// 老日志里没有 `resultChars` 的条目数 —— 这些只能按字节判，
    /// 中文内容会偏高。前端要据此说明口径（`> 0` 时不能把告警说成绝对事实）。
    #[serde(rename = "charlessCalls")]
    pub charless_calls: u64,
}

/// 单个工具的构成。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextTaxTool {
    pub tool: String,
    pub calls: u64,
    #[serde(rename = "resultBytes")]
    pub result_bytes: u64,
    #[serde(rename = "estTokens")]
    pub est_tokens: u64,
    /// 这个工具里最大的一次 wire 字符数（前端据此给行标黄）。
    #[serde(rename = "maxChars")]
    pub max_chars: u64,
}

/// 一条越线的调用（告警区的举证行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextTaxHit {
    pub tool: String,
    /// 从 `params` 里认出来的目标（路径 / 命令），给用户认「是哪一次」。
    pub target: String,
    #[serde(rename = "resultBytes")]
    pub result_bytes: u64,
    /// wire 字符数（判定用的那个数）。
    #[serde(rename = "wireChars")]
    pub wire_chars: u64,
    pub timestamp: String,
}

/// 算一条会话的上下文构成。
///
/// `session_id` 是 **CC 的** session id（`system/init` 给的，也就是 `ccSessionId` 审计字段），
/// 不是 cc-bridge 内部那个 `meta.sessionId`。两者混用会永远查到 0 条。
///
/// 空 id 直接返回空结构：新会话还没 `Init`，前端不该发这个请求（发了也什么都查不到）。
pub fn context_tax(data_dir: &Path, session_id: &str) -> Result<ContextTax, String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Ok(ContextTax::default());
    }
    audit::with_cached_entries(data_dir, |all| aggregate(all, &sid))
}

/// 纯聚合（不碰 IO，便于单测）。
fn aggregate(all: &[AuditEntry], sid: &str) -> ContextTax {
    let mut out = ContextTax {
        session_id: sid.to_string(),
        ..ContextTax::default()
    };
    // tool → [calls, result_bytes, max_chars]
    let mut tools: std::collections::HashMap<&str, [u64; 3]> = std::collections::HashMap::new();
    let mut hits: Vec<ContextTaxHit> = Vec::new();

    for e in all {
        // 归属：只有 `turn_active` 期间发起、由这条对话引起的调用才带这个字段。
        // 轮次之间从别的客户端来的调用不计入任何会话（与 `read_usage_report` 同口径）。
        if e.cc_session_id.as_deref() != Some(sid) {
            continue;
        }
        out.calls += 1;

        // 🔴 batch 是**容器**：返回体裹着全部子结果，而 `batch.rs` 已为每条子操作
        // 单独落了审计（各自带真实的 resultBytes/resultChars）。外层若再计一次，
        // 同一次调用会被记两遍 —— 这条判据与 `aggregate_usage` 必须一致，
        // 两边只要有一边走偏，同一个会话在设置页与本面板上的数字就对不上。
        if audit::is_batch_container(&e.tool) {
            continue;
        }

        let rb = e.result_bytes.unwrap_or(0);
        // 🔴 `u64::MAX` 是 `wire_chars` 的「量不出来」哨兵，不是字符数。它曾被原样写进
        // 日志（`Some(wire_chars(..) as u64)` 那版），读到就必须按未知处理——否则面板上
        // 会出现一条 1.8e19 字符的「降级举证」。写入端已改用 `wire_chars_opt`，
        // 但日志是只追加的历史，读端不能假设写它的一定是新版本。
        let measured = e.result_chars.filter(|c| *c != u64::MAX);
        let chars = match (measured, e.result_bytes) {
            (Some(c), _) => c,
            (None, Some(b)) => {
                // 没有可用的字符数（老日志 / 哨兵）：退回字节（纯 ASCII 等价，中文偏高 ——
                // 宁可早点提醒「这条很贵」，也不要漏掉真的被降级的那次）。
                out.charless_calls += 1;
                b
            }
            (None, None) => 0,
        };

        out.result_bytes += rb;
        out.params_bytes += e.params.len() as u64;

        let t = tools.entry(e.tool.as_str()).or_insert([0, 0, 0]);
        t[0] += 1;
        t[1] += rb;
        t[2] = t[2].max(chars);

        if chars >= TOOL_INLINE_CHARS {
            out.oversized_total += 1;
            if chars >= CLIENT_DROP_CHARS {
                out.dropped_total += 1;
            }
            hits.push(ContextTaxHit {
                tool: e.tool.clone(),
                target: target_of(&e.params),
                result_bytes: rb,
                wire_chars: chars,
                timestamp: e.timestamp.clone(),
            });
        }
    }

    out.est_tokens = audit::est_tokens(out.result_bytes);

    let mut rows: Vec<ContextTaxTool> = tools
        .into_iter()
        .map(|(tool, c)| ContextTaxTool {
            tool: tool.to_string(),
            calls: c[0],
            result_bytes: c[1],
            est_tokens: audit::est_tokens(c[1]),
            max_chars: c[2],
        })
        .collect();
    // 按结果字节降序；同量按名字，保证同一份日志每次渲染顺序一致（不然浮层会跳）。
    rows.sort_by(|a, b| {
        b.result_bytes
            .cmp(&a.result_bytes)
            .then_with(|| a.tool.cmp(&b.tool))
    });
    rows.truncate(MAX_TOOLS);
    out.tools = rows;

    hits.sort_by_key(|h| std::cmp::Reverse(h.wire_chars));
    hits.truncate(MAX_HITS);
    out.oversized = hits;

    out
}

/// 从审计的 `params`（请求参数 JSON 全文）里认出「这次动的是什么东西」。
///
/// 认不出来不是错误：`params` 也可能是非 JSON（老版本/异常路径），
/// 那时退回前 60 字 —— 展示层只需要一个「能认出来是谁」的短串。
fn target_of(params: &str) -> String {
    // 键名按出现频率排：写/读类工具用 path，命令类用 command，搜索类用 pattern。
    const KEYS: [&str; 9] = [
        "path",
        "file",
        "filePath",
        "file_path",
        "target",
        "command",
        "pattern",
        "dir",
        "root",
    ];
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(params) {
        for k in KEYS {
            if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
                if !s.trim().is_empty() {
                    return head(s, 72);
                }
            }
        }
        if let Some(arr) = v.get("paths").and_then(|x| x.as_array()) {
            if let Some(first) = arr.first().and_then(|x| x.as_str()) {
                let mut s = head(first, 72);
                if arr.len() > 1 {
                    s.push_str(&format!(" 等 {} 个", arr.len()));
                }
                return s;
            }
        }
    }
    head(params, 60)
}

/// 按**字符**截断（不是字节 —— 按字节切会把中文劈成半个，`String` 会 panic）。
fn head(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        return t.to_string();
    }
    let mut out: String = t.chars().take(n).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::AuditEntry;

    /// 造一条审计条目。只有本模块关心的字段有值，其余留空/None。
    fn entry(tool: &str, session: Option<&str>, params: &str, bytes: Option<u64>) -> AuditEntry {
        AuditEntry {
            timestamp: "2026-10-25T12:00:00+08:00".into(),
            tool: tool.into(),
            params: params.into(),
            success: true,
            error: None,
            source_ip: None,
            duration_ms: None,
            server_ms: None,
            io_ms: None,
            audit_ms: None,
            net_ms: None,
            overhead_ms: None,
            session_id: None,
            cc_session_id: session.map(str::to_string),
            backup_path: None,
            target_path: None,
            result_bytes: bytes,
            result_chars: bytes,
        }
    }

    /// 老日志：有 resultBytes、没有 resultChars。
    fn legacy(tool: &str, session: &str, bytes: u64) -> AuditEntry {
        AuditEntry {
            result_chars: None,
            ..entry(tool, Some(session), "{}", Some(bytes))
        }
    }

    #[test]
    fn only_the_asked_session_is_counted() {
        let all = vec![
            entry("read_files", Some("s1"), "{\"path\":\"a.rs\"}", Some(400)),
            entry("read_files", Some("s2"), "{\"path\":\"b.rs\"}", Some(900)),
            // 轮次之间从别的客户端调进来的（没有归属）：不属于任何会话
            entry("read_files", None, "{\"path\":\"c.rs\"}", Some(500)),
        ];
        let t = aggregate(&all, "s1");
        assert_eq!(t.calls, 1, "只有 s1 的那条");
        assert_eq!(t.result_bytes, 400);
    }

    #[test]
    fn batch_container_counts_calls_but_not_bytes() {
        // 外层容器带着全部子结果的字节；子条目已各自记过 ⇒ 外层只留 calls。
        let all = vec![
            entry("batch", Some("s1"), "{}", Some(90_000)),
            entry("read_files", Some("s1"), "{\"path\":\"a\"}", Some(1_000)),
        ];
        let t = aggregate(&all, "s1");
        assert_eq!(t.calls, 2, "容器本身确实被调用了一次");
        assert_eq!(t.result_bytes, 1_000, "容器字节不计入，否则同一批记两遍");
        assert!(t.oversized.is_empty(), "容器也不该进越线清单：{t:?}");
    }

    #[test]
    fn both_thresholds_are_reported_separately() {
        let all = vec![
            // 顶到我们自己的裁剪线，但没到客户端降级线
            entry("read_files", Some("s1"), "{\"path\":\"mid\"}", Some(46_000)),
            // 越过客户端降级线
            entry("read_files", Some("s1"), "{\"path\":\"big\"}", Some(60_000)),
        ];
        let t = aggregate(&all, "s1");
        assert_eq!(t.oversized_total, 2);
        assert_eq!(t.dropped_total, 1, "只有 60_000 那条是真的降级");
        // 举证行按字符数倒序：最大的在最上面
        assert_eq!(t.oversized[0].wire_chars, 60_000);
        assert_eq!(t.oversized[0].target, "big");
    }

    #[test]
    fn legacy_rows_fall_back_to_bytes_and_get_counted() {
        let all = vec![legacy("read_files", "s1", 8_000)];
        let t = aggregate(&all, "s1");
        assert_eq!(
            t.charless_calls, 1,
            "老日志要能被识别出来（前端据此弱化告警语气）"
        );
        assert_eq!(t.result_bytes, 8_000);
        assert!(t.oversized.is_empty());
    }

    /// 哨兵值（`u64::MAX` = `wire_chars` 量不出来）不许当成 1.8e19 字符的事实值。
    ///
    /// 修复前 `http.rs` 写的是 `Some(wire_chars(..) as u64)`，量不出来时那条日志
    /// 会变成一个天文数字，面板随后把它渲染成一条荒诞的「已降级」举证。
    #[test]
    fn sentinel_chars_are_treated_as_unknown() {
        let poisoned = AuditEntry {
            result_chars: Some(u64::MAX),
            ..entry("read_files", Some("s1"), "{\"path\":\"a\"}", Some(8_000))
        };
        let t = aggregate(&[poisoned], "s1");
        assert_eq!(t.charless_calls, 1, "哨兵按「没有字符数」计");
        assert_eq!(
            t.tools[0].max_chars, 8_000,
            "退回字节值，不是 u64::MAX —— 这个数会直接显示给用户"
        );
        assert!(
            t.oversized.is_empty(),
            "8,000 字节远在两条线之下，不该因为哨兵凭空造出一次越线：{:?}",
            t.oversized
        );
    }

    /// 哨兵且连字节都没有：只能算 0，同样不许把 `u64::MAX` 带出去。
    #[test]
    fn sentinel_without_bytes_degrades_to_zero() {
        let poisoned = AuditEntry {
            result_chars: Some(u64::MAX),
            ..entry("read_files", Some("s1"), "{}", None)
        };
        let t = aggregate(&[poisoned], "s1");
        assert_eq!(t.tools[0].max_chars, 0);
        assert_eq!(t.charless_calls, 0, "无字节可退，不算「按字节估算」");
        assert!(t.oversized.is_empty());
    }

    #[test]
    fn empty_session_short_circuits_without_touching_disk() {
        // 传一个绝对不存在的目录：空 id 必须在读盘之前就返回，否则每次开新会话
        // 都会白扫一遍 audit.log。
        let t = context_tax(Path::new("Z:/definitely/not/here"), "   ").expect("空 id 不算错");
        assert_eq!(t.calls, 0);
        assert!(t.tools.is_empty());
    }

    #[test]
    fn target_is_read_from_common_param_keys() {
        assert_eq!(target_of("{\"path\":\"D:/a/b.rs\"}"), "D:/a/b.rs");
        assert_eq!(target_of("{\"command\":\"cargo test\"}"), "cargo test");
        assert_eq!(target_of("{\"paths\":[\"a\",\"b\",\"c\"]}"), "a 等 3 个");
        // 非 JSON 不崩，退回原文前缀
        assert_eq!(target_of("not json at all"), "not json at all");
    }

    #[test]
    fn head_truncates_by_chars_not_bytes() {
        // 按字节切会把中文劈成半个 ⇒ String 直接 panic。这条守着那个坑。
        let s = "中".repeat(80);
        let out = head(&s, 10);
        assert_eq!(out.chars().count(), 11, "10 个字 + 省略号");
        assert!(out.ends_with('…'));
    }

    #[test]
    fn tokens_use_the_same_divisor_as_the_usage_report() {
        let all = vec![entry("read_files", Some("s1"), "1234", Some(3_996))];
        let t = aggregate(&all, "s1");
        // 3996 / 4 = 999 —— 与 audit::est_tokens 同一个常数。入参那 4 字节不计进来：
        // 面板上「工具结果」那一行必须等于各工具行之和（各工具行同样只算结果）。
        assert_eq!(t.est_tokens, 999);
        assert_eq!(t.params_bytes, 4);
    }
}
