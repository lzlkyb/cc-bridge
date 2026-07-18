//! MCP SSE transport（Server-Sent Events）。
//!
//! 在现有 HTTP JSON-RPC（POST /mcp）基础上新增流式通道：
//! - GET  /mcp/sse       SSE 握手 → 返回 endpoint 事件 + 保持长连接
//! - POST /mcp/messages  客户端 JSON-RPC → 通过 session 管道推回 SSE 流
//!
//! 与 HTTP 通道共享 dispatch_tool / auth / 限流 / 审计，仅 transport 层不同。
//! run_command 在 SSE 通道下逐行推送 stdout（progress 事件），命令结束时推送最终结果。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use axum::body::Body;
use axum::extract::{Query, State};
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

    // 用 BroadcastStream 把 broadcast::Receiver 转为 axum Body stream
    let rx = tx.subscribe();
    let stream = BroadcastStream::new(rx).map(|r| match r {
        Ok(msg) => {
            let bytes: axum::body::Bytes = msg.into();
            Ok::<_, std::convert::Infallible>(bytes)
        }
        Err(_) => Ok(axum::body::Bytes::new()),
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
            let _ = tx.send(resp.to_string());
        }
        "notifications/initialized" => {}
        "tools/list" => {
            let shell_type = state.config.read().await.shell_type.clone();
            let resp = json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": { "tools": crate::mcp::http::get_tool_definitions(&shell_type) }
            });
            let _ = tx.send(resp.to_string());
        }
        "tools/call" => {
            use crate::mcp::http::dispatch_tool;
            let tool_name = body
                .pointer("/params/name")
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let arguments = body
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(json!({}));

            state.increment_requests().await;
            state.record_request_time();

            let result = dispatch_tool(tool_name, arguments.clone(), &state).await;

            match result {
                Ok(content) => {
                    let resp = json!({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "result": content
                    });
                    let _ = tx.send(resp.to_string());
                }
                Err(e) => {
                    let resp = json!({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": { "code": -32000, "message": e }
                    });
                    let _ = tx.send(resp.to_string());
                }
            }
        }
        _ => {
            let resp = json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": { "code": -32601, "message": format!("Method not found: {}", method) }
            });
            let _ = tx.send(resp.to_string());
        }
    }

    (StatusCode::ACCEPTED, Json(json!({})))
}
