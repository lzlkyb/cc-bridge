use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::audit;
use crate::mcp::http::dispatch_tool;
use crate::state::AppState;

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

        // 逐子操作补审计：外层工具调用只记一条，写操作必须单独留痕，否则绕过审计。
        // server_ms/io_ms/audit_ms/net_ms 仍不单独测（io 归并到 batch 外层审计的 ioMs，作用域
        // 穿透生效），但 duration_ms 现在具体测了，日志列表不再一片“—”。
        if audit_enabled {
            let mut entry = match &res {
                Ok(_) => audit::new_entry(
                    &op.tool,
                    &op.arguments.to_string(),
                    true,
                    None,
                    source_ip.clone(),
                    Some(duration_ms),
                    None,
                    None,
                    None,
                    None,
                    None,
                ),
                Err(e) => audit::new_entry(
                    &op.tool,
                    &op.arguments.to_string(),
                    false,
                    Some(e.clone()),
                    source_ip.clone(),
                    Some(duration_ms),
                    None,
                    None,
                    None,
                    None,
                    None,
                ),
            };
            // 把子操作自己的备份路径挂到**子操作这条审计**上（审查 P2）。
            // 之前这里恒为 None，于是「一键回滚」对 batch 完全失效：用户在日志里
            // 只看到一堆 null 的备份列。sub-op 的备份是逐文件生成的，
            // 挂到各自的条目上才谈得上「回滚哪一份」。
            entry.backup_path = op_backup
                .as_ref()
                .and_then(|(bp, _)| bp.as_ref())
                .map(|p| p.to_string_lossy().into_owned());
            entry.target_path = op_backup
                .as_ref()
                .and_then(|(_, tp)| tp.as_ref())
                .map(|p| p.to_string_lossy().into_owned());
            // 同步落盘：与 http.rs::write_audit_for_call 一致。单条写盘约 6.8µs，
            // 比 spawn_blocking 的跨线程调度（~20-50µs）更省，且请求返回前审计已落盘，
            // 消除异步落盘在并发测试下的时序竞争（perf_real::batch_writes_are_audited）。
            if let Err(e) = audit::write_audit_log(&state.data_dir, &entry) {
                log::error!("batch 子操作审计写入失败：{e}");
            }
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

    Ok(json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string(&json!({
                "executed": executed,
                "total": results.len(),
                "results": results,
            })).unwrap_or_default()
        }]
    }))
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
}
