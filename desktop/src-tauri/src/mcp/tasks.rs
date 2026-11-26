//! MCP Tasks 扩展（SEP-2663，扩展 ID `io.modelcontextprotocol/tasks`）的协议皮。
//!
//! ## 现状：阶段 0 探针版，默认关闭
//!
//! 只有设置环境变量 `CC_BRIDGE_TASKS=1` 才会生效。目的是用真实的 Claude Code 验证
//! 三件事，再决定要不要做完整版（方案见 `docs/MCP-Skills与Tasks适配评估-2026-11-25.md`）：
//! 1. 它是否在请求里声明了 tasks 扩展；
//! 2. 收到任务后，是自己轮询、只把最终结果给模型，还是把轮询暴露给模型；
//! 3. 命令超过客户端约 60s 断线线的情况是否消失。
//!
//! ## 设计：复用现有的后台命令表，不新建状态机
//!
//! `running_commands` 里的每一条本来就是一个任务（有 id、有状态、能终止、能取结果）。
//! 这里只加协议皮：
//! - **创建**：只在 `tools/call` 的协议层把 `run_command` 的「转后台」结果包成任务
//!   （`taskId` 直接用现有 handle）。`run_command` 与 `batch` 本身不改，所以 batch 里的
//!   子命令永远不会变成任务。
//! - **查询**：`tasks/get` 复用 `wait_command` 的「只看一眼」（`timeoutSec:0`）。
//! - **取消**：`tasks/cancel` 复用 `stop_command` 的终止实现。
//! - **更新**：`tasks/update` 只回空确认——我们永远不会进入 `input_required`。
//!
//! 服务端是「是否创建任务」的唯一决定者：客户端没在请求里声明扩展时，一律走原路径
//! （`backgrounded` + `handle`），规范也明确禁止此时返回任务。
//!
//! ## 诚实的限制
//! - 任务只在进程存活期内有效（内存表），`ttlMs` 取命令结果的保留时长，不承诺跨重启。
//! - `createdAt` 由命令启动时刻反推，精度到秒，可能在秒界上相差 1s。
//! - SSE 传输与 `initialize`（老协议）不声明、不支持本扩展。

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

use crate::mcp::tools::stop_command;
use crate::mcp::tools::wait_command::{self, WaitCommandArgs};
use crate::state::{AppState, UNREAD_RESULT_RETENTION};

/// 扩展 ID（规范固定字符串，勿改）。
pub const EXT_TASKS: &str = "io.modelcontextprotocol/tasks";
/// 客户端能力在每个请求 `params._meta` 里的键（规范固定字符串，勿改）。
const META_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
/// 规范错误码：`MISSING_REQUIRED_CLIENT_CAPABILITY`。
const ERR_MISSING_CLIENT_CAPABILITY: i64 = -32021;
const ERR_INVALID_PARAMS: i64 = -32602;
const ERR_INTERNAL: i64 = -32603;
/// 建议客户端的轮询间隔。进度粒度是「读管道缓冲」，比外部服务细，不需要 5s。
const POLL_INTERVAL_MS: u64 = 1500;

/// 探针开关。阶段 0 用环境变量，免得为一个可能被放弃的实验去动配置结构与界面。
pub fn enabled() -> bool {
    std::env::var("CC_BRIDGE_TASKS").is_ok_and(|v| v == "1")
}

/// `server/discover` 的 `capabilities`：探针开关打开时才声明 tasks 扩展。
pub fn discover_capabilities() -> Value {
    let mut caps = json!({ "tools": { "listChanged": false } });
    if enabled() {
        caps["extensions"] = json!({ EXT_TASKS: {} });
    }
    caps
}

/// 这个请求是否在 `_meta` 里声明了某个扩展（空对象即表示支持）。
pub fn client_declares(body: &Value, ext: &str) -> bool {
    body.pointer("/params/_meta")
        .and_then(|m| m.get(META_CLIENT_CAPABILITIES))
        .and_then(|c| c.get("extensions"))
        .and_then(|e| e.get(ext))
        .is_some_and(Value::is_object)
}

fn rpc_error(id: Option<&Value>, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut err = json!({ "code": code, "message": message });
    if let Some(d) = data {
        err["data"] = d;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": err })
}

fn not_found(id: Option<&Value>) -> Value {
    rpc_error(
        id,
        ERR_INVALID_PARAMS,
        "Failed to retrieve task: Task not found",
        None,
    )
}

fn ack(id: Option<&Value>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "resultType": "complete" } })
}

fn iso(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 由命令启动时刻反推创建时间（见模块注释的精度说明）。
fn created_at(started: std::time::Instant) -> String {
    let age =
        chrono::Duration::from_std(started.elapsed()).unwrap_or_else(|_| chrono::Duration::zero());
    iso(chrono::Utc::now() - age)
}

/// `Task` 的公共字段。`ttlMs` 如实取命令结果的保留时长（进程存活期内有效）。
fn task_fields(task_id: &str, status: &str, created: String, message: Option<String>) -> Value {
    let mut t = json!({
        "taskId": task_id,
        "status": status,
        "createdAt": created,
        "lastUpdatedAt": iso(chrono::Utc::now()),
        "ttlMs": UNREAD_RESULT_RETENTION.as_millis() as u64,
        "pollIntervalMs": POLL_INTERVAL_MS,
    });
    if let Some(m) = message {
        t["statusMessage"] = json!(m);
    }
    t
}

/// 把 `run_command` 的「转后台」结果包成 `CreateTaskResult`；不满足条件返回 `None`
/// （调用方照原样返回原结果）。**不检查开关**，开关由 [`create_task_result`] 管。
///
/// 条件：客户端声明了扩展、工具是 `run_command`、确实转了后台（显式 `background:true`
/// 或超时自动转交）、且 handle 在注册表里。
fn seed_from_result(
    body: &Value,
    tool_name: &str,
    arguments: &Value,
    result: &Value,
    state: &AppState,
) -> Option<Value> {
    if tool_name != "run_command" || !client_declares(body, EXT_TASKS) {
        return None;
    }
    let info: Value = serde_json::from_str(result.pointer("/content/0/text")?.as_str()?).ok()?;
    let handle = info.get("handle")?.as_str()?;
    let background = arguments
        .get("background")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || info
            .get("backgrounded")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if !background {
        return None;
    }
    let started = state.running_commands.get(handle)?.started_at;
    let mut task = task_fields(
        handle,
        "working",
        created_at(started),
        Some("命令已在后台运行，用 tasks/get 查询状态与结果".into()),
    );
    task["resultType"] = json!("task");
    Some(task)
}

/// `tools/call` 协议层的入口：开关开着且满足条件时，返回要替换原结果的任务；否则 `None`。
pub fn create_task_result(
    body: &Value,
    tool_name: &str,
    arguments: &Value,
    result: &Value,
    state: &AppState,
) -> Option<Value> {
    if !enabled() {
        return None;
    }
    seed_from_result(body, tool_name, arguments, result, state)
}

/// 把 `wait_command` 的「只看一眼」结果翻译成 `DetailedTask`（纯函数，便于单测）。
///
/// 映射：已被终止 → `cancelled`；仍在运行 → `working`；其余（已结束）→ `completed`，
/// 结果就是 wait_command 返回的那份内容。命令退出码非 0 也算 `completed`：规范要求
/// `failed` 只用于 JSON-RPC 错误，工具层面的失败要放在 `completed` 的 result 里。
fn task_view(task_id: &str, created: String, info: &Value, out: &Value) -> Value {
    let flag = |k: &str| info.get(k).and_then(Value::as_bool).unwrap_or(false);
    if flag("terminated") {
        return task_fields(task_id, "cancelled", created, Some("命令已被终止".into()));
    }
    if flag("running") {
        let secs = info.get("elapsedSecs").and_then(Value::as_u64).unwrap_or(0);
        return task_fields(
            task_id,
            "working",
            created,
            Some(format!("运行中，已 {secs}s")),
        );
    }
    let mut t = task_fields(task_id, "completed", created, None);
    t["result"] = out.clone();
    t
}

/// 处理 `tasks/get` / `tasks/update` / `tasks/cancel`。调用方负责先判断开关。
pub async fn handle_method(method: &str, body: &Value, state: &Arc<AppState>) -> Value {
    let id = body.get("id");
    // 没声明扩展的客户端调 tasks/*：规范要求 -32021 并指出需要的扩展。
    if !client_declares(body, EXT_TASKS) {
        return rpc_error(
            id,
            ERR_MISSING_CLIENT_CAPABILITY,
            "Missing required client capability",
            Some(json!({ "requiredCapabilities": { "extensions": { EXT_TASKS: {} } } })),
        );
    }
    let Some(task_id) = body.pointer("/params/taskId").and_then(Value::as_str) else {
        return rpc_error(
            id,
            ERR_INVALID_PARAMS,
            "Invalid params: taskId is required",
            None,
        );
    };
    match method {
        "tasks/get" => get(id, task_id, state).await,
        "tasks/cancel" => match stop_command::terminate(state, task_id).await {
            Ok(_) => ack(id),
            Err(e) if e.contains("未知的 handle") => not_found(id),
            Err(e) => rpc_error(id, ERR_INTERNAL, &e, None),
        },
        // 我们永远不会进入 input_required，没有需要回填的输入：存在即确认。
        "tasks/update" => {
            if state.running_commands.contains_key(task_id) {
                ack(id)
            } else {
                not_found(id)
            }
        }
        _ => rpc_error(id, -32601, &format!("Method not found: {method}"), None),
    }
}

async fn get(id: Option<&Value>, task_id: &str, state: &Arc<AppState>) -> Value {
    let Some(started) = state.running_commands.get(task_id).map(|e| e.started_at) else {
        return not_found(id);
    };
    // timeoutSec:0 = 只看一眼、不等待。默认格式即可：第 1 块是状态 JSON，其后是输出块。
    let out = wait_command::handle(
        WaitCommandArgs {
            handle: task_id.to_string(),
            timeout_sec: 0,
            until_pattern: None,
            tail_lines: None,
            format: None,
            include: None,
            exclude: None,
        },
        state,
    )
    .await;
    let Ok(out) = out else {
        // 条目在两步之间被清理了。
        return not_found(id);
    };
    let info: Value = out
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null);
    let mut result = task_view(task_id, created_at(started), &info, &out);
    // 规范：tasks/get 的结果自身是标准结果，resultType 必须是 complete。
    result["resultType"] = json!("complete");
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 记录客户端声明了什么（每种组合只记一次）。
///
/// 阶段 0 要回答的第一个问题：真实的 Claude Code 在请求里声明 tasks / skills 扩展吗？
/// 以什么协议版本连上来？不依赖任何开关，默认就记。
pub fn probe_client(body: &Value, method: &str) {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let ver = body
        .pointer("/params/_meta")
        .and_then(|m| m.get("io.modelcontextprotocol/protocolVersion"))
        .and_then(Value::as_str)
        .or_else(|| {
            body.pointer("/params/protocolVersion")
                .and_then(Value::as_str)
        })
        .unwrap_or("-");
    let exts = body
        .pointer("/params/_meta")
        .and_then(|m| m.get(META_CLIENT_CAPABILITIES))
        .and_then(|c| c.get("extensions"))
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect::<Vec<_>>().join(","))
        .unwrap_or_default();
    let client = body
        .pointer("/params/clientInfo/name")
        .and_then(Value::as_str)
        .map(|n| {
            let v = body
                .pointer("/params/clientInfo/version")
                .and_then(Value::as_str)
                .unwrap_or("?");
            format!("{n}/{v}")
        })
        .unwrap_or_default();
    let sig = format!("method={method} protocol={ver} extensions=[{exts}] client={client}");
    if let Ok(mut seen) = SEEN.get_or_init(|| Mutex::new(HashSet::new())).lock() {
        if seen.len() < 64 && seen.insert(sig.clone()) {
            log::info!(target: "mcp::probe", "客户端能力 {sig}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::run_command::{self, RunCommandArgs};
    use crate::mcp::tools::testutil::make_state;

    fn declared(extra: Value) -> Value {
        let mut b = json!({
            "jsonrpc": "2.0", "id": 7,
            "params": { "_meta": { META_CLIENT_CAPABILITIES: { "extensions": { EXT_TASKS: {} } } } }
        });
        if let (Some(p), Some(e)) = (b["params"].as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                p.insert(k.clone(), v.clone());
            }
        }
        b
    }

    #[test]
    fn declares_only_with_object_under_extensions() {
        assert!(client_declares(&declared(json!({})), EXT_TASKS));
        assert!(!client_declares(&json!({ "params": {} }), EXT_TASKS));
        // 只在 legacy 的 capabilities.tasks 里声明（2025-11-25 实验版）不算：两者不兼容。
        let legacy = json!({ "params": { "capabilities": { "tasks": {} } } });
        assert!(!client_declares(&legacy, EXT_TASKS));
        // 值不是对象不算支持。
        let bad = json!({ "params": { "_meta": { META_CLIENT_CAPABILITIES:
            { "extensions": { EXT_TASKS: true } } } } });
        assert!(!client_declares(&bad, EXT_TASKS));
    }

    #[test]
    fn task_view_maps_states_per_spec() {
        let created = "2026-11-26T00:00:00Z".to_string();
        let out = json!({ "content": [{ "type": "text", "text": "{}" }] });

        let working = task_view(
            "cmd_1",
            created.clone(),
            &json!({ "running": true, "elapsedSecs": 12 }),
            &out,
        );
        assert_eq!(working["status"], json!("working"));
        assert!(working.get("result").is_none(), "进行中不带 result");

        let cancelled = task_view(
            "cmd_1",
            created.clone(),
            &json!({ "terminated": true }),
            &out,
        );
        assert_eq!(cancelled["status"], json!("cancelled"));

        // 退出码非 0 仍是 completed：failed 只留给 JSON-RPC 错误。
        let done = task_view(
            "cmd_1",
            created.clone(),
            &json!({ "running": false, "exitCode": 2 }),
            &out,
        );
        assert_eq!(done["status"], json!("completed"));
        assert_eq!(done["result"], out);
        assert_eq!(done["createdAt"], json!(created));
        assert!(done["ttlMs"].as_u64().is_some_and(|t| t > 0));
        assert_eq!(done["pollIntervalMs"], json!(POLL_INTERVAL_MS));
    }

    /// 起一条短后台命令，返回 (state, handle, run_command 的原结果)。
    async fn spawn_background(command: &str) -> (Arc<AppState>, String, Value) {
        let (state, dir) = make_state(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let out = run_command::handle(
            RunCommandArgs {
                command: command.into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: true,
                timeout_ms: 120_000,
                max_output_bytes: 1024 * 1024,
                include: None,
                exclude: None,
                tail_lines: None,
                format: Some("json".into()),
                env: None,
                description: None,
            },
            &state,
        )
        .await
        .expect("后台命令应能启动");
        let handle = out["content"][0]["text"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v["handle"].as_str().map(String::from))
            .expect("handle");
        (state, handle, out)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn seed_only_for_declared_background_run_command() {
        let (state, handle, out) = spawn_background("echo seed_ok").await;
        let args = json!({ "command": "echo seed_ok", "background": true });

        let seed = seed_from_result(&declared(json!({})), "run_command", &args, &out, &state)
            .expect("声明了扩展的后台命令应变成任务");
        assert_eq!(seed["resultType"], json!("task"));
        assert_eq!(seed["taskId"], json!(handle));
        assert_eq!(seed["status"], json!("working"));

        // 没声明扩展：绝不返回任务（规范禁止）。
        let plain = json!({ "jsonrpc": "2.0", "id": 1, "params": {} });
        assert!(seed_from_result(&plain, "run_command", &args, &out, &state).is_none());
        // 其它工具永远不变任务。
        assert!(
            seed_from_result(&declared(json!({})), "read_files", &args, &out, &state).is_none()
        );
        // 前台命令（没转后台）不变任务。
        let fg = json!({ "command": "echo x" });
        let fg_out = json!({ "content": [{ "type": "text", "text": "{\"exitCode\":0}" }] });
        assert!(
            seed_from_result(&declared(json!({})), "run_command", &fg, &fg_out, &state).is_none()
        );

        let _ = stop_command::terminate(&state, &handle).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_cancel_update_follow_spec() {
        let (state, handle, _out) = spawn_background("echo task_payload_ok").await;

        // 轮询到 completed（命令很短）。
        let mut done = Value::Null;
        for _ in 0..50 {
            let r =
                handle_method("tasks/get", &declared(json!({ "taskId": handle })), &state).await;
            if r["result"]["status"] == json!("completed") {
                done = r;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(done["result"]["status"], json!("completed"), "{done}");
        assert_eq!(done["result"]["resultType"], json!("complete"));
        assert!(
            done["result"]["result"]
                .to_string()
                .contains("task_payload_ok"),
            "结果应带命令输出：{done}"
        );

        // update / cancel：存在即空确认。
        let upd = handle_method(
            "tasks/update",
            &declared(json!({ "taskId": handle })),
            &state,
        )
        .await;
        assert_eq!(upd["result"]["resultType"], json!("complete"));
        let can = handle_method(
            "tasks/cancel",
            &declared(json!({ "taskId": handle })),
            &state,
        )
        .await;
        assert_eq!(can["result"]["resultType"], json!("complete"), "{can}");

        // 不存在的 taskId：-32602。
        let nf = handle_method(
            "tasks/get",
            &declared(json!({ "taskId": "cmd_nope" })),
            &state,
        )
        .await;
        assert_eq!(nf["error"]["code"], json!(-32602));
        // 没声明扩展：-32021，并指出需要的扩展。
        let miss = handle_method(
            "tasks/get",
            &json!({ "id": 1, "params": { "taskId": handle } }),
            &state,
        )
        .await;
        assert_eq!(miss["error"]["code"], json!(-32021));
        assert!(miss["error"]["data"]["requiredCapabilities"]["extensions"]
            .get(EXT_TASKS)
            .is_some());
        // 缺 taskId：-32602。
        let bad = handle_method("tasks/get", &declared(json!({})), &state).await;
        assert_eq!(bad["error"]["code"], json!(-32602));
    }
}
