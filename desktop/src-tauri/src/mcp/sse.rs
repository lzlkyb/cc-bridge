//! MCP SSE transport（Server-Sent Events）。
//!
//! 在现有 HTTP JSON-RPC（POST /mcp）基础上新增流式通道：
//! - GET  /mcp/sse       SSE 握手 → 返回 endpoint 事件 + 保持长连接
//! - POST /mcp/messages  客户端 JSON-RPC → 通过 session 管道推回 SSE 流
//!
//! 与 HTTP 通道共享 dispatch_tool / auth / 限流 / 审计，仅 transport 层不同。
//! 注：当前 SSE 通道与 HTTP 一样是“请求 → 单条最终响应”，**并未**对 run_command 做逐行
//! stdout 流式推送（后台命令输出仍由 get_command_output 轮询获取）。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use axum::body::Body;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::state::AppState;

/// SSE 会话注册表。
pub type SseRegistry = StdMutex<HashMap<String, SseSession>>;

pub fn new_registry() -> SseRegistry {
    StdMutex::new(HashMap::new())
}

pub struct SseSession {
    pub tx: tokio::sync::broadcast::Sender<String>,
    pub created: std::time::Instant,
}

/// M16 修复：把 JSON-RPC 响应封装成合规 SSE 数据帧（`event: message\ndata: <json>\n\n`）。
/// 旧实现直接 send 裸 JSON 字符串，缺 `data:` 前缀与空行终止符，合规 SSE 客户端永不派发事件。
fn sse_data_frame(v: &serde_json::Value) -> String {
    format!("event: message\ndata: {}\n\n", v)
}

/// M18 修复：SSE 连接结束（响应体 stream 被 drop）时从注册表移除对应 session，
/// 避免只增不删的泄漏（旧实现反复建连会泄漏 HashMap 条目 + 256 容量 channel）。
struct SessionCleanup {
    state: Arc<AppState>,
    session_id: String,
}
impl Drop for SessionCleanup {
    fn drop(&mut self) {
        if let Ok(mut reg) = self.state.sse_registry.lock() {
            reg.remove(&self.session_id);
        }
    }
}

/// SSE 握手：GET /mcp/sse?token=xxx
pub async fn sse_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response<Body> {
    let provided = params.get("token").map(|s| s.as_str()).unwrap_or("");
    let expected = state.config.read().await.token.clone();
    if !crate::security::auth::verify_token(provided, &expected) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::from(r#"{"error":"Unauthorized"}"#))
            .unwrap();
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, _) = tokio::sync::broadcast::channel::<String>(256);

    {
        let mut reg = state.sse_registry.lock().unwrap();
        reg.insert(
            session_id.clone(),
            SseSession {
                tx: tx.clone(),
                created: std::time::Instant::now(),
            },
        );
    }

    let endpoint_url = format!("/mcp/messages?sessionId={}", session_id);

    // 用 BroadcastStream 把 broadcast::Receiver 转为 axum Body stream。
    // M18：cleanup 随 stream 存活，连接断开 stream 被 drop 时移除注册表里的 session。
    let cleanup = SessionCleanup {
        state: state.clone(),
        session_id: session_id.clone(),
    };
    let rx = tx.subscribe();
    let stream = BroadcastStream::new(rx).map(move |r| {
        let _keep = &cleanup;
        match r {
            Ok(msg) => {
                let bytes: axum::body::Bytes = msg.into();
                Ok::<_, std::convert::Infallible>(bytes)
            }
            Err(e) => {
                // Lagged(n)：接收端积压超过 channel 容量，丢失了 n 条响应。无法恢复，
                // 但必须记录，不能像旧实现那样静默吞成空帧（客户端会永久缺响应且毫无线索）。
                log::warn!("SSE broadcast 流滞后/出错，部分响应可能丢失: {e}");
                Ok(axum::body::Bytes::new())
            }
        }
    });

    let endpoint_line = format!("event: endpoint\ndata: {}\n\n", endpoint_url);
    let full_stream = tokio_stream::once(Ok::<_, std::convert::Infallible>(
        axum::body::Bytes::from(endpoint_line),
    ))
    .chain(stream);

    let body = Body::from_stream(full_stream);

    Response::builder()
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .body(body)
        .unwrap()
}

/// SSE 消息投递：POST /mcp/messages?sessionId=xxx
pub async fn sse_message_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let session_id = match params.get("sessionId") {
        Some(id) => id.clone(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "Missing sessionId query parameter"})),
            );
        }
    };

    let tx = {
        let reg = state.sse_registry.lock().unwrap();
        reg.get(&session_id).map(|s| s.tx.clone())
    };

    let tx = match tx {
        Some(tx) => tx,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "Unknown SSE session"})),
            );
        }
    };

    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let request_id = body.get("id").cloned();

    match method {
        "initialize" => {
            let protocol_version = body
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or("2025-06-18");
            let resp = json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": protocol_version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "cc-bridge", "version": env!("CARGO_PKG_VERSION") }
                }
            });
            let _ = tx.send(sse_data_frame(&resp));
        }
        "notifications/initialized" => {}
        "tools/list" => {
            let shell_type = state.config.read().await.shell_type.clone();
            let resp = json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": { "tools": crate::mcp::http::get_tool_definitions(&shell_type) }
            });
            let _ = tx.send(sse_data_frame(&resp));
        }
        "tools/call" => {
            use crate::mcp::http::{dispatch_tool, write_audit_for_call};
            // H2 修复：与 HTTP 通道一致，用 with_io_timer + with_op_backup 包裹 dispatch，
            // 否则写工具的 record_op_backup 会在未建立 OP_BACKUP task_local 作用域时 panic。
            // H3 修复：补齐审计——SSE 通道此前完全不写 audit.log，绕过「所有操作受审计」模型。
            let state = state.clone();
            let tool_name = body
                .pointer("/params/name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = body
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(json!({}));

            state.increment_requests().await;
            state.record_request_time();
            let source_ip = addr.ip().to_string();
            let t_recv = std::time::Instant::now();

            let resp = crate::timing::with_io_timer(async move {
                crate::audit::with_op_backup(async {
                    let start = std::time::Instant::now();
                    // 注入 source_ip 作用域，使 SSE 通道下 batch 子操作的审计也能拿到 sourceIp。
                    let result = crate::audit::with_source_ip(
                        Some(source_ip.clone()),
                        dispatch_tool(&tool_name, arguments.clone(), &state),
                    )
                    .await;
                    let elapsed = start.elapsed().as_millis() as u64;
                    state.record_latency(elapsed);
                    state.record_tool(&tool_name);
                    let io_ms = crate::timing::take_io();
                    let server_ms = t_recv.elapsed().as_millis() as u64;
                    let audit_enabled = state.config.read().await.audit_enabled;
                    match result {
                        Ok(content) => {
                            if audit_enabled {
                                write_audit_for_call(
                                    &state.data_dir, &tool_name, &arguments, true, None,
                                    Some(source_ip.clone()), elapsed, server_ms, io_ms, None,
                                );
                                state.inc_audit_count();
                            }
                            json!({ "jsonrpc": "2.0", "id": request_id, "result": content })
                        }
                        Err(e) => {
                            state.increment_errors().await;
                            if audit_enabled {
                                write_audit_for_call(
                                    &state.data_dir, &tool_name, &arguments, false, Some(e.clone()),
                                    Some(source_ip.clone()), elapsed, server_ms, io_ms, None,
                                );
                                state.inc_audit_count();
                            }
                            json!({ "jsonrpc": "2.0", "id": request_id, "error": { "code": -32000, "message": e } })
                        }
                    }
                })
                .await
            })
            .await;
            let _ = tx.send(sse_data_frame(&resp));
        }
        _ => {
            let resp = json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": { "code": -32601, "message": format!("Method not found: {}", method) }
            });
            let _ = tx.send(sse_data_frame(&resp));
        }
    }

    (StatusCode::ACCEPTED, Json(json!({})))
}
