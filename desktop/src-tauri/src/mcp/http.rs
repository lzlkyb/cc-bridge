use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, Response, StatusCode};
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Json;
use serde_json::json;

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

    if let Err(e) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    {
        log::error!("MCP server error: {}", e);
    }
    // serve 返回（被 abort 或出错）时标记为停止
    running_state
        .mcp_running
        .store(false, std::sync::atomic::Ordering::Relaxed);
}

async fn health_handler() -> impl IntoResponse {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

/// 把 axum 拿到的 ConnectInfo 转成限流键字符串。
///
/// D1（2026-07-10 修复）前是从请求头 `x-forwarded-for` 取——那是客户端可
/// 以任意填写的字符串，攻击者改 IP 头就能不断换"新 IP"绕过限流。修复后
/// 必须用 TCP 层的对端地址，该地址由内核填入、攻击者无法控制。
///
/// `headers` 参数存在是提醒读者：客户端 header 不能参与 key。函数体直接丢弃。
pub fn rate_limit_key(addr: SocketAddr, headers: &axum::http::HeaderMap) -> String {
    // 显式忽略 `headers`——保留在签名里是为了让代码审计能一眼看清"x-forwarded-for
    // 不应被读"，未来如果有人想动这里加 header 逻辑，函数签名就在面前。
    let _ = headers;
    addr.ip().to_string()
}

async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
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

    // Rate limiting：限流键用 ConnectInfo 拿到的真实对端 IP，不能用
    // `x-forwarded-for`——那是客户端自己发的请求头，任何调用方都能伪造，
    // 换个假 IP 就能无限绕过限流（D1，2026-07-10 修复）。
    let ip = rate_limit_key(addr, req.headers());

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

async fn mcp_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
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
                        "version": env!("CARGO_PKG_VERSION")
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
    const WRITE_TOOLS: [&str; 8] = [
        "write_files",
        "delete_files",
        "move_files",
        "copy_files",
        "edit_files",
        "create_directory",
        "remove_directory",
        "run_command",
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
        "run_command" => {
            let parsed: tools::run_command::RunCommandArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::run_command::handle(parsed, state).await
        }
        "get_command_output" => {
            let parsed: tools::get_command_output::GetCommandOutputArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::get_command_output::handle(parsed, state).await
        }
        "stop_command" => {
            let parsed: tools::stop_command::StopCommandArgs =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            tools::stop_command::handle(parsed, state).await
        }
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

fn get_tool_definitions() -> serde_json::Value {
    json!([
        {
            "name": "list_allowed_roots",
            "description": "List the server's access whitelist (allowed root directories, allowed file extensions, max file size). If an allowed root has a top-level CLAUDE.md, its content is inlined under projectInstructions (or a path pointer if it exceeds the size cap). Call this FIRST to discover accessible directories and pick up project rules before attempting any file operation.",
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
        },
        {
            "name": "run_command",
            "description": "Execute a shell command (`cmd /C`) in a whitelisted cwd. DANGEROUS: equivalent to granting the caller arbitrary code execution — disabled by default via the `shell_enabled` config toggle, and blocked entirely in read-only mode. Foreground mode (background=false, default) waits up to timeoutMs and returns stdout/stderr/exitCode. Background mode (background=true) returns immediately with a handle; poll it via get_command_output and end it via stop_command. Stateless: no persistent shell session across calls — always pass an absolute cwd, `cd` does not carry over between calls.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "cwd": { "type": "string", "description": "Absolute path, must be within an allowed root" },
                    "background": { "type": "boolean", "default": false },
                    "timeoutMs": { "type": "integer", "default": 30000, "description": "Foreground mode only" },
                    "maxOutputBytes": { "type": "integer", "default": 1048576, "description": "Output beyond this is discarded and truncated=true is returned" }
                },
                "required": ["command", "cwd"]
            }
        },
        {
            "name": "get_command_output",
            "description": "Incrementally fetch stdout/stderr of a background command started by run_command(background=true). Pass stdoutOffset/stderrOffset (bytes already consumed) to get only new output since the last call.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "handle": { "type": "string" },
                    "stdoutOffset": { "type": "integer", "default": 0 },
                    "stderrOffset": { "type": "integer", "default": 0 }
                },
                "required": ["handle"]
            }
        },
        {
            "name": "stop_command",
            "description": "Forcefully terminate a background command's entire process tree (taskkill /T) and remove it from the registry.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "handle": { "type": "string" }
                },
                "required": ["handle"]
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    /// D1（2026-07-10 修复）的 regression guard：限流键必须用 TCP 对端 IP，
    /// 不能再被客户端可控 header（x-forwarded-for、x-real-ip、forwarded 等）劫持。
    ///
    /// 这条测试不验证"算法超限就拒绝"——那个层级由 AppState.rate_limiter 的用法 +
    /// 已有 misc tests 覆盖；这里专盯 D1 修复点：函数体不可读 header 内容。
    #[test]
    fn rate_limit_key_uses_tcp_peer_ip_not_headers() {
        let addr: SocketAddr = "10.0.0.42:54321".parse().unwrap();
        let mut headers = HeaderMap::new();
        // 攻击者把这两个 header 全塞上，看 key 会不会被劫持。
        headers.insert("x-forwarded-for", "1.2.3.4".parse().unwrap());
        headers.insert("x-real-ip", "5.6.7.8".parse().unwrap());

        let key = rate_limit_key(addr, &headers);

        assert_eq!(key, "10.0.0.42", "限流键必须是对端 IP，不能被 header 劫持");
        assert!(
            !key.contains("1.2.3.4") && !key.contains("5.6.7.8"),
            "key 不可包含任何 header 值：got {key}"
        );
    }

    #[test]
    fn rate_limit_key_ipv6() {
        // IPv6 connect 同样应当原样输出，不能丢冒号或折叠成 IPv4。
        let addr: SocketAddr = "[::1]:7823".parse().unwrap();
        let headers = HeaderMap::new();
        assert_eq!(rate_limit_key(addr, &headers), "::1");
    }

    #[test]
    fn rate_limit_key_distinct_addresses_distinct_keys() {
        // 同 IP 不同端口、不同 IP 同端口 — 都应当产生不同 key，避免 limit 跨调用重叠。
        let headers = HeaderMap::new();
        let same_ip_diff_port_a: SocketAddr = "10.0.0.1:7823".parse().unwrap();
        let same_ip_diff_port_b: SocketAddr = "10.0.0.1:7824".parse().unwrap();
        let diff_ip: SocketAddr = "10.0.0.2:7823".parse().unwrap();
        let k_same_a = rate_limit_key(same_ip_diff_port_a, &headers);
        let k_same_b = rate_limit_key(same_ip_diff_port_b, &headers);
        let k_diff = rate_limit_key(diff_ip, &headers);
        // 关键安全断言：不同 IP 必须区分（这才是限流绕过的修复点）。
        assert_ne!(k_same_a, k_diff, "不同 IP 必须产生不同限流键（防 IP 绕过）");
        // 同 IP 不同端口：当前实现只取 IP 不取 port，本服务单端口 7823 部署足够，
        // 此处不强制要求区分——但记下行为，免得日后无人记得。
        let _ = k_same_b;
    }
}
