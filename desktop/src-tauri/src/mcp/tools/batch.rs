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
    for (idx, op) in args.operations.iter().enumerate() {
        if op.tool == "batch" {
            return Err(format!("operation[{idx}]: nested batch is not allowed"));
        }
    }
    Ok(())
}

pub async fn handle(args: BatchArgs, state: &Arc<AppState>) -> Result<Value, String> {
    validate_batch(&args)?;

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
        let t0 = std::time::Instant::now();
        let res = crate::audit::with_op_backup(Box::pin(dispatch_tool(
            &op.tool,
            op.arguments.clone(),
            state,
        )))
        .await;
        // 子操作自身的分发耗时：修复之前全传 None 导致日志列表里 batch 相关行耗时列一律
        // 显示“—”的问题。
        let duration_ms = t0.elapsed().as_millis() as u64;

        // 逐子操作补审计：外层工具调用只记一条，写操作必须单独留痕，否则绕过审计。
        // server_ms/io_ms/audit_ms/net_ms 仍不单独测（io 归并到 batch 外层审计的 ioMs，作用域
        // 穿透生效），但 duration_ms 现在具体测了，日志列表不再一片“—”。
        if audit_enabled {
            let entry = match &res {
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
        let args = BatchArgs {
            operations: vec![BatchOp {
                tool: "read_files".into(),
                arguments: json!({ "files": ["C:\\Windows\\System32\\cmd.exe"] }),
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
