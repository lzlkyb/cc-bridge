use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, Response, StatusCode};
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Json;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use serde_json::json;
use tower::Service;

use crate::audit;
use crate::mcp::tools;
use crate::security::auth;
use crate::state::AppState;

pub async fn spawn_mcp_server(state: Arc<AppState>) {
    let config = state.config.read().await;
    let host = config.host.clone();
    let port = config.port;
    // HTTP body limit follows max file size (plus headroom for base64/JSON overhead)
    // so writing a file up to max_file_size_bytes is never rejected at the HTTP layer.
    let body_limit = (config.max_file_size_bytes as usize)
        .saturating_mul(2)
        .max(1024 * 1024);
    drop(config);

    // 保留一份用于翻转运行状态标志（router 会 move 掉 state）。
    let running_state = state.clone();

    let app = axum::Router::new()
        .route("/health", get(health_handler))
        .route("/mcp", post(mcp_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(tower_http::limit::RequestBodyLimitLayer::new(body_limit))
        .with_state(state);

    let addr = format!("{}:{}", host, port);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("Failed to bind MCP server to {}: {}", addr, e);
            running_state
                .mcp_running
                .store(false, std::sync::atomic::Ordering::Relaxed);
            return;
        }
    };

    log::info!("MCP HTTP server listening on {}", addr);
    running_state
        .mcp_running
        .store(true, std::sync::atomic::Ordering::Relaxed);

    // 手动 accept 循环（替代 axum::serve）——每连接设 TCP keepalive。
    // Windows 上 listener keepalive 参数不向 accepted socket 传递
    // （SO_KEEPALIVE=true 会传但时间/间隔回落到系统默认 2h）。
    // NAT 表 5-30min 即过期 → 必须逐连接设 keepalive(60s idle/15s 探测)。

    loop {
        let (stream, remote_addr) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                log::error!("accept error: {}", e);
                break;
            }
        };

        // TCP keepalive: 60s 空闲 → 每 15s 探测，保持 NAT 表活跃
        let _ = set_conn_keepalive(&stream);

        let router = app.clone();

        tokio::spawn(async move {
            // 为此连接注入 ConnectInfo（替代 AddrStream 机制）
            use axum::extract::ConnectInfo;

            let conn_router = router.layer(axum::middleware::from_fn(
                move |mut req: Request<Body>, next: Next| async move {
                    req.extensions_mut()
                        .insert(ConnectInfo(remote_addr));
                    next.run(req).await
                },
            ));

            let io = TokioIo::new(stream);
            let mut make_svc = conn_router.into_make_service();

            let tower_svc = match Service::call(&mut make_svc, ()).await {
                Ok(svc) => svc,
                Err(_) => return,
            };

            let hyper_svc = TowerToHyperService::new(tower_svc);
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, hyper_svc)
                .await;
        });
    }

    running_state
        .mcp_running
        .store(false, std::sync::atomic::Ordering::Relaxed);
}

/// 在已接受的 TCP 连接上启用 keepalive（60s 空闲 / 15s 间隔）。
fn set_conn_keepalive(stream: &tokio::net::TcpStream) -> std::io::Result<()> {
    use socket2::SockRef;
    let sock = SockRef::from(stream);
    sock.set_keepalive(true)?;
    let ka = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(60))
        .with_interval(Duration::from_secs(15));
    sock.set_tcp_keepalive(&ka)
}

async fn health_handler() -> impl IntoResponse {
    Json(json!({ "status": "ok", "version": "2.2.1" }))
}

async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response<Body> {
    let path = req.uri().path().to_string();

    // /health does not require auth
    if path == "/health" {
        return next.run(req).await;
    }

    let config = state.config.read().await;
    let expected_token = config.token.clone();
    drop(config);

    let auth_header = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let provided_token = auth_header.strip_prefix("Bearer ").unwrap_or("");

    if !auth::verify_token(provided_token, &expected_token) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::from(r#"{"error":"Unauthorized"}"#))
            .unwrap();
    }

    // Rate limiting
    let ip = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    let config = state.config.read().await;
    let max_req = config.rate_limit_max_requests;
    let window_ms = config.rate_limit_window_ms;
    let rate_limit_enabled = config.rate_limit_enabled;
    drop(config);

    // 限流开关（默认开）。关闭时跳过整个计数逻辑，鉴权仍在上方独立生效。
    if rate_limit_enabled {
        let now = std::time::Instant::now();
        let window_duration = std::time::Duration::from_millis(window_ms);

        {
            let mut entry = state.rate_limiter.entry(ip.clone()).or_default();
            let timestamps = entry.value_mut();
            timestamps.retain(|t| now.duration_since(*t) < window_duration);
            if timestamps.len() >= max_req as usize {
                return Response::builder()
                    .status(StatusCode::TOO_MANY_REQUESTS)
                    .body(Body::from(r#"{"error":"Rate limit exceeded"}"#))
                    .unwrap();
            }
            timestamps.push(now);
        }
    }

    next.run(req).await
}

/// 解析 MCP JSON 请求体。标准 serde_json 会拒绝字符串中的 raw control character
/// (如 `\r\n`), 但部分 MCP 客户端发送的 clientInfo.version 里可能夹带。先试严格解析,
/// 失败时把 JSON 字符串内的控制字符替换为 `\u00XX` 转义后重试。
fn parse_mcp_json(bytes: &[u8]) -> Result<serde_json::Value, serde_json::Error> {
    if let Ok(v) = serde_json::from_slice(bytes) {
        return Ok(v);
    }
    // 宽松重试: 把字符串内未转义的控制字符替换为 Unicode 转义
    let mut cleaned = Vec::with_capacity(bytes.len());
    let mut in_string = false;
    let mut escape = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if escape {
            escape = false;
            cleaned.push(b);
            i += 1;
            continue;
        }
        if in_string {
            if b == b'\\' {
                escape = true;
                cleaned.push(b);
            } else if b == b'"' {
                in_string = false;
                cleaned.push(b);
            } else if b < 0x20 {
                // 控制字符 → \u00XX
                use std::io::Write;
                let _ = write!(&mut cleaned, "\\u{:04x}", b);
            } else {
                cleaned.push(b);
            }
        } else {
            cleaned.push(b);
            if b == b'"' {
                in_string = true;
            }
        }
        i += 1;
    }
    serde_json::from_slice(&cleaned)
}

async fn mcp_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    body: Bytes,
) -> impl IntoResponse {
    let body = match parse_mcp_json(&body) {
        Ok(v) => v,
        Err(e) => {
            return Json(json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32700, "message": format!("Parse error: {}", e) }
            }))
        }
    };

    state.increment_requests().await;

    let source_ip = addr.ip().to_string();

    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");

    match method {
        "initialize" => {
            // 回显客户端请求的协议版本，保证版本协商总能成功。
            // WHY: 写死版本号会在客户端升级/降级后协商失败（历史 bug:
            // 曾写成不存在的 "2025-11-05"）。cc-bridge 只实现 tools/list +
            // tools/call，这些方法在各协议版本行为一致，回显是安全的。
            // 客户端未带版本时回退到一个稳定的已知版本。
            let protocol_version = body
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or("2025-06-18");
            Json(json!({
                "jsonrpc": "2.0",
                "id": body.get("id"),
                "result": {
                    "protocolVersion": protocol_version,
                    "capabilities": {
                        "tools": { "listChanged": false }
                    },
                    "serverInfo": {
                        "name": "cc-bridge",
                        "version": "2.2.1"
                    }
                }
            }))
        }
        "notifications/initialized" => Json(json!({
            "jsonrpc": "2.0",
            "id": null
        })),
        "tools/list" => Json(json!({
            "jsonrpc": "2.0",
            "id": body.get("id"),
            "result": { "tools": get_tool_definitions() }
        })),
        "tools/call" => {
            let tool_name = body
                .pointer("/params/name")
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let arguments = body
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(json!({}));

            let start = std::time::Instant::now();
            let result = dispatch_tool(tool_name, arguments, &state).await;
            let elapsed = start.elapsed().as_millis() as u64;

            // 审计日志开关（默认开）。关闭时不写任何调用记录。
            let audit_enabled = state.config.read().await.audit_enabled;

            match result {
                Ok(content) => {
                    if audit_enabled {
                        audit::write_audit_log(
                            &state.data_dir,
                            &audit::new_entry(
                                tool_name,
                                &format!(
                                    "{}",
                                    body.pointer("/params/arguments").unwrap_or(&json!({}))
                                ),
                                true,
                                None,
                                Some(source_ip.clone()),
                                Some(elapsed),
                            ),
                        )
                        .ok();
                    }
                    Json(json!({
                        "jsonrpc": "2.0",
                        "id": body.get("id"),
                        "result": content
                    }))
                }
                Err(e) => {
                    state.increment_errors().await;
                    if audit_enabled {
                        audit::write_audit_log(
                            &state.data_dir,
                            &audit::new_entry(
                                tool_name,
                                &format!(
                                    "{}",
                                    body.pointer("/params/arguments").unwrap_or(&json!({}))
                                ),
                                false,
                                Some(e.clone()),
                                Some(source_ip),
                                Some(elapsed),
                            ),
                        )
                        .ok();
                    }
                    Json(json!({
                        "jsonrpc": "2.0",
                        "id": body.get("id"),
                        "result": {
                            "isError": true,
                            "content": [{ "type": "text", "text": format!("Error: {}", e) }]
                        }
                    }))
                }
            }
        }
        _ => Json(json!({
            "jsonrpc": "2.0",
            "id": body.get("id"),
            "error": { "code": -32601, "message": format!("Method not found: {}", method) }
        })),
    }
}

async fn dispatch_tool(
    name: &str,
    args: serde_json::Value,
    state: &Arc<AppState>,
) -> Result<serde_json::Value, String> {
    // 只读模式：拒绝一切写操作（默认关闭）。读取/列目录/搜索/分析不受影响。
    const WRITE_TOOLS: [&str; 7] = [
        "write_files",
        "delete_files",
        "move_files",
        "copy_files",
        "edit_files",
        "create_directory",
        "remove_directory",
    ];
    if WRITE_TOOLS.contains(&name) {
        let readonly = state.config.read().await.readonly_mode;
        if readonly {
            return Err(format!(
                "只读模式已开启，已拒绝写操作 `{name}`。如需写入，请在 cc-bridge 设置页关闭「只读模式」。"
            ));
        }
    }
    match name {
        "list_allowed_roots" => {
            let parsed: tools::list_allowed_roots::ListAllowedRootsArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::list_allowed_roots::handle(parsed, state).await
        }
        "list_directory" => {
            let parsed: tools::list_directory::ListDirectoryArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::list_directory::handle(parsed, state).await
        }
        "read_files" => {
            let parsed: tools::read_files::ReadFilesArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::read_files::handle(parsed, state).await
        }
        "write_files" => {
            let parsed: tools::write_files::WriteFilesArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::write_files::handle(parsed, state).await
        }
        "edit_files" => {
            let parsed: tools::edit_files::EditFilesArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::edit_files::handle(parsed, state).await
        }
        "create_directory" => {
            let parsed: tools::create_directory::CreateDirectoryArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::create_directory::handle(parsed, state).await
        }
        "remove_directory" => {
            let parsed: tools::remove_directory::RemoveDirectoryArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::remove_directory::handle(parsed, state).await
        }
        "delete_files" => {
            let parsed: tools::delete_files::DeleteFilesArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::delete_files::handle(parsed, state).await
        }
        "move_files" => {
            let parsed: tools::move_files::MoveFilesArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::move_files::handle(parsed, state).await
        }
        "copy_files" => {
            let parsed: tools::copy_files::CopyFilesArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::copy_files::handle(parsed, state).await
        }
        "search_files" => {
            let parsed: tools::search_files::SearchFilesArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::search_files::handle(parsed, state).await
        }
        "analyze_file" => {
            let parsed: tools::analyze_file::AnalyzeFileArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::analyze_file::handle(parsed, state).await
        }
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

fn get_tool_definitions() -> serde_json::Value {
    json!([
        {
            "name": "list_allowed_roots",
            "description": "List the server's access whitelist (allowed root directories, allowed file extensions, max file size). Call this FIRST to discover which directories you can read/write before attempting any file operation.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "list_directory",
            "description": "List directory contents with optional recursion and depth limit",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path of the directory to list" },
                    "recursive": { "type": "boolean", "default": false },
                    "maxDepth": { "type": "integer", "default": 10 }
                },
                "required": ["path"]
            }
        },
        {
            "name": "read_files",
            "description": "Read one or more files, optionally by line range (1-based, inclusive). Returns UTF-8 text plus the detected encoding and newline style. Encoding auto-detection (GBK/GB18030 heuristic) is a server-side toggle, OFF by default (reads as UTF-8); pass `encoding` (e.g. \"gbk\") to force a specific decoding regardless of the toggle.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "files": {
                        "type": "array",
                        "items": {
                            "oneOf": [
                                { "type": "string" },
                                { "type": "object", "properties": { "path": { "type": "string" }, "startLine": { "type": "integer" }, "endLine": { "type": "integer" } }, "required": ["path"] }
                            ]
                        },
                        "minItems": 1
                    },
                    "startLine": { "type": "integer" },
                    "endLine": { "type": "integer" },
                    "encoding": { "type": "string", "description": "Optional forced encoding label, e.g. utf8 / gbk / gb18030. Always honored. Omit to follow the server's encoding auto-detect toggle (UTF-8 when off)." }
                },
                "required": ["files"]
            }
        },
        {
            "name": "write_files",
            "description": "Write or create files. Automatically creates parent directories and backs up before overwriting.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "files": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string" },
                                "content": { "type": "string" },
                                "encoding": { "type": "string", "enum": ["utf8", "base64"], "default": "utf8" }
                            },
                            "required": ["path", "content"]
                        },
                        "minItems": 1
                    }
                },
                "required": ["files"]
            }
        },
        {
            "name": "edit_files",
            "description": "Edit files in place by exact string replacement (like native Edit). For each file, `oldString` must match EXACTLY ONCE unless `replaceAll` is true — include enough surrounding context to be unique. Preserves the file's original encoding (a GBK file stays GBK). Backs up before writing. Far cheaper than rewriting whole files with write_files.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "files": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string" },
                                "oldString": { "type": "string", "description": "Exact text to find; must be unique in the file unless replaceAll=true" },
                                "newString": { "type": "string", "description": "Replacement text" },
                                "replaceAll": { "type": "boolean", "default": false, "description": "Replace all occurrences instead of requiring a single unique match" }
                            },
                            "required": ["path", "oldString", "newString"]
                        },
                        "minItems": 1
                    }
                },
                "required": ["files"]
            }
        },
        {
            "name": "create_directory",
            "description": "Create a directory (and any missing parents). Idempotent: succeeds if it already exists.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path of the directory to create" }
                },
                "required": ["path"]
            }
        },
        {
            "name": "remove_directory",
            "description": "Remove a directory. By default only removes an EMPTY directory (fails if non-empty). Set recursive=true to delete the entire tree — DANGEROUS, this permanently removes all contents and is not backed up.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path of the directory to remove" },
                    "recursive": { "type": "boolean", "default": false, "description": "Recursively delete all contents. Use with extreme caution." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "delete_files",
            "description": "Delete files (not directories). Backs up before deletion.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "paths": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
                },
                "required": ["paths"]
            }
        },
        {
            "name": "move_files",
            "description": "Move/rename files with cross-device fallback",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "items": { "type": "array", "items": { "type": "object", "properties": { "from": { "type": "string" }, "to": { "type": "string" } }, "required": ["from", "to"] }, "minItems": 1 }
                },
                "required": ["items"]
            }
        },
        {
            "name": "copy_files",
            "description": "Copy files, backing up destination if it exists",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "items": { "type": "array", "items": { "type": "object", "properties": { "from": { "type": "string" }, "to": { "type": "string" } }, "required": ["from", "to"] }, "minItems": 1 }
                },
                "required": ["items"]
            }
        },
        {
            "name": "search_files",
            "description": "Search files by name glob and/or content regex with context lines",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "rootPath": { "type": "string" },
                    "namePattern": { "type": "string", "description": "Glob pattern against filename" },
                    "contentPattern": { "type": "string", "description": "Regex or literal substring" },
                    "maxResults": { "type": "integer", "default": 100 }
                },
                "required": ["rootPath"]
            }
        },
        {
            "name": "analyze_file",
            "description": "Analyze a file: encoding, language, line/function/class counts (heuristic)",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }
        }
    ])
}
