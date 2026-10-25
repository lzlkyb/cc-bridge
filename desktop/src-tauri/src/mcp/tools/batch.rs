use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::audit;
use crate::mcp::http::dispatch_tool;
use crate::mcp::tools::{result_text_bytes, wire_chars};
use crate::state::AppState;

/// batch 整条返回的**内容预算**（字符，wire 口径，与 [`crate::mcp::tools::MAX_INLINE_CHARS`] 同源）。
///
/// 🔴 不能比单条 `read_files` 的上限更严。容器比内容还严会出现这种荒谬情形：
/// 直接调 `read_files` 能拿到 40,000 字符的正文，同样的调用**放进 batch 反而变成 stub**
/// ——而 `instructions` 正引导模型优先用 batch，那等于亲手把内容挡在门外，
/// 白换一次「组装 stub → 单独重调」的往返。所以取 `MAX_INLINE_CHARS + 1,024`，
/// 多出的 1KB 是子结果外壳（`{"index":0,"tool":…,"ok":true,"result":…}`）的开销。
/// 客户端实测门槛 49,823 字符，此处仍留约 2.8K 余量（预算按 [`wire_chars`] 扣，
/// 已含 text 外层二次转义，见该函数注释）。
const MAX_BATCH_RETURN_CHARS: usize = crate::mcp::tools::MAX_INLINE_CHARS + 1024;

/// 给「未内联」说明预留的字符预算。裁剪时先扣掉它，否则说明一写就把总长顶回超限。
const NOTE_RESERVE_CHARS: usize = 320;

/// 预算耗尽后的**聚合收尾条目**长度上界（含前 20 个 index）。
const TAIL_RESERVE_CHARS: usize = 640;

/// error 子结果的额外溢出额度：预算被前面的内容吃光后，**小体积**错误仍然完整放行
/// （错误原因对模型纠错至关重要，截掉等于没报错）；但额度有上限——
/// 100 个子操作最坏能堆出几万字符的报错文本，无界放行会把整条结果顶过客户端门槛。
const ERROR_OVERFLOW_CAP: usize = 2_000;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct BatchArgs {
    pub operations: Vec<BatchOp>,
    #[serde(default = "default_stop_on_error", rename = "stopOnError")]
    pub stop_on_error: bool,
}

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct BatchOp {
    pub tool: String,
    #[serde(default)]
    pub arguments: Value,
}

fn default_stop_on_error() -> bool {
    true
}

/// 提前校验（不需要 state）：拒绝空操作与嵌套 batch。
/// 拆出来便于纯单元测试，且确保即使后续分发失败也不会误执行。
pub fn validate_batch(args: &BatchArgs) -> Result<(), String> {
    if args.operations.is_empty() {
        return Err("batch requires at least one operation".into());
    }
    // 限制单次 batch 的子操作数量，避免一个请求被放大成大量文件/命令操作。
    const MAX_BATCH_OPS: usize = 100;
    if args.operations.len() > MAX_BATCH_OPS {
        return Err(format!(
            "batch operations 数量 {} 超过上限 {MAX_BATCH_OPS}",
            args.operations.len()
        ));
    }
    // 🔴 嵌套 batch 判定必须走**与 dispatch 相同的名字解析**（审查 B8）。
    //
    // 原实现只比字面量 `op.tool == "batch"`，而 `dispatch_tool` 会剥掉
    // `mcp__<server>__` 前缀再查表——于是 `{"tool": "mcp__cc-bridge__batch"}`
    // 通过校验后被解析回 `batch` 并递归执行，每层还能再带 100 条子操作，
    // 100^深度 放大。batch「零新攻击面」的前提就建立在这条拦截上。
    let tools = crate::mcp::tools::registry::all_tools();
    for (idx, op) in args.operations.iter().enumerate() {
        if let Some(spec) = crate::mcp::http::resolve_tool_name(&op.tool, &tools) {
            if spec.name == "batch" {
                return Err(format!("operation[{idx}]: nested batch is not allowed"));
            }
        }
    }
    Ok(())
}

tokio::task_local! {
    /// batch 递归深度（硬上限 1）。`validate_batch` 是「认识所有写法」的正向拦截，
    /// 这个计数器是「不管怎么写，深度超了就拒」的兜底——两者是不同层的防线：
    /// 前者依赖名字解析不出错，后者依赖调用链本身。
    static BATCH_DEPTH: std::cell::Cell<u32>;
}

/// 嵌套 batch 的深度上限（顶层 = 0；只允许一层）。
const MAX_BATCH_DEPTH: u32 = 1;

pub async fn handle(args: BatchArgs, state: &Arc<AppState>) -> Result<Value, String> {
    validate_batch(&args)?;
    // 递归兜底：顶层调用深度为 0；子操作里再次进入 batch 时读到 1 → 拒绝。
    // 用 task_local 而不是全局原子量：并发请求各自独立，互不影响。
    let depth = BATCH_DEPTH.try_with(|d| d.get()).unwrap_or(0);
    if depth >= MAX_BATCH_DEPTH {
        return Err("nested batch is not allowed".into());
    }
    BATCH_DEPTH
        .scope(std::cell::Cell::new(depth + 1), handle_inner(args, state))
        .await
}

async fn handle_inner(args: BatchArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let audit_enabled = state.config.read().await.audit_enabled;
    // 从 task_local 作用域取本次调用的来源 IP，补写进每条子操作审计（之前恒为 None）。
    let source_ip = audit::current_source_ip();

    let mut results = Vec::with_capacity(args.operations.len());
    // 审计条目延后到预算层之后写（见循环内注释）：先收集，等知道「哪条被内联」再记字节。
    let mut pending: Vec<PendingAudit> = Vec::new();
    let mut executed = 0usize;

    for (idx, op) in args.operations.into_iter().enumerate() {
        // 复用现有分发 → 复用全部安全校验（只读模式 / WRITE_TOOLS / 路径白名单）。
        // 这是 batch 设计的核心：零新文件操作代码 = 零新攻击面。
        // Box::pin 断开与 dispatch_tool 的互递归（async fn 递归必须加间接层）。
        // 子操作分发包在 with_op_backup 作用域内：写工具会 record_op_backup，
        // 未进入作用域会在 .with() 上 panic（与 http.rs 保持一致）。
        //
        // 🔴 备份信息必须在**作用域内部**取（审查 P2）：`take_op_backup` 读的是
        // task_local 槽，一旦 `with_op_backup(...).await` 返回，那个作用域就没了，
        // 外面再取恒为 None——原实现正是这样让 batch 的**每条**审计都丢了
        // backupPath，一键回滚对 batch 完全失效。所以把「分发 + 取备份」放进同一个
        // 作用域，作为整体结果返回。
        let t0 = std::time::Instant::now();
        let (res, op_backup) = crate::audit::with_op_backup(Box::pin(async {
            let r = dispatch_tool(&op.tool, op.arguments.clone(), state).await;
            (r, crate::audit::take_op_backup())
        }))
        .await;
        // 子操作自身的分发耗时：修复之前全传 None 导致日志列表里 batch 相关行耗时列一律
        // 显示“—”的问题。
        let duration_ms = t0.elapsed().as_millis() as u64;

        // 逐子操作留痕：外层工具调用只记一条，写操作必须单独留痕，否则绕过审计。
        // server_ms/io_ms/audit_ms/net_ms 仍不单独测（io 归并到 batch 外层审计的 ioMs，作用域
        // 穿透生效），但 duration_ms 现在具体测了，日志列表不再一片“—”。
        //
        // 🔴 审计**不在这里写**，只暂存：子操作的输出字节取决于它最后是否被
        // `apply_return_budget` 内联——被换成 stub 的子结果，模型只看到一句指路话（约 100B），
        // 而不是几十 KB 正文。若在循环里就按原始子结果记账，统计会凭空多出几 MB 的
        // 「已消耗」（正是 batch 想省的量被记成花了），把优化效果从账上抹掉。
        if audit_enabled {
            pending.push(PendingAudit {
                index: idx,
                tool: op.tool.clone(),
                params: op.arguments.to_string(),
                err: res.as_ref().err().cloned(),
                duration_ms,
                // 备份信息必须在 with_op_backup 作用域内取（审查 P2）：`take_op_backup`
                // 读的是 task_local 槽，一旦作用域结束，外面再取恒为 None——原实现
                // 正是这样让 batch 的**每条**审计都丢了 backupPath，一键回滚对 batch 完全失效。
                backup_path: op_backup
                    .as_ref()
                    .and_then(|(bp, _)| bp.as_ref())
                    .map(|p| p.to_string_lossy().into_owned()),
                target_path: op_backup
                    .as_ref()
                    .and_then(|(_, tp)| tp.as_ref())
                    .map(|p| p.to_string_lossy().into_owned()),
            });
        }

        match res {
            Ok(v) => {
                executed += 1;
                results.push(json!({
                    "index": idx,
                    "tool": op.tool,
                    "ok": true,
                    "result": v,
                }));
            }
            Err(e) => {
                results.push(json!({
                    "index": idx,
                    "tool": op.tool,
                    "ok": false,
                    "error": e,
                }));
                if args.stop_on_error {
                    break;
                }
            }
        }
    }

    // 返回预算层（方案 §3.4）：整条结果超过内联上限时，按顺序内联、放不下的换成
    // 「未内联」stub。**绝不切字符串**——子结果里是嵌套 JSON，切一半会产出无法解析的
    // 残文，模型拿到的只会是一段坏数据；而子操作天然可独立重跑，指回去比切碎便宜。
    // total 必须是**原始子结果数**：预算层可能把末尾多条合并成一条聚合收尾
    // （`tail` 条目），此时 results.len() < 子结果数——「被省略不等于不存在」。
    let total = results.len();
    let (results, budget_note) = apply_return_budget(results);
    // 预算层定型后，每条子结果「实际发出多少字节」才成为定局——此时补审计。
    // 写盘仍在本函数内、响应返回前完成（与 http.rs::write_audit_for_call 同款同步写，
    // 约 6.8µs/条，比 spawn_blocking 的跨线程调度更省），审计时序不变。
    write_sub_op_audits(
        &pending,
        &results,
        audit_enabled,
        source_ip,
        &state.data_dir,
        // 子条目也要带会话归属：token 全记在子条目上（外层只记 calls），
        // 漏了它 batch 的用量就归不到任何对话名下。
        state.cc.active_session_id(),
    );
    let mut envelope = json!({
        "executed": executed,
        "total": total,
        "results": results,
    });
    if let Some(note) = budget_note {
        envelope["note"] = json!(note);
    }
    Ok(json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string(&envelope).unwrap_or_default()
        }]
    }))
}

/// batch 子操作的待写审计条目。
///
/// 之所以延后写：子操作的输出字节取决于预算层是否把它的结果换成了 stub，
/// 循环内还不知道（见 `handle_inner`）。除字节外的字段都在循环里定好。
struct PendingAudit {
    index: usize,
    tool: String,
    params: String,
    /// `None` = 子操作成功；`Some(msg)` = 失败原因。
    err: Option<String>,
    duration_ms: u64,
    backup_path: Option<String>,
    target_path: Option<String>,
}

/// 把每条子操作按**实际进入上下文**的字节写入审计。
///
/// 🔴 这是「同源分母」的关键一环：`audit::aggregate_usage` 对 batch 外层条目
/// 不再计 token（它的 params/结果已由这里的子条目逐条计入），所以子条目的字节
/// 必须是真实的最终量，否则整份用量统计会失真：
/// - 内联的子结果 → 子结果文本字节；
/// - 被换成 stub 的 → stub 那句指路话的字节（模型只看到这些）；
/// - 并入末尾聚合收尾的 → 0（一个字都没发出，`tail` 条目不含原文）。
fn write_sub_op_audits(
    pending: &[PendingAudit],
    results: &[Value],
    audit_enabled: bool,
    source_ip: Option<String>,
    data_dir: &std::path::Path,
    cc_session_id: Option<String>,
) {
    if !audit_enabled {
        return;
    }
    let bytes = final_result_bytes(results);
    for p in pending {
        let mut entry = audit::new_entry(
            &p.tool,
            &p.params,
            p.err.is_none(),
            p.err.clone(),
            source_ip.clone(),
            Some(p.duration_ms),
            None,
            None,
            None,
            None,
            None,
            cc_session_id.clone(),
        );
        // 未出现在 `final_result_bytes` 里（进了聚合收尾）→ 0，不是「未知」：
        // 未知（None）会被聚合当 0 计，与真实 0 在 UI 上无法区分，这里直接落 0 更诚实。
        let (bytes, chars) = bytes.get(&p.index).copied().unwrap_or((0, 0));
        entry.result_bytes = Some(bytes);
        // 批 4-1：与 http 通道同口径，子条目也要带 wire 字符数 —— 否则 batch 里的
        // 大结果在「上下文构成」面板上永远判不出是否被客户端降级。
        entry.result_chars = Some(chars);
        entry.backup_path = p.backup_path.clone();
        entry.target_path = p.target_path.clone();
        if let Err(e) = audit::write_audit_log(data_dir, &entry) {
            log::error!("batch 子操作审计写入失败：{e}");
        }
    }
}

/// 预算层输出 → `index → (实际发出字节, 客户端口径字符数)`。
///
/// 字节口径与 `http.rs` 的 `result_bytes` 一致（text 块字节和；失败按 `"Error: " + msg`）；
/// 字符数用 `wire_chars`（客户端按字符分档，中文 1 字符 = 3 字节，两者不能互相顶替）。
/// `tail` 聚合条目整条跳过：它只带条数与前 20 个 index，被它收走的子结果原文一个字都没发出。
fn final_result_bytes(results: &[Value]) -> std::collections::HashMap<usize, (u64, u64)> {
    let mut m = std::collections::HashMap::new();
    for e in results {
        if e.get("tail").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(idx) = e.get("index").and_then(Value::as_u64) else {
            continue;
        };
        let pair = match e.get("error").and_then(Value::as_str) {
            // 错误文案是纯文本、而且短到不可能越线 ⇒ 字节与字符同值。
            Some(err) => {
                let n = ("Error: ".len() + err.len()) as u64;
                (n, n)
            }
            None => match e.get("result") {
                Some(r) => (
                    result_text_bytes(r),
                    crate::mcp::tools::wire_chars(r) as u64,
                ),
                None => (0, 0),
            },
        };
        m.insert(idx as usize, pair);
    }
    m
}

/// 按预算裁剪 batch 的 `results`。返回 `(结果, 说明)`。
///
/// 三条规则，顺序即优先级：
/// 1. **error 子结果优先完整内联**——它的全部价值就是失败原因，切掉等于没报错。
///    但「优先」不是「无界」：预算外还有 [`ERROR_OVERFLOW_CAP`] 的溢出额度，
///    否则一条超长堆栈就能吃掉整个返回；额度也耗尽时并入末尾聚合收尾并注明条数。
/// 2. 其余按**声明顺序**依次内联，放不下的换成 stub（可预测：前面的优先）。
/// 3. 全部放得下（实测大多数：batch 平均 16.6KB）时**一个字节都不动**，行为与改动前一致。
fn apply_return_budget(results: Vec<Value>) -> (Vec<Value>, Option<String>) {
    let n = results.len();
    // 外层 envelope（`executed` / `total` / `results` 三个字段 + 括号）不计入内容预算：
    // 它是固定的几十个字符，若把它算进去，一条恰好顶到上限的子结果就会被无端判成超限。
    // 元素逐个序列化后再补 n-1 个逗号，就是整条内容长度（线性，不做 n 次全量序列化）。
    let sizes: Vec<usize> = results.iter().map(wire_chars).collect();
    let overhead = n.saturating_sub(1);
    if sizes.iter().sum::<usize>() + overhead <= MAX_BATCH_RETURN_CHARS {
        return (results, None);
    }

    let mut budget =
        MAX_BATCH_RETURN_CHARS.saturating_sub(overhead + NOTE_RESERVE_CHARS + TAIL_RESERVE_CHARS);
    let mut out = Vec::with_capacity(n);
    let mut stubbed = 0usize;
    let mut error_overflow = 0usize;
    // 预算彻底枯竭后剩余条目的 (index, is_error)：不再逐条写 stub——
    // 🔴 100 个子操作最坏能堆出 ~23,000 字符的 stub（每条约 230），
    // 把整条结果顶过客户端门槛，正是本函数要防的事故（read_files 的
    // `skipped_marker` 同款教训：用防越线的机制造成越线）。
    let mut tail: Vec<(usize, bool)> = Vec::new();
    let mut tail_started = false;

    for (entry, size) in results.into_iter().zip(sizes) {
        let idx = entry.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let is_error = entry.get("ok").and_then(|v| v.as_bool()) == Some(false);
        if tail_started {
            tail.push((idx, is_error));
            continue;
        }
        if is_error {
            // 错误优先保完整（截掉原因等于没报错）：预算内直接放，
            // 预算外还有 ERROR_OVERFLOW_CAP 的溢出额度，额度也耗尽才进聚合。
            if size <= budget {
                budget -= size;
                out.push(entry);
            } else if error_overflow + size <= ERROR_OVERFLOW_CAP {
                error_overflow += size;
                out.push(entry);
            } else {
                tail.push((idx, is_error));
                tail_started = true;
            }
        } else if size <= budget {
            budget -= size;
            out.push(entry);
        } else {
            let stub = omitted_stub(&entry, size);
            let ssize = wire_chars(&stub);
            if ssize <= budget {
                budget -= ssize;
                out.push(stub);
                stubbed += 1;
            } else {
                // 连一条 stub（约 230 字符）都放不下：剩余条目全部并入聚合收尾。
                tail.push((idx, is_error));
                tail_started = true;
            }
        }
    }

    let tail_errored = tail.iter().filter(|(_, e)| *e).count();
    if !tail.is_empty() {
        // index 列表截前 20 个：100 个子操作全列出来会把 TAIL_RESERVE 撑爆。
        let indexes: Vec<u64> = tail.iter().map(|(i, _)| *i as u64).take(20).collect();
        let more = tail.len().saturating_sub(20);
        let mut marker = json!({
            "omitted": true,
            "tail": true,
            "count": tail.len(),
            "errored": tail_errored,
            "indexes": indexes,
            "result": {
                "content": [{
                    "type": "text",
                    "text": format!(
                        "…[预算已满，后 {} 个子结果未内联（{}）。请按 indexes（从 0 计）单独调用对应工具取回{}]…",
                        tail.len(),
                        if tail_errored > 0 {
                            format!("含 {tail_errored} 个执行失败的子操作，单独重跑可见完整错误原因")
                        } else {
                            "未内联 ≠ 未执行".to_string()
                        },
                        if more > 0 { format!("；共 {more}+ 个省略未列全") } else { String::new() },
                    ),
                }]
            },
        });
        if more > 0 {
            marker["indexesTruncated"] = json!(true);
        }
        out.push(marker);
    }

    // 极端场景：超限全是 error 子结果撑起来的（错误全保留、没省略任何东西）。
    // 写一句「0 个子结果未内联」只会让模型以为漏了东西——干脆不加说明。
    // 说明里不罗列 index：每条 stub 自带 index，聚合条目自带前 20 个，
    // 罗列一遍只会把 NOTE_RESERVE 撑爆（上一版就踩过）。
    if stubbed == 0 && tail.is_empty() {
        return (out, None);
    }
    let note = format!(
        "{} 个子结果超出 batch 单次内联上限（约 {MAX_BATCH_RETURN_CHARS} 字符）未内联：results 里 omitted:true 的条目（含末尾的聚合条目）就是它们，未内联 ≠ 未执行。被省略的请**单独调用对应工具**取回——batch 的子操作彼此独立，单独重跑只重做那一项，不影响已执行的操作。",
        stubbed + tail.len()
    );
    (out, Some(note))
}

/// 「未内联」占位：保持 `{index, tool, ok, result}` 形状不变（客户端/模型无需特判），
/// 只是把正文换成一句指路的话。
fn omitted_stub(entry: &Value, chars: usize) -> Value {
    let tool = entry
        .get("tool")
        .and_then(|v| v.as_str())
        .unwrap_or("该工具");
    json!({
        "index": entry.get("index").cloned().unwrap_or(Value::Null),
        "tool": tool,
        "ok": true,
        "omitted": true,
        "chars": chars,
        "result": {
            "content": [{
                "type": "text",
                "text": format!("…[子结果约 {chars} 字符，超出 batch 单次内联上限，未内联；请单独调用 {tool} 取回]…"),
            }]
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;

    use rusqlite::Connection;

    use crate::config::BridgeConfig;
    use crate::state::AppState;

    fn test_state(allowed_root: Option<PathBuf>) -> Arc<AppState> {
        let conn = Connection::open_in_memory().unwrap();
        let mut config = BridgeConfig::default();
        if let Some(root) = allowed_root {
            config.allowed_roots = vec![root.to_string_lossy().to_string()];
            // 关闭审计，避免测试向真实 data_dir 写文件。
            config.audit_enabled = false;
        }
        Arc::new(AppState::new(conn, config, PathBuf::from(".")))
    }

    #[test]
    fn validates_empty_operations() {
        let args = BatchArgs {
            operations: vec![],
            stop_on_error: true,
        };
        assert!(validate_batch(&args).is_err());
    }

    #[test]
    fn rejects_nested_batch() {
        let args = BatchArgs {
            operations: vec![
                BatchOp {
                    tool: "read_files".into(),
                    arguments: json!({ "files": ["x"] }),
                },
                BatchOp {
                    tool: "batch".into(),
                    arguments: json!({ "operations": [] }),
                },
            ],
            stop_on_error: true,
        };
        assert!(validate_batch(&args).is_err());
    }

    /// 🔴 回归（审查 B8）：带 `mcp__<server>__` 前缀的 batch 同样必须被拦下。
    ///
    /// dispatch 会剥前缀再查表，所以只比字面量 "batch" 时这条路是敞开的：
    /// `mcp__cc-bridge__batch` 能一路递归，每层再乘 100 条子操作。
    #[test]
    fn rejects_nested_batch_with_prefixed_name() {
        for name in [
            "mcp__cc-bridge__batch",
            "mcp__anything__batch",
            "mcp__cc_bridge__batch",
        ] {
            let args = BatchArgs {
                operations: vec![BatchOp {
                    tool: name.into(),
                    arguments: json!({ "operations": [] }),
                }],
                stop_on_error: true,
            };
            assert!(
                validate_batch(&args).is_err(),
                "带前缀的 batch 必须被拒：{name}"
            );
        }
    }

    /// 🔴 回归（审查 P2）：batch 里的写操作，其审计条目必须带上 `backupPath`。
    ///
    /// 原实现把 `take_op_backup()` 留在作用域外取，恒为 None → 日志里 batch 的
    /// 子操作备份列一片 null，一键回滚对 batch 完全失效。
    #[tokio::test]
    async fn sub_op_audit_carries_backup_path() {
        let (state, dir) = crate::mcp::tools::testutil::make_state(|c| {
            c.audit_enabled = true;
            c.backup_enabled = true;
        });
        let target = dir.join("t.txt");
        std::fs::write(&target, "old").expect("seed");

        let args = BatchArgs {
            operations: vec![BatchOp {
                tool: "write_files".into(),
                arguments: json!({ "files": [{ "path": target.to_string_lossy(), "content": "new" }] }),
            }],
            stop_on_error: true,
        };
        handle(args, &state).await.expect("batch");

        let log = std::fs::read_to_string(dir.join("audit.log")).expect("read audit");
        let line = log
            .lines()
            .find(|l| l.contains("\"write_files\""))
            .expect("应有一条 write_files 子操作审计");
        let v: Value = serde_json::from_str(line).expect("parse audit line");
        assert!(
            v["backupPath"].as_str().is_some_and(|s| !s.is_empty()),
            "子操作审计缺 backupPath（一键回滚失效）：{line}"
        );
        assert!(
            v["targetPath"].as_str().is_some(),
            "子操作审计缺 targetPath：{line}"
        );
    }

    /// 递归兜底：即使名字解析被绕过，子操作里再进 batch 也会因深度超限被拒。
    /// 这里直接验证 `handle` 的深度闸——用一个指向 batch 的 op 走不到，
    /// 因为 validate 先拦下了，所以分两段测：①顶层深度为 0 时能进；②手动在
    /// 深度 1 的 scope 里调 handle 必须报错。
    #[tokio::test]
    async fn depth_guard_blocks_second_level() {
        let state = test_state(None);
        let args = BatchArgs {
            operations: vec![BatchOp {
                tool: "read_files".into(),
                arguments: json!({ "files": [] }),
            }],
            stop_on_error: true,
        };
        // 模拟「已经在 batch 里」：深度 1 的 scope 内再调 handle。
        let err = BATCH_DEPTH
            .scope(std::cell::Cell::new(1), handle(args, &state))
            .await
            .expect_err("第二层必须被拒");
        assert!(err.contains("nested batch"), "{err}");
    }

    #[tokio::test]
    async fn read_allowed_file_in_batch() {
        let temp = std::env::temp_dir().join("cc-bridge-batch-test");
        let _ = std::fs::create_dir_all(&temp);
        let file = temp.join("a.txt");
        std::fs::write(&file, "hello").unwrap();

        let state = test_state(Some(temp.clone()));
        let args = BatchArgs {
            operations: vec![BatchOp {
                tool: "read_files".into(),
                arguments: json!({ "files": [file.to_string_lossy().to_string()] }),
            }],
            stop_on_error: true,
        };
        let res = handle(args, &state).await.unwrap();
        let text = res["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["total"], 1);
        assert_eq!(parsed["results"][0]["ok"], true);
        assert!(parsed["results"][0]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("hello"));
    }

    #[tokio::test]
    async fn path_outside_root_rejected_in_batch() {
        let state = test_state(Some(std::env::temp_dir().join("cc-bridge-batch-never")));
        // 白名单外的**绝对路径**样本必须按平台取。
        // 不能两边都用 `C:\Windows\...`：在 mac 上反斜杠是**合法文件名字符**，
        // 那串会被当成一个叫 `C:\Windows\System32\cmd.exe` 的**相对路径**，
        // 于是拒绝原因变成“文件不存在”而不是“越出白名单”，错误文案也不含
        // "Access denied"——这正是 CI 在 macOS 上真实跑测试后报出的失败。
        #[cfg(windows)]
        let outside_path = "C:\\Windows\\System32\\cmd.exe";
        #[cfg(not(windows))]
        let outside_path = "/etc/passwd";

        let args = BatchArgs {
            operations: vec![BatchOp {
                tool: "read_files".into(),
                arguments: json!({ "files": [outside_path] }),
            }],
            stop_on_error: true,
        };
        let res = handle(args, &state).await.unwrap();
        let text = res["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        // read_files 对单文件越权是把错误内联进结果（工具级仍返回 Ok），
        // 因此这里校验子结果内部包含 "Access denied"，而非外层 ok 标志。
        assert!(parsed["results"][0]["result"]
            .to_string()
            .contains("Access denied"));
    }

    #[tokio::test]
    async fn readonly_blocks_write_in_batch() {
        let state = test_state(Some(std::env::temp_dir().join("cc-bridge-batch-rw")));
        {
            let mut cfg = state.config.write().await;
            cfg.readonly_mode = true;
        }
        let args = BatchArgs {
            operations: vec![BatchOp {
                tool: "write_files".into(),
                arguments: json!({ "files": [{ "path": "C:\\x.txt", "content": "y" }] }),
            }],
            stop_on_error: true,
        };
        let res = handle(args, &state).await.unwrap();
        let text = res["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["results"][0]["ok"], false);
        assert!(parsed["results"][0]["error"]
            .as_str()
            .unwrap()
            .contains("只读模式"));
    }

    #[tokio::test]
    async fn stop_on_error_breaks_and_reports_completed() {
        let state = test_state(Some(std::env::temp_dir().join("cc-bridge-batch-stop")));
        // op0：未知工具 → 工具级 Err（Unknown tool）。read_files 永远返回 Ok（单文件错误内联），
        // 无法触发 stopOnError，故此处用工具级失败来测中断。
        // op1：普通 read，本不应执行（stopOnError=true 应在 op0 失败后中断）。
        let args = BatchArgs {
            operations: vec![
                BatchOp {
                    tool: "no_such_tool".into(),
                    arguments: json!({}),
                },
                BatchOp {
                    tool: "read_files".into(),
                    arguments: json!({ "files": ["C:\\Windows\\System32\\cmd.exe"] }),
                },
            ],
            stop_on_error: true,
        };
        let res = handle(args, &state).await.unwrap();
        let text = res["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        // op0 失败即停，op1 未执行 → total == 1
        assert_eq!(parsed["total"], 1);
        assert_eq!(parsed["results"][0]["ok"], false);
        assert!(parsed["results"][0]["error"]
            .as_str()
            .unwrap()
            .contains("Unknown tool"));
    }

    /// 返回预算层：整条超限时「按顺序内联 + 其余换 stub」，且**整条 JSON 必须仍可解析**。
    ///
    /// 这条要挡的是最诱人的错误做法——把返回字符串从中间截断。子结果里套的是 JSON
    /// （`result.content[0].text` 又是一段 JSON 文本），截中间得到的是不可解析的残文，
    /// 模型会当成完整数据去用。所以断言三件事：可解析、第二项带 omitted、给了取回指引。
    #[tokio::test]
    async fn oversized_batch_is_budgeted_not_truncated() {
        let (state, dir) = crate::mcp::tools::testutil::make_state(|_| {});
        let mut paths = Vec::new();
        for name in ["a.txt", "b.txt"] {
            let p = dir.join(name);
            // 每份约 32,000 字符：单独看没超 read_files 的 45,000，但两份合计必超 batch 的内容预算。
            let body: String = (0..400).map(|i| format!("{i:0>79}\n")).collect();
            std::fs::write(&p, body).expect("seed");
            paths.push(p.to_string_lossy().into_owned());
        }
        let args = BatchArgs {
            operations: paths
                .iter()
                .map(|p| BatchOp {
                    tool: "read_files".into(),
                    arguments: json!({ "files": [p] }),
                })
                .collect(),
            stop_on_error: true,
        };
        let res = handle(args, &state).await.expect("batch");
        let text = res["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).expect("整条结果必须仍是合法 JSON");
        assert_eq!(parsed["total"], 2, "被省略不等于不存在，total 不能变");
        assert!(
            parsed["results"][0]["result"]["content"].is_array(),
            "第一项应正常内联：{}",
            parsed["results"][0]
        );
        assert_eq!(parsed["results"][1]["omitted"], true, "第二项应换成 stub");
        assert!(
            parsed["results"][1]["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("单独调用"),
            "stub 必须指回去哪取：{}",
            parsed["results"][1]
        );
        assert!(
            parsed["note"].as_str().unwrap_or("").contains("未内联"),
            "必须说明哪些被省略：{}",
            parsed["note"]
        );
        let n = text.chars().count();
        assert!(
            n <= MAX_BATCH_RETURN_CHARS + NOTE_RESERVE_CHARS,
            "裁剪后仍越线：{n} 字符"
        );
    }

    /// 🔴 预算枯竭后的 stub 无界累积回归（2026-10-23 复查实测）：上一版预算归零后
    /// 仍逐条给剩余子结果写 stub（每条约 230 字符），100 个子操作最坏堆出 ~23,000 字符，
    /// 把整条结果顶过客户端门槛（≈49,823）→ 整条被降级成 2KB 预览——
    /// 用防越线的机制造成了越线。修法：预算枯竭后剩余条目并入**一条**聚合收尾
    /// （read_files `skipped_marker` 同款）。这条测试用 100 个操作贴着 `MAX_BATCH_OPS`
    /// 上限打满它。
    #[tokio::test]
    async fn hundred_oversized_ops_stay_under_client_threshold() {
        let (state, dir) = crate::mcp::tools::testutil::make_state(|_| {});
        // 一个 15 行 × 80 列的文件：单个子结果远小于预算，但 100 份合计必然超。
        let mut body = String::new();
        for i in 0..15 {
            body.push_str(&format!("{i:0>79}\n"));
        }
        let p = dir.join("f.txt");
        std::fs::write(&p, body).expect("seed");
        let args = BatchArgs {
            operations: (0..100)
                .map(|_| BatchOp {
                    tool: "read_files".into(),
                    arguments: json!({ "files": [p.to_string_lossy()] }),
                })
                .collect(),
            stop_on_error: true,
        };
        let res = handle(args, &state).await.expect("batch");
        let text = res["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).expect("整条结果必须仍是合法 JSON");
        assert_eq!(parsed["total"], 100, "被省略不等于不存在，total 不能变");
        // 聚合收尾必须存在：results 数组条目数 < 100，末条带 tail:true。
        let arr = parsed["results"].as_array().unwrap();
        let last = arr.last().unwrap();
        assert_eq!(last["tail"], true, "末条应是聚合收尾：{last}");
        assert!(arr.len() < 100, "预算枯竭后不该逐条写 100 个 stub");
        // 内联 + stub + 聚合收尾 + note 的总长必须有界（无界版本实测 ~64,000）。
        let n = text.chars().count();
        assert!(
            n <= MAX_BATCH_RETURN_CHARS + ERROR_OVERFLOW_CAP,
            "裁剪后仍越线：{n} 字符"
        );
        // 没有一个子结果被丢掉：内联条数 + stub 条数 + tail.count == 100。
        let inlined = arr
            .iter()
            .filter(|e| e.get("omitted").is_none() && e.get("tail").is_none())
            .count();
        let stubs = arr
            .iter()
            .filter(|e| e.get("omitted").is_some() && e.get("tail").is_none())
            .count();
        let tail_count = last["count"].as_u64().unwrap_or(0) as usize;
        assert_eq!(
            inlined + stubs + tail_count,
            100,
            "内联 {inlined} + stub {stubs} + tail {tail_count} 必须等于 total"
        );
    }

    /// 放得下就一个字节都不动：绝大多数 batch（实测平均 16.6KB）走的都是这条路。
    #[tokio::test]
    async fn small_batch_result_has_no_budget_note() {
        let (state, dir) = crate::mcp::tools::testutil::make_state(|_| {});
        let p = dir.join("s.txt");
        std::fs::write(&p, "hello\n").expect("seed");
        let args = BatchArgs {
            operations: vec![BatchOp {
                tool: "read_files".into(),
                arguments: json!({ "files": [p.to_string_lossy()] }),
            }],
            stop_on_error: true,
        };
        let res = handle(args, &state).await.expect("batch");
        let parsed: Value =
            serde_json::from_str(res["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(parsed.get("note").is_none(), "未超限时不该插说明");
        assert!(parsed["results"][0].get("omitted").is_none());
        assert_eq!(parsed["executed"], 1);
    }

    /// `final_result_bytes`：内联 / stub / 错误 / 聚合收尾 四种形态的字节口径。
    #[test]
    fn final_result_bytes_matches_what_model_sees() {
        let results = vec![
            // 内联：原文还在 → 记子结果文本字节
            json!({
                "index": 0,
                "tool": "read_files",
                "ok": true,
                "result": { "content": [{ "type": "text", "text": "0123456789" }] },
            }),
            // 被换成 stub：原文已丢弃，只剩一句指路话 → 记那句话，不是 chars 里的 30,000
            json!({
                "index": 1,
                "tool": "read_files",
                "ok": true,
                "omitted": true,
                "chars": 30_000,
                "result": { "content": [{ "type": "text", "text": "未内联请单独调用" }] },
            }),
            // 失败子结果：与 http.rs 同口径（"Error: " + 文案）
            json!({ "index": 2, "tool": "read_files", "ok": false, "error": "nope" }),
        ];
        let m = final_result_bytes(&results);
        // 字节口径与原断言完全一致（第一项 10 是空 content 数组的序列化长度）。
        assert_eq!(m.get(&0).copied().map(|p| p.0), Some(10));
        assert_eq!(
            m.get(&1).copied().map(|p| p.0),
            Some("未内联请单独调用".len() as u64)
        );
        assert_eq!(
            m.get(&2).copied().map(|p| p.0),
            Some(("Error: ".len() + 4) as u64)
        );
        // 字符数另有一份（批 4-1）：错误文案两者同值，正常结果按 wire 口径算。
        assert_eq!(
            m.get(&2).copied().map(|p| p.1),
            Some(("Error: ".len() + 4) as u64)
        );
        assert!(m.get(&1).copied().map(|p| p.1).unwrap_or(0) > 0);

        // 聚合收尾只带条数与前 20 个 index，被它收走的子结果一个字都没发出
        // → 不在表里（调用方按 0 计），绝不能记成原文大小。
        let tail = vec![json!({
            "omitted": true,
            "tail": true,
            "count": 3,
            "indexes": [3, 4, 5],
            "result": { "content": [{ "type": "text", "text": "…[预算已满]…" }] },
        })];
        assert!(final_result_bytes(&tail).is_empty());
    }

    /// 子操作审计的 `resultBytes` 必须是**实际进入上下文**的量。
    ///
    /// 回归：原先传 None（聚合时按 0 计），batch 内的 read_files 全被记成 0 输出，
    /// 按工具算平均时被拉低（历史 avg 7.9KB vs 实 15.3KB 的偏差来源之一）。
    /// 但也不能简单改成原始子结果大小：被预算层换成 stub 的子操作，模型只看到
    /// 一句指路话，记成几十 KB 等于把 batch 省下来的量记成花了。
    #[tokio::test]
    async fn sub_op_audit_records_actual_inlined_bytes() {
        let (state, dir) = crate::mcp::tools::testutil::make_state(|c| c.audit_enabled = true);
        // 两个各约 30,000 字符的文件：单个都在 read_files 的 45,000 以内，
        // 但加起来超过 batch 的 46,024 → 第二个必被换成 stub。
        let seed = |name: &str| {
            let p = dir.join(name);
            let body: String = (0..400).map(|i| format!("{i:0>74}\n")).collect();
            std::fs::write(&p, body).expect("seed");
            p
        };
        let p1 = seed("audit_a.txt");
        let p2 = seed("audit_b.txt");
        let args = BatchArgs {
            operations: vec![
                BatchOp {
                    tool: "read_files".into(),
                    arguments: json!({ "files": [p1.to_string_lossy()] }),
                },
                BatchOp {
                    tool: "read_files".into(),
                    arguments: json!({ "files": [p2.to_string_lossy()] }),
                },
            ],
            stop_on_error: true,
        };
        let res = handle(args, &state).await.expect("batch");
        let parsed: Value =
            serde_json::from_str(res["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            parsed["results"][1]["omitted"], true,
            "前提不成立：第二条没被 stub，本测试失去意义"
        );

        let log = std::fs::read_to_string(dir.join("audit.log")).expect("audit.log");
        let entries: Vec<Value> = log
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let rf: Vec<&Value> = entries
            .iter()
            .filter(|e| e["tool"] == "read_files")
            .collect();
        assert_eq!(rf.len(), 2, "每条子操作都应有独立审计");
        let inlined = rf[0]["resultBytes"]
            .as_u64()
            .expect("内联那条必须有字节（None = 统计按 0 计，正是本 bug）");
        let stubbed = rf[1]["resultBytes"]
            .as_u64()
            .expect("被 stub 那条也必须有字节（记 0 比记 None 诚实）");
        assert!(inlined > 25_000, "内联那条应记真实内容量，实得 {inlined}");
        assert!(
            stubbed < 1_000,
            "被 stub 那条只该记指路话的字节，实得 {stubbed}（记成 30,000 就是把省下的量记成花了）"
        );
    }

    /// 单个子结果只要 **read_files 自己放行**，batch 就必须原样内联。
    ///
    /// 回归：内容预算原本取 32KB（比 read_files 的 45,000 更严），于是「直接调 read_files
    /// 能拿到 40,000 字符、放进 batch 变成 stub」——而 instructions 正引导模型优先用 batch，
    /// 等于把内容挡在门外，还多花一次「拿到 stub → 单独重调」的往返。
    #[tokio::test]
    async fn single_large_sub_result_is_not_punished_by_container_limit() {
        let (state, dir) = crate::mcp::tools::testutil::make_state(|_| {});
        let p = dir.join("big.txt");
        // 500 行 × 80 列 ≈ 40,000 字符（序列化后 ≈ 40,100），在 read_files 的 45,000 以内。
        let body: String = (0..500).map(|i| format!("{i:0>79}\n")).collect();
        std::fs::write(&p, body).expect("seed");

        // 前提：单独调用 read_files 确实能拿到正文。
        let solo = crate::mcp::tools::read_files::handle(
            crate::mcp::tools::read_files::ReadFilesArgs {
                files: vec![crate::mcp::tools::read_files::FileRef::Simple(
                    p.to_string_lossy().into_owned(),
                )],
                start_line: None,
                end_line: None,
                encoding: None,
            },
            &state,
        )
        .await
        .expect("read_files");
        let solo_json: Value =
            serde_json::from_str(solo["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(
            solo_json[0].get("content").is_some(),
            "前提不成立：read_files 自己就拒了，这条测试失去意义：{}",
            solo_json[0]
        );

        let args = BatchArgs {
            operations: vec![BatchOp {
                tool: "read_files".into(),
                arguments: json!({ "files": [p.to_string_lossy()] }),
            }],
            stop_on_error: true,
        };
        let res = handle(args, &state).await.expect("batch");
        let parsed: Value =
            serde_json::from_str(res["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(
            parsed["results"][0].get("omitted").is_none(),
            "单独调用能拿到的内容，放进 batch 不该变成 stub：{}",
            parsed["results"][0]
        );
        assert!(
            parsed.get("note").is_none(),
            "只有一个子结果且放得下，不该有说明"
        );
    }
}
