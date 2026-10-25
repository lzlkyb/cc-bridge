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
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
) -> Response<Body> {
    let provided = params.get("token").map(|s| s.as_str()).unwrap_or("");
    let (expected, ban_active) = {
        let c = state.config.read().await;
        (c.token.clone(), crate::mcp::http::is_ban_active(&c))
    };
    if !crate::security::auth::verify_token(provided, &expected) {
        // 与 /mcp 同口径：握手 401 也算一次鉴权失败（否则可以先爆破握手再爆破消息端点）。
        state.inc_auth_denies();
        if ban_active {
            state.ban.record_failure(addr.ip());
        }
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::from(r#"{"error":"Unauthorized"}"#))
            .unwrap();
    }
    if ban_active {
        state.ban.record_success(addr.ip());
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

    // 🔴 端点 URL 里带上 token：`/mcp/messages` 现在**必须**带 token（见下方
    // `sse_message_handler` 的鉴权），而客户端只会照搬这里给它的 URL。
    // 不算新增暴露面——token 本来就已经在这次握手的 query 里（`?token=`）。
    let endpoint_url = format!("/mcp/messages?sessionId={}&token={}", session_id, expected);

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
///
/// 🔴 **鉴权（M17 的后半段）**：此前这个端点完全免 token，只认 URL 里的 `sessionId`——
/// 而 sessionId 会出现在 URL 上（代理、访问日志、浏览器历史都可能留存），
/// 拿到它等于拿到这条会话的工具调用权（`tools/call` 就在这条路径上）。
/// 现在与其它端点同口径校验 token：优先 `Authorization: Bearer`（标准做法），
/// 其次 query 的 `token`（端点 URL 自带，兼容只会照搬 URL 的客户端）。
pub async fn sse_message_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let (expected, ban_active) = {
        let c = state.config.read().await;
        (c.token.clone(), crate::mcp::http::is_ban_active(&c))
    };
    let from_header = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let provided = if from_header.is_empty() {
        params.get("token").map(|s| s.as_str()).unwrap_or("")
    } else {
        from_header
    };
    if !crate::security::auth::verify_token(provided, &expected) {
        // 与 /mcp 同一治理口径：鉴权拒绝计入 authDenies，并计入封禁表的失败计数
        // （这条端点是 SSE 的工具调用面，封禁若要生效就必须在这里记账）。
        state.inc_auth_denies();
        if ban_active {
            state.ban.record_failure(addr.ip());
        }
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Unauthorized"})),
        );
    }
    if ban_active {
        state.ban.record_success(addr.ip());
    }

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
                    "serverInfo": { "name": "cc-bridge", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": crate::mcp::http::server_instructions(
                        crate::mcp::client_kind::ClientKind::from_initialize(&body)
                    )
                }
            });
            let _ = tx.send(sse_data_frame(&resp));
        }
        "notifications/initialized" => {}
        "tools/list" => {
            let shell_type = state.config.read().await.shell_type.clone();
            // 与 HTTP transport 保持一致：`mcp_proxy` 的描述带上已挂载 server 的工具名。
            // 两边必须同步，否则换一种 transport 连进来就搜不到外挂工具了。
            let proxy_hint = crate::mcp::tools::mcp_proxy::keyword_hint(&state).await;
            let resp = json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "tools": crate::mcp::http::get_tool_definitions(&shell_type, proxy_hint.as_deref()),
                    // list-caching 提示（MCP 2025-11-05+，向后兼容：旧客户端忽略未知字段）。
                    // 目录不再静态，取舍理由见 http.rs 同位置注释。
                    "ttlMs": 3_600_000,
                    // 🔴 必须是 `"private"`（枚举只有 public / private）。
                    // 这里曾写 `"user"`：http 通道早已判定该值非法并改掉，SSE 漏改 →
                    // 客户端按未知值忽略整段提示，「别跨会话共享工具描述」的意图不生效。
                    // 两通道此字段必须逐字一致。
                    "cacheScope": "private"
                }
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

            // 🔴 必须在进入 `async move` 之前算好：`prepare_upload` / `prepare_download`
            // 靠 base_url 作用域拼出「调用方真能连上」的 /transfer 绝对地址。缺这个作用域
            // 时它们会回退到「配置 host + 端口」（绑 0.0.0.0 时取首张网卡），一旦客户端是从
            // localhost:自定义端口 / 反向代理进来的，拼出的 URL 就直接连不上。
            // HTTP 通道早已注入（`mcp_handler`），SSE 通道此前漏了 —— 同一个工具换 transport 就坏。
            let transfer_base = crate::mcp::transfer::base_url(&headers, &state).await;

            let resp =
                crate::timing::with_io_timer(async move {
                    crate::audit::with_op_backup(async {
                    let start = std::time::Instant::now();
                    // 注入 source_ip 作用域，使 SSE 通道下 batch 子操作的审计也能拿到 sourceIp。
                    let result = crate::audit::with_source_ip(
                        Some(source_ip.clone()),
                        crate::mcp::transfer::with_base_url(
                            transfer_base,
                            dispatch_tool(&tool_name, arguments.clone(), &state),
                        ),
                    )
                    .await;
                    let elapsed = start.elapsed().as_millis() as u64;
                    state.record_latency(elapsed);
                    state.record_tool(&tool_name);
                    let io_ms = crate::timing::take_io();
                    let server_ms = t_recv.elapsed().as_millis() as u64;
                    let audit_enabled = state.config.read().await.audit_enabled;
                    // 用量归属：与 HTTP 通道同口径（见 `CcSession::active_session_id`）。
                    let cc_session_id = state.cc.active_session_id();
                    match result {
                        Ok(content) => {
                            if audit_enabled {
                                // Token 用量估算埋点：结果里 text 块的字节数（与 http 通道同口径，
                                // 图片块按 0 计——见 `tools::result_text_bytes`）；wire 字符数
                                // 另算一份（批 4-1 的降级判定按字符，见 `wire_chars`）。
                                let result_bytes =
                                    Some(crate::mcp::tools::result_text_bytes(&content));
                                let result_chars =
                                    crate::mcp::tools::wire_chars_opt(&content);
                                write_audit_for_call(
                                    &state.data_dir, &tool_name, &arguments, true, None,
                                    Some(source_ip.clone()), elapsed, server_ms, io_ms, None,
                                    cc_session_id.clone(),
                                    result_bytes,
                                    result_chars,
                                );
                                state.inc_audit_count();
                            }
                            // 与 HTTP 通道同形状：`result` 必带 `resultType`（规范第 8 条，
                            // 缺失时客户端按 complete 处理，无条件加即可）。
                            let mut result = content;
                            if let Some(obj) = result.as_object_mut() {
                                obj.insert("resultType".into(), json!("complete"));
                            }
                            json!({ "jsonrpc": "2.0", "id": request_id, "result": result })
                        }
                        Err(e) => {
                            state.increment_errors().await;
                            if audit_enabled {
                                // 错误文案会进入模型上下文，按 "Error: {e}" 长度估算（与 http 通道同口径）。
                                // 字符数与字节同值：纯文案，且短到不可能越线。
                                let err_len = ("Error: ".len() + e.len()) as u64;
                                let result_bytes = Some(err_len);
                                write_audit_for_call(
                                    &state.data_dir, &tool_name, &arguments, false, Some(e.clone()),
                                    Some(source_ip.clone()), elapsed, server_ms, io_ms, None,
                                    cc_session_id.clone(),
                                    result_bytes,
                                    Some(err_len),
                                );
                                state.inc_audit_count();
                            }
                            // 🔴 **工具级失败要回 result{isError:true}，不是协议级 -32000**。
                            // 同一个错误在 http 通道是「工具跑失败了、这是诊断信息」，
                            // 到 SSE 变成「协议故障」——客户端按协议错误处理，模型拿不到
                            // 可自纠的文案。两条通道必须同一语义（审查 §二·协议层）。
                            json!({
                                "jsonrpc": "2.0",
                                "id": request_id,
                                "result": {
                                    "resultType": "complete",
                                    "isError": true,
                                    "content": [{ "type": "text", "text": format!("Error: {}", e) }]
                                }
                            })
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
