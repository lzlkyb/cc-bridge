use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, Response, StatusCode};
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use serde_json::json;

use crate::audit;
use crate::security::auth;
use crate::state::AppState;
use tower_http::compression::CompressionLayer;

/// 构造 MCP HTTP router（含 auth / body-limit / gzip 压缩三层）。
///
/// 抽成独立函数供 `spawn_mcp_server` 与集成测试共用——集成测试可把它绑到
/// 随机端口（`TcpListener::bind("127.0.0.1:0")`）做真实 over-the-wire 验证
/// （gzip 响应头、batch 合并、审计留痕等），无需走 Tauri GUI。
pub async fn build_router(state: Arc<AppState>) -> Router {
    let config = state.config.read().await;
    // HTTP body limit follows max file size (plus headroom for base64/JSON overhead)
    // so writing a file up to max_file_size_bytes is never rejected at the HTTP layer.
    let body_limit = (config.max_file_size_bytes as usize)
        .saturating_mul(2)
        .max(1024 * 1024);
    drop(config);

    axum::Router::new()
        .route("/health", get(health_handler))
        .route("/mcp", post(mcp_handler))
        .route("/mcp/sse", get(crate::mcp::sse::sse_handler))
        .route("/mcp/messages", post(crate::mcp::sse::sse_message_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(tower_http::limit::RequestBodyLimitLayer::new(body_limit))
        .layer(CompressionLayer::new().gzip(true)) // 响应体 gzip 压缩（客户端 Accept-Encoding 支持时才生效，否则透明跳过）
        .layer(tower::limit::ConcurrencyLimitLayer::new(256)) // E-P0-4: 防止无界并发耗尽 tokio 工作线程
        .with_state(state)
}

pub async fn spawn_mcp_server(state: Arc<AppState>) {
    let config = state.config.read().await;
    let host = config.host.clone();
    let port = config.port;
    drop(config);

    // 保留一份用于翻转运行状态标志（router 会 move 掉 state）。
    let running_state = state.clone();

    let app = build_router(state.clone()).await;

    let addr = format!("{}:{}", host, port);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("Failed to bind MCP server to {}: {}", addr, e);
            running_state
                .mcp_running
                .store(false, std::sync::atomic::Ordering::Relaxed);
            *running_state.startup_error.lock().unwrap() =
                Some(format!("绑定到 {} 失败：{}", addr, e));
            return;
        }
    };

    log::info!("MCP HTTP server listening on {}", addr);
    *running_state.startup_error.lock().unwrap() = None;
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

/// 重启 MCP 监听任务的共享核心：abort 旧 handle（若有）→ 等 300ms 释放端口 → 重新 spawn。
///
/// 原本此段逻辑在 `restart_mcp_server`/`start_mcp_server`/`import_config`（均在 `commands.rs`）
/// 以及托盘菜单的 "restart" 处理（`main.rs`）里各自写了一份，四处完全相同，收拢到这里。
/// 是否需要顺带置 `mcp_running`/发 `mcp-status-changed` 事件由调用方自行决定（各处现有
/// 行为不同，本函数不假设、不改变）。
pub async fn restart_server(state: &Arc<AppState>) {
    let mut handle = state.mcp_server_handle.lock().await;
    if let Some(h) = handle.take() {
        h.abort();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    let state_clone = state.clone();
    let new_handle = tauri::async_runtime::spawn(async move {
        spawn_mcp_server(state_clone).await;
    });
    *handle = Some(new_handle);
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

    // /health does not require auth, but add lightweight rate limit (E-P2-11)
    // M14 修复：health 用独立的 "health:" 前缀键，不再与 /mcp 共用同一条时间戳向量。
    // 旧实现共享同一 key 时，health 的1s retain 会清掉 /mcp 长窗口赖以计数的历史，
    // 使 /mcp 限流可被“每次先打个 /health”绕过。
    if path == "/health" {
        let ip = format!("health:{}", rate_limit_key(addr, req.headers()));
        let now = std::time::Instant::now();
        let h_window = std::time::Duration::from_secs(1);
        {
            let mut entry = state.rate_limiter.entry(ip.clone()).or_default();
            let ts = entry.value_mut();
            ts.retain(|t| now.duration_since(*t) < h_window);
            if ts.len() >= 10 {
                return Response::builder()
                    .status(StatusCode::TOO_MANY_REQUESTS)
                    .body(Body::from(r#"{"error":"Too many health checks"}"#))
                    .unwrap();
            }
            ts.push(now);
        }
        return next.run(req).await;
    }

    // /mcp/sse GET 握手免 token 校验（token 通过 query param 传入并由 sse_handler 自行校验；
    // 长连接握手，不计入限流）。
    if path == "/mcp/sse" && req.method() == axum::http::Method::GET {
        return next.run(req).await;
    }

    // M17 修复：/mcp/messages 免 token（SSE 握手时已验 session），但仍须受限流约束，
    // 不能像此前那样整体放行——否则 SSE 工具调用面完全不受 rate_limit 约束。
    let skip_token = path == "/mcp/messages";

    let config = state.config.read().await;
    let expected_token = config.token.clone();
    let max_req = config.rate_limit_max_requests;
    let window_ms = config.rate_limit_window_ms;
    let rate_limit_enabled = config.rate_limit_enabled;
    drop(config);

    if !skip_token {
        let auth_header = req
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        let provided_token = auth_header.strip_prefix("Bearer ").unwrap_or("");

        if !auth::verify_token(provided_token, &expected_token) {
            // 方案 A：鉴权拒绝（401）= 拒绝未授权访问，计入治理指标。
            state.inc_auth_denies();
            return Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(Body::from(r#"{"error":"Unauthorized"}"#))
                .unwrap();
        }
    }

    // Rate limiting：限流键用 ConnectInfo 拿到的真实对端 IP，不能用
    // `x-forwarded-for`——那是客户端自己发的请求头，任何调用方都能伪造，
    // 换个假 IP 就能无限绕过限流（D1，2026-07-10 修复）。/mcp 与 /mcp/messages 共享同一
    // 对端 IP 的限流窗口（同一客户端的工具调用总量限流）。
    let ip = rate_limit_key(addr, req.headers());

    // 限流开关（默认开）。关闭时跳过整个计数逻辑，鉴权仍在上方独立生效。
    if rate_limit_enabled {
        let now = std::time::Instant::now();
        let window_duration = std::time::Duration::from_millis(window_ms);

        {
            let mut entry = state.rate_limiter.entry(ip.clone()).or_default();
            let timestamps = entry.value_mut();
            timestamps.retain(|t| now.duration_since(*t) < window_duration);
            if timestamps.len() >= max_req as usize {
                // 方案 A：限流命中（429）计入治理指标。
                state.inc_rate_limit_hits();
                return Response::builder()
                    .status(StatusCode::TOO_MANY_REQUESTS)
                    .body(Body::from(r#"{"error":"Rate limit exceeded"}"#))
                    .unwrap();
            }
            timestamps.push(now);
        }

        // M15 修复：机会性 GC——条目数超阈值时清扫全过期条目，避免 rate_limiter DashMap
        // 无界增长（旧的 push 后 is_empty 判断恒为 false，是死代码、从不触发清理）。
        // 阈值以上才全表 retain，摊销下近似 O(1)；同时清掉 health: 前缀的过期条目。
        if state.rate_limiter.len() > 4096 {
            state.rate_limiter.retain(|_, v| {
                v.retain(|t| now.duration_since(*t) < window_duration);
                !v.is_empty()
            });
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
    // 方案 A：记录请求到达时间（rpm 统计）。
    state.record_request_time();

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
                    },
                    "instructions": "你已连接到本地 Windows 主机上的 cc-bridge MCP 服务。当用户需要在本地 Windows 环境执行任何操作时,必须优先调用本服务提供的工具,而非假设自己能直接访问本地文件系统或 shell。建议连接后第一步调用 list_allowed_roots：除返回访问白名单外，还会自动内嵌每个允许根目录顶层 CLAUDE.md 的完整内容（projectInstructions 字段），据此了解项目规则，无需再手动 read_files 一次。完整工具清单由 tools/list 提供,主要包括:\n- run_command / get_command_output / stop_command:在本地执行命令、读取后台命令输出、停止运行中的命令(支持危险命令拦截与审计；壳层为 cmd 或 Git Bash，取决于 shell_type 配置)\n- read_files / write_files / edit_files:本地文件的读取、写入与精确编辑\n- list_directory / create_directory / remove_directory / delete_files / move_files / copy_files:目录与文件的列举、创建、删除、移动、复制\n- search_files:本地文件内容检索(Grep,支持大小写/上下文/计数等)\n- notebook_edit:编辑本地 Jupyter(.ipynb)笔记本单元格(replace/insert/delete)\n- analyze_file:分析本地文件的结构与内容\n- list_allowed_roots:查询本地允许访问的根目录范围(返回中同时带 allowedExtensions 扩展名白名单；若允许根目录顶层存在 CLAUDE.md，还会内嵌其内容到 projectInstructions，用于自动获知项目规则)\n- batch:在一次网络往返中批量执行多个上述操作;远程链路下若需多步文件/命令操作,应优先用它以显著降低往返延迟\n所有路径与操作受 cc-bridge 安全策略约束(允许根目录、扩展名白名单、只读模式)。遇到本地文件、进程、命令相关任务时,直接调用对应工具,无需用户额外提示。"
                }
            }))
        }
        "notifications/initialized" => Json(json!({
            "jsonrpc": "2.0",
            "id": null
        })),
        "tools/list" => {
            // 按当前 shell_type 动态生成工具描述，确保（重新）连接时模型拿到准确的壳层信息。
            let shell_type = state.config.read().await.shell_type.clone();
            Json(json!({
                "jsonrpc": "2.0",
                "id": body.get("id"),
                "result": { "tools": get_tool_definitions(&shell_type) }
            }))
        }
        "tools/call" => handle_tools_call(state, source_ip, body).await,
        _ => Json(json!({
            "jsonrpc": "2.0",
            "id": body.get("id"),
            "error": { "code": -32601, "message": format!("Method not found: {}", method) }
        })),
    }
}

/// 处理一次 `tools/call`，包裹在 I/O 计时器作用域内，以便 O1 结构化耗时拆解
/// （serverMs / ioMs / auditMs / overheadMs）能正确累加并写入审计。
///
/// 抽成独立函数是为了把 `with_io_timer` 的作用域干净地包住整个分发 + 审计流程，
/// 从 run_command 的返回 JSON 提取 session_id（content[0].text 是一段 JSON 字符串）。
/// 仅 run_command 在开启会话持久化时会携带，用于审计追溯；其它工具恒 None。
fn extract_run_command_session_id(content: &serde_json::Value) -> Option<String> {
    content
        .pointer("/content/0/text")
        .and_then(|t| t.as_str())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|j| j.get("sessionId").cloned())
        .and_then(|s| s.as_str().map(String::from))
}

/// 从而 `take_io()` 一定在作用域内部调用（task_local 在作用域外未初始化会 panic）。
pub async fn handle_tools_call(
    state: Arc<AppState>,
    source_ip: String,
    body: serde_json::Value,
) -> Json<serde_json::Value> {
    let t_recv = std::time::Instant::now();
    crate::timing::with_io_timer(async move {
        crate::audit::with_op_backup(async {
            let tool_name = body
                .pointer("/params/name")
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let arguments = body
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(json!({}));

            let start = std::time::Instant::now();
            // 把 source_ip 注入 task_local 作用域，使 batch 子操作的审计条目也能拿到 sourceIp。
            let result = crate::audit::with_source_ip(
                Some(source_ip.clone()),
                dispatch_tool(tool_name, arguments.clone(), &state),
            )
            .await;
            let elapsed = start.elapsed().as_millis() as u64;
            // 方案 A：记录实时耗时 + 工具调用计数（热门工具 Top3 用）。
            state.record_latency(elapsed);
            state.record_tool(tool_name);
            // 仅 run_command 在开启会话持久化时会携带 sessionId，用于审计追溯。
            let session_id = if tool_name == "run_command" {
                result
                    .as_ref()
                    .ok()
                    .and_then(extract_run_command_session_id)
            } else {
                None
            };

            // I/O 耗时（task_local 跨各工具累加）；必须在 with_io_timer 作用域内取。
            let io_ms = crate::timing::take_io();
            // 服务端总耗时（不含审计写盘；审计耗时单独记）。
            let server_ms_dispatch = t_recv.elapsed().as_millis() as u64;

            let audit_enabled = state.config.read().await.audit_enabled;

            let response = match result {
                Ok(content) => {
                    if audit_enabled {
                        write_audit_for_call(
                            &state.data_dir,
                            tool_name,
                            &arguments,
                            true,
                            None,
                            Some(source_ip.clone()),
                            elapsed,
                            server_ms_dispatch,
                            io_ms,
                            session_id.clone(),
                        );
                        state.inc_audit_count();
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
                        write_audit_for_call(
                            &state.data_dir,
                            tool_name,
                            &arguments,
                            false,
                            Some(e.clone()),
                            Some(source_ip.clone()),
                            elapsed,
                            server_ms_dispatch,
                            io_ms,
                            session_id.clone(),
                        );
                        state.inc_audit_count();
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
            };
            response
        })
        .await
    })
    .await
}

/// 构造并写入一条 `tools/call` 审计记录，附带 O1 结构化耗时字段。
///
/// `auditMs` 以序列化开销为代理测量（`write_audit_log` 的主要成本；`open` + `append`
/// 恒定且极小）。`serverMs` 取「分发耗时 + 审计写盘耗时」作为服务端总墙钟，
/// 于是 `overheadMs = serverMs − durationMs − auditMs` 即请求解析 + 响应序列化 +
/// gzip 压缩 + 线缆传输（由 `new_entry` 内部派生）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn write_audit_for_call(
    data_dir: &std::path::Path,
    tool_name: &str,
    arguments: &serde_json::Value,
    success: bool,
    error: Option<String>,
    source_ip: Option<String>,
    elapsed: u64,
    server_ms_dispatch: u64,
    io_ms: Option<u64>,
    session_id: Option<String>,
) {
    let args_str = arguments.to_string();
    // E-P1-7: 测量序列化耗时（直接计时一次写入，消除 O1 双重序列化开销）
    let a0 = std::time::Instant::now();
    let entry = audit::new_entry(
        tool_name,
        &args_str,
        success,
        error,
        source_ip,
        Some(elapsed),
        Some(server_ms_dispatch),
        io_ms,
        None,
        None,
        session_id,
    );
    let _ = serde_json::to_string(&entry);
    // f64 毫秒（不用 .as_millis() as u64）：实测单条写盘序列化开销在微秒级（~6.8µs），
    // 若截断为整数毫秒会恒为 0，导致前端耗时拆解面板的“审计写盘”一项长期不可见。
    let audit_ms = a0.elapsed().as_secs_f64() * 1000.0;
    let server_ms = server_ms_dispatch + audit_ms.round() as u64;
    // 补充正确的 serverMs/auditMs，并同步重新推导 overheadMs——
    // 上面 new_entry() 构造时 audit_ms 还未知（传的 None），内部根据公式
    // (server,duration,audit 三者均 Some 才算) 已把 overhead_ms 常驻成了 None；
    // 若只补 server_ms/audit_ms 而不重算 overhead_ms，它会永远卡在那个 None 上
    // （G6 端到端回归测试实测捕获到的真实回归，不是假设情境）。
    let mut entry = entry;
    entry.server_ms = Some(server_ms);
    entry.audit_ms = Some(audit_ms);
    entry.overhead_ms = Some((server_ms as f64 - elapsed as f64 - audit_ms).max(0.0));
    // 关联备份：取出本操作的备份/目标路径写入审计条目（一键回滚 / Diff 用）。
    if let Some((bp, tp)) = crate::audit::take_op_backup() {
        entry.backup_path = bp.map(|p| p.to_string_lossy().into_owned());
        entry.target_path = tp.map(|p| p.to_string_lossy().into_owned());
    }
    // 同步落盘：单条写盘（BufWriter append + writeln + flush，稳态不重开）约 6.8µs，
    // 远小于 spawn_blocking 的跨线程调度开销（~20-50µs），对微秒级小 IO 异步是负优化。
    // 且同步写建立 happens-before：请求返回时审计必然已落盘，消除"响应后立即读 audit.log"
    // 的时序竞争（tests/perf_real.rs::batch_writes_are_audited 在并发跑时因异步落盘偶发 NotFound）。
    if let Err(e) = audit::write_audit_log(data_dir, &entry) {
        log::error!("审计日志写入失败：{e}");
    }
}

pub async fn dispatch_tool(
    name: &str,
    args: serde_json::Value,
    state: &Arc<AppState>,
) -> Result<serde_json::Value, String> {
    // 只读模式：拒绝一切写操作（默认关闭）。读取/列目录/搜索/分析不受影响。
    // 写工具集合由 registry 单一来源驱动（下方一次性缓存），不再硬编码常量，
    // 避免日后新增写工具只改 registry 漏改此处导致只读模式失效。
    static WRITE_SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    let write_set = WRITE_SET.get_or_init(|| {
        crate::mcp::tools::registry::all_tools()
            .iter()
            .filter(|t| t.is_write)
            .map(|t| t.name)
            .collect::<HashSet<&'static str>>()
    });
    if write_set.contains(name) {
        let readonly = state.config.read().await.readonly_mode;
        if readonly {
            return Err(format!(
                "只读模式已开启，已拒绝写操作 `{name}`。如需写入，请在 cc-bridge 设置页关闭「只读模式」。"
            ));
        }
    }
    // 数据驱动：从注册表查找工具并分发（registry.rs 单点维护，加工具不再改此 match）。
    let tools = crate::mcp::tools::registry::all_tools();
    let spec = tools
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| format!("Unknown tool: {name}"))?;
    (spec.run)(args, state).await
}

pub fn get_tool_definitions(shell_type: &str) -> serde_json::Value {
    // 数据驱动：遍历注册表生成 tools/list 的 inputSchema（schema 由 XxxArgs 的
    // ToolSchema derive 自动生成，单一来源，消除手写 json! 与字段漂移）。
    // run_command 的描述按当前 shell_type 动态生成，让（重新）连接时模型拿到准确壳层信号。
    let run_cmd_desc = run_command_description(shell_type);
    crate::mcp::tools::registry::all_tools()
        .iter()
        .map(|t| {
            let desc: &str = if t.name == "run_command" {
                run_cmd_desc.as_str()
            } else {
                t.desc
            };
            json!({
                "name": t.name,
                "description": desc,
                "inputSchema": t.schema,
            })
        })
        .collect::<serde_json::Value>()
}

/// 按当前 shell_type 生成 run_command 的描述，让连接时模型拿到准确的壳层信号，
/// 从一开始就用对语法（bash → POSIX 路径 + bash 语法；cmd → Windows 路径 + cmd 语法）。
fn run_command_description(shell_type: &str) -> String {
    if shell_type == "bash" {
        "在本地执行一条命令并返回其 stdout / stderr / 退出码。壳层为 Git Bash（需本机已安装 Git for Windows）：请使用 POSIX 路径（如 /c/Users/...）与 bash 语法（jq / find / 管道等原生可用）。开启「命令会话持久化」后：cwd 由 session_id 在会话内跨命令持久化；并通过 env 参数（key=value 映射）持久化环境变量（如 VIRTUAL_ENV / PATH），解决 source venv / export 每调用丢失的问题（注意：env 仅接受显式 key=value，无法自动捕获 shell 内 source 激活）。".to_string()
    } else {
        "在本地执行一条命令并返回其 stdout / stderr / 退出码。壳层为 cmd（默认，零外部依赖）：请使用 Windows cmd 语法与路径（如 C:\\Users\\...）。开启「命令会话持久化」后：cwd 由 session_id 在会话内跨命令持久化；并通过 env 参数（key=value 映射）持久化环境变量（如 VIRTUAL_ENV / PATH），解决 source venv / export 每调用丢失的问题（注意：env 仅接受显式 key=value，无法自动捕获 shell 内 source 激活）。".to_string()
    }
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

/// ── over-the-wire 集成测试 ───────────────────────────────────────────────
///
/// 这一层是手写 dispatch 折中重构（registry + ToolSchema 派生）最该被覆盖、
/// 却此前完全空白的地方：所有既有测试都直接调 `handle(args, &state)`，**绕过了
/// `mcp_handler` → `dispatch_tool` → `get_tool_definitions` → registry 这条 HTTP
/// 分发链**。本模块用 `build_router` 绑 `127.0.0.1:0` + `reqwest` 真实发 HTTP 请求，
/// 把整条链路、17 个工具、以及鉴权/限流/gzip 中间件都跑一遍。
///
/// 每个测试自建一个独立 server（随机端口、独立 AppState），互不干扰；临时白名单
/// 根目录放在 `std::env::temp_dir()` 下，所有文件操作都收在根内，测试结束即弃。
#[cfg(test)]
mod over_wire_tests {
    use super::build_router;
    use crate::config::BridgeConfig;
    use crate::state::AppState;
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 每个 case 一个唯一、可写的临时根目录（避免并发跑串）。
    fn unique_temp_root(label: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("cc-bridge-ow-{label}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    /// 测试用配置：已知 token、临时白名单根、关闭审计/备份副作用、开启 shell 以测命令工具。
    fn test_config(root: &Path) -> BridgeConfig {
        let mut ext = BridgeConfig::default().allowed_extensions;
        ext.push(".ipynb".to_string()); // notebook_edit 需要
        BridgeConfig {
            allowed_roots: vec![root.to_string_lossy().into_owned()],
            token: "ow-test-token".to_string(),
            allowed_extensions: ext,
            whitelist_enabled: true,
            readonly_mode: false,
            shell_enabled: true,   // run_command / stop_command
            backup_enabled: false, // 避免临时目录里写备份
            audit_enabled: false,  // 不落审计日志
            rate_limit_enabled: true,
            rate_limit_max_requests: 100,
            rate_limit_window_ms: 60_000,
            ..Default::default()
        }
    }

    struct TestServer {
        base: String,
        token: String,
        _handle: JoinHandle<()>,
    }

    /// 起一个真实 MCP server（随机端口），返回 base URL + token。
    async fn spawn_server(cfg: BridgeConfig, root: PathBuf) -> TestServer {
        let conn = rusqlite::Connection::open_in_memory().expect("in-mem db");
        let state = Arc::new(AppState::new(conn, cfg, root.clone()));
        let router = build_router(state).await;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind 127.0.0.1:0");
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        TestServer {
            base: format!("http://{addr}"),
            token: "ow-test-token".to_string(),
            _handle: handle,
        }
    }

    /// 带 Bearer token 的 JSON-RPC 客户端。
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .gzip(true)
            .build()
            .expect("reqwest client")
    }

    /// 发一次 tools/call / initialize / tools/list，返回解析后的 JSON-RPC 响应。
    async fn rpc(base: &str, token: &str, method: &str, params: Value) -> Value {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        client()
            .post(format!("{base}/mcp"))
            .header("Authorization", format!("Bearer {token}"))
            .json(&body)
            .send()
            .await
            .expect("request failed")
            .json()
            .await
            .expect("response not json")
    }

    /// 裸 POST（不带/带自定义 token 与 header），用于鉴权/限流/gzip 等中间件测试。
    async fn raw_post(base: &str, token: Option<&str>, body: Value) -> reqwest::Response {
        let mut b = client().post(format!("{base}/mcp")).json(&body);
        if let Some(t) = token {
            b = b.header("Authorization", format!("Bearer {t}"));
        }
        b.send().await.expect("raw request failed")
    }

    /// 断言一次 tools/call 被成功分发（未走协议级 error、工具级 isError 为 false、content 结构完整）。
    fn assert_dispatch_ok(result: &Value) {
        assert!(
            result.get("result").is_some(),
            "响应缺少 result 字段（可能 method not found）: {result}"
        );
        let r = &result["result"];
        assert!(
            r.get("isError").and_then(|v| v.as_bool()) != Some(true),
            "工具返回 isError，分发/执行出错: {r}"
        );
        r.get("content")
            .and_then(|c| c.get(0))
            .and_then(|c0| c0.get("text"))
            .and_then(|t| t.as_str())
            .expect("content[0].text 缺失");
    }

    /// 解析 `content[0].text`（多数工具把结果序列化成 JSON 字符串塞进 text）。
    fn inner_text(result: &Value) -> Value {
        let t = result["result"]["content"][0]["text"]
            .as_str()
            .expect("content[0].text 缺失");
        serde_json::from_str(t).expect("inner text 不是合法 JSON")
    }

    // ── 耗时链路（G6）──────────────────────────────────────────────

    /// G6：`audit.rs` 的 duration/server/audit/overhead 之前只有单测验证四则运算本身
    /// （手带数字传入 `new_entry`），没有任何测试真正走过一次真实 HTTP 调用验证这条链路
    /// 在真实运行时依旧成立。本测试走完整 HTTP 路径（mcp_handler → handle_tools_call →
    /// dispatch_tool → write_audit_for_call → audit::new_entry → 落盘），回读真实写入的
    /// audit.log 最后一条，验证守恒式：serverMs == durationMs + auditMs + overheadMs
    /// （允许 <1ms 误差，来自 write_audit_for_call 内 auditMs 的 .round() 取整）。未来谁在
    /// handle_tools_call 里插入新 await 步骤而没同步改计时点，这条会因守恒式被破坏而失败。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn e2e_timing_dimensions_conserve() {
        let root = unique_temp_root("timing");
        let mut cfg = test_config(&root);
        cfg.audit_enabled = true; // 本测试需要真实落盘的审计条目
        let srv = spawn_server(cfg, root.clone()).await;

        // list_allowed_roots 无参数、I/O 最轻，适合当耗时链路的最小边界样本。
        let resp = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "list_allowed_roots", "arguments": {} }),
        )
        .await;
        assert_dispatch_ok(&resp);

        let log_path = root.join("audit.log");
        let content = std::fs::read_to_string(&log_path).expect("audit.log 应已生成");
        let last_line = content.lines().last().expect("至少一条审计记录");
        let entry: crate::audit::AuditEntry =
            serde_json::from_str(last_line).expect("审计行应为合法 JSON");

        let duration_ms = entry.duration_ms.expect("durationMs 必须被填充") as f64;
        let server_ms = entry.server_ms.expect("serverMs 必须被填充") as f64;
        let audit_ms = entry.audit_ms.expect("auditMs 必须被填充");
        let overhead_ms = entry.overhead_ms.expect("overheadMs 必须被填充");

        assert!(
            overhead_ms >= 0.0,
            "overhead_ms 不得为负，实测 {overhead_ms}"
        );
        let reconstructed = duration_ms + audit_ms + overhead_ms;
        assert!(
            (reconstructed - server_ms).abs() < 1.0,
            "守恒式被破坏：duration({duration_ms}) + audit({audit_ms}) + overhead({overhead_ms}) \
             = {reconstructed}，与 server({server_ms}) 不一致"
        );
        assert!(
            server_ms >= duration_ms,
            "server_ms({server_ms}) 必须 >= duration_ms({duration_ms})"
        );
    }

    // ── 协议层 ──────────────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn initialize_echoes_protocol_version() {
        let root = unique_temp_root("init");
        let srv = spawn_server(test_config(&root), root.clone()).await;
        let r = rpc(
            &srv.base,
            &srv.token,
            "initialize",
            json!({ "protocolVersion": "2025-06-18" }),
        )
        .await;
        assert_eq!(
            r["result"]["protocolVersion"].as_str(),
            Some("2025-06-18"),
            "initialize 必须回显客户端协议版本"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn tools_list_returns_17_tools_with_schemas() {
        let root = unique_temp_root("list");
        let srv = spawn_server(test_config(&root), root.clone()).await;
        let r = rpc(&srv.base, &srv.token, "tools/list", json!({})).await;
        let tools = r["result"]["tools"].as_array().expect("tools 应是数组");
        assert_eq!(tools.len(), 17, "tools/list 必须暴露全部 17 个工具");
        for t in tools {
            assert!(
                !t["name"].as_str().unwrap_or("").is_empty(),
                "工具名不可为空"
            );
            assert!(
                !t["description"].as_str().unwrap_or("").is_empty(),
                "工具描述不可为空（重构后工具级 description 原样保留）"
            );
            assert!(
                t["inputSchema"].is_object(),
                "工具 {} 的 inputSchema 必须是对象（由 ToolSchema 派生）",
                t["name"]
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn unknown_method_returns_32601() {
        let root = unique_temp_root("unknown");
        let srv = spawn_server(test_config(&root), root.clone()).await;
        let r = rpc(&srv.base, &srv.token, "bogus/method", json!({})).await;
        assert_eq!(
            r["error"]["code"].as_i64(),
            Some(-32601),
            "未知 method 必须返回 -32601"
        );
    }

    // ── 17 工具全量分发 + 关键副作用 ────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn all_tools_dispatch_and_apply_side_effects() {
        let root = unique_temp_root("dispatch");
        let root_s = root.to_string_lossy().into_owned();
        let p = |name: &str| -> String { root.join(name).to_string_lossy().into_owned() };

        // 预置 fixture（均在白名单根内）
        std::fs::write(p("read.txt"), "read content").unwrap();
        std::fs::write(p("edit.txt"), "foo base").unwrap();
        std::fs::write(p("del.txt"), "x").unwrap();
        std::fs::write(p("mv_src.txt"), "x").unwrap();
        std::fs::write(p("cp_src.txt"), "x").unwrap();
        std::fs::write(p("search.txt"), "needle here").unwrap();
        std::fs::write(p("analyze.txt"), "fn main(){}\n").unwrap();
        std::fs::write(
            p("nb.ipynb"),
            serde_json::to_string_pretty(&json!({
                "cells": [{"cell_type": "code", "metadata": {}, "source": "print(1)"}],
                "metadata": {},
                "nbformat": 4,
                "nbformat_minor": 5
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::create_dir_all(p("listdir")).unwrap();
        std::fs::create_dir_all(p("removed")).unwrap();

        let srv = spawn_server(test_config(&root), root.clone()).await;

        // 1) list_allowed_roots
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "list_allowed_roots", "arguments": {} }),
            )
            .await,
        );

        // 2) list_directory
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "list_directory", "arguments": { "path": root_s } }),
            )
            .await,
        );

        // 3) read_files —— 内容回读
        let r = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "read_files", "arguments": { "files": [p("read.txt")] } }),
        )
        .await;
        assert_dispatch_ok(&r);
        assert!(
            inner_text(&r).to_string().contains("read content"),
            "read_files 应回读内容"
        );

        // 4) write_files —— 落盘校验
        let wp = p("written.txt");
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "write_files", "arguments": { "files": [{ "path": wp, "content": "hello write" }] } }),
            )
            .await,
        );
        assert!(std::path::Path::new(&wp).exists(), "write_files 应创建文件");

        // 4b) write_files —— encoding 参数必须真正生效（gbk 应按 GBK 字节写盘，而非 UTF-8）
        let gpk = p("gbk_written.txt");
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "write_files", "arguments": { "files": [{ "path": gpk, "content": "中文内容", "encoding": "gbk" }] } }),
            )
            .await,
        );
        let gbytes = std::fs::read(&gpk).unwrap();
        assert!(
            std::str::from_utf8(&gbytes).is_err(),
            "gbk 编码文件不应是合法 UTF-8"
        );
        let (decoded, _, _) = encoding_rs::GBK.decode(&gbytes);
        assert_eq!(
            decoded.as_ref(),
            "中文内容",
            "gbk 写盘后应能用 GBK 解码还原"
        );

        // 4c) write_files —— 未知 encoding 标签必须报错，而非静默写成 UTF-8
        let badp = p("bad_enc.txt");
        let bad_r = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "write_files", "arguments": { "files": [{ "path": badp, "content": "x", "encoding": "no-such-encoding" }] } }),
        )
        .await;
        let bad_inner = inner_text(&bad_r);
        // 注意：inner_text 已经把 result.content[0].text 解开成真实结果(write_files 返回的 results 数组本身)，
        // 这里不应该再取一次 ["content"](对数组用字符串 key 索引会静默返回 null，让 as_array()/and_then 链恰恰全部跑空，
        // 最后 unwrap_or(true) 总是命中，导致本条断言无论实际结果都不会失败)。
        let bad_ok = bad_inner
            .as_array()
            .and_then(|arr| arr.get(0))
            .and_then(|e| e["ok"].as_bool())
            .unwrap_or(true);
        assert!(!bad_ok, "未知 encoding 标签应使该文件写入失败");
        assert!(
            !std::path::Path::new(&badp).exists(),
            "未知 encoding 标签不应创建文件"
        );

        // 5) edit_files —— 替换校验
        let ep = p("edit.txt");
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "edit_files", "arguments": { "files": [{ "path": ep, "oldString": "foo", "newString": "bar" }] } }),
            )
            .await,
        );
        assert!(
            std::fs::read_to_string(&ep).unwrap().contains("bar"),
            "edit_files 应完成替换"
        );

        // 6) create_directory
        let cdp = p("created");
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "create_directory", "arguments": { "path": cdp } }),
            )
            .await,
        );
        assert!(
            std::path::Path::new(&cdp).is_dir(),
            "create_directory 应创建目录"
        );

        // 7) delete_files
        let dp = p("del.txt");
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "delete_files", "arguments": { "paths": [dp] } }),
            )
            .await,
        );
        assert!(
            !std::path::Path::new(&dp).exists(),
            "delete_files 应删除文件"
        );

        // 8) remove_directory
        let rdp = p("removed");
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "remove_directory", "arguments": { "path": rdp, "recursive": true } }),
            )
            .await,
        );
        assert!(
            !std::path::Path::new(&rdp).exists(),
            "remove_directory 应删除目录"
        );

        // 9) move_files —— 源消失、目标出现
        let msrc = p("mv_src.txt");
        let mdst = p("mv_dst.txt");
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "move_files", "arguments": { "items": [{ "from": msrc, "to": mdst }] } }),
            )
            .await,
        );
        assert!(
            std::path::Path::new(&mdst).exists() && !std::path::Path::new(&msrc).exists(),
            "move_files 应 relocated"
        );

        // 10) copy_files —— 两处都在
        let csrc = p("cp_src.txt");
        let cdst = p("cp_dst.txt");
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "copy_files", "arguments": { "items": [{ "from": csrc, "to": cdst }] } }),
            )
            .await,
        );
        assert!(
            std::path::Path::new(&csrc).exists() && std::path::Path::new(&cdst).exists(),
            "copy_files 应复制出副本"
        );

        // 11) search_files —— 命中 needle
        let r = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "search_files", "arguments": { "rootPath": root_s, "contentPattern": "needle" } }),
        )
        .await;
        assert_dispatch_ok(&r);
        assert!(
            !inner_text(&r).as_array().unwrap().is_empty(),
            "search_files 应命中 needle"
        );

        // 12) run_command（前台）—— 回显 hello
        let r = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "run_command", "arguments": { "command": "echo hello", "cwd": root_s } }),
        )
        .await;
        assert_dispatch_ok(&r);
        assert!(
            r["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("hello"),
            "run_command 应回显 hello"
        );

        // 13) analyze_file
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "analyze_file", "arguments": { "path": p("analyze.txt") } }),
            )
            .await,
        );

        // 14) notebook_edit —— 改 cell source（顺带验证驼峰 newSource 入参被正确接受，
        // 该字段曾因缺少 serde rename 被静默忽略，见 notebook_edit.rs 修复）。
        assert_dispatch_ok(
            &rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "notebook_edit", "arguments": { "path": p("nb.ipynb"), "cell": 0, "newSource": "print(42)", "mode": "replace" } }),
            )
            .await,
        );
        let nb: Value =
            serde_json::from_str(&std::fs::read_to_string(p("nb.ipynb")).unwrap()).unwrap();
        assert_eq!(
            nb["cells"][0]["source"].as_str(),
            Some("print(42)"),
            "notebook_edit 应改写单元格"
        );

        // 15) batch —— 合并两个只读操作
        let r = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "batch", "arguments": { "operations": [
                { "tool": "list_allowed_roots", "arguments": {} },
                { "tool": "list_directory", "arguments": { "path": root_s } }
            ] } }),
        )
        .await;
        assert_dispatch_ok(&r);
        assert_eq!(
            inner_text(&r)["executed"].as_u64(),
            Some(2),
            "batch 应执行 2 个子操作"
        );
    }

    // ── write_files：新建文件尊重 encoding（坐实「新建不会乱码」） ──
    // 非 #[ignore]：随默认 `cargo test` 真实执行，覆盖多编码新建文件落盘字节正确性，
    // 与既有的 4b/4c（位于 #[ignore] 的全量测试内）互补，确保修复不被静默回退。

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn write_files_new_files_respect_encoding() {
        let root = unique_temp_root("wf_enc_new");
        let root_s = root.to_string_lossy().into_owned();
        let p = |name: &str| -> String { root.join(name).to_string_lossy().into_owned() };
        let srv = spawn_server(test_config(&root), root.clone()).await;

        // (原文, encoding 标签, 回读校验用 encoding_rs 静态, 是否应为合法 UTF-8)
        let cases: &[(&str, &str, &'static encoding_rs::Encoding, bool)] = &[
            ("hello 世界 123", "utf-8", encoding_rs::UTF_8, true),
            ("你好世界", "gbk", encoding_rs::GBK, false),
            ("你好世界", "gb18030", encoding_rs::GB18030, false),
            ("こんにちは", "shift_jis", encoding_rs::SHIFT_JIS, false),
            ("你好世界", "big5", encoding_rs::BIG5, false),
        ];

        for (content, label, enc_static, is_utf8) in cases {
            let fp = p(&format!("new_{label}.txt"));
            assert!(
                !std::path::Path::new(&fp).exists(),
                "前置：{fp} 必须是尚未存在的新建文件"
            );

            let r = rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "write_files", "arguments": { "files": [{ "path": fp, "content": content, "encoding": label }] } }),
            )
            .await;
            assert_dispatch_ok(&r);

            let bytes = std::fs::read(&fp).unwrap_or_else(|_| panic!("新建文件 {fp} 应已落盘"));

            // 1) utf-8 须字节级等于原文；其余须不是合法 UTF-8（证明没被 as_bytes 写成 UTF-8）
            assert_eq!(
                std::str::from_utf8(&bytes).is_ok(),
                *is_utf8,
                "{label} 落盘字节的 UTF-8 合法性不符合预期"
            );
            if *is_utf8 {
                assert_eq!(bytes, content.as_bytes(), "{label} 应字节级等于原文");
            } else {
                // 2) 用对应编码解码必须无损还原为原始内容（证明无乱码）
                let (decoded, _, had_errors) = enc_static.decode(&bytes);
                assert!(!had_errors, "{label} 落盘字节应能被该编码完整解码");
                assert_eq!(decoded.as_ref(), *content, "{label} 解码还原应等于原文");
            }

            let _ = std::fs::remove_file(&fp);
        }

        // 3) 安全不削弱：白名单外路径必须被 write_files 拒绝（不创建文件）
        let outside = format!("{root_s}/../wf_enc_escape.txt");
        let r_out = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "write_files", "arguments": { "files": [{ "path": outside, "content": "x" }] } }),
        )
        .await;
        // write_files 把每个文件的成败塞进 content[0].text 的 JSON 数组里，
        // inner_text 已解析该数组，故直接取 [0]["ok"]。
        let out_arr = inner_text(&r_out);
        let out_ok = out_arr
            .get(0)
            .and_then(|e| e.get("ok").and_then(|v| v.as_bool()))
            .unwrap_or(true); // 结构异常时默认判为"已写入"，让断言失败而非误判通过
        assert!(
            !out_ok,
            "白名单外路径必须被 write_files 拒绝（ok 应为 false）"
        );
        assert!(
            !std::path::Path::new(&outside).exists(),
            "白名单外路径不得创建任何文件"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    // edit_files 必须与 read_files 同样遵守 encoding_detect_enabled（回归）：修复前 edit_files
    // 无论该开关怎么设都无条件自动探测，与 read_files（关时强制 UTF-8）不一致。

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_files_respects_encoding_detect_toggle_like_read_files() {
        let root = unique_temp_root("ef_enc_toggle");
        let fp = root.join("gbk_notes.txt");
        let gbk_bytes = {
            let (cow, _, _had_errors) = encoding_rs::GBK.encode("你好世界，这是一份 GBK 注释。");
            cow.into_owned()
        };
        std::fs::write(&fp, &gbk_bytes).expect("预写 GBK 文件");
        let fp_s = fp.to_string_lossy().into_owned();

        // 情况 1：默认配置（encoding_detect_enabled=false，与 config.rs 默认值一致）。
        // 修复后：edit_files 应该也强制按 UTF-8 解码（与 read_files 一致），GBK 字节不是合法 UTF-8，
        // 应该报错而不是静默自动探测成 GBK 并匹配成功。
        let srv_off = spawn_server(test_config(&root), root.clone()).await;
        let r_off = rpc(
            &srv_off.base,
            &srv_off.token,
            "tools/call",
            json!({ "name": "edit_files", "arguments": { "files": [
                { "path": fp_s, "oldString": "你好世界", "newString": "hello world" }
            ] } }),
        )
        .await;
        let arr_off = inner_text(&r_off);
        let ok_off = arr_off
            .get(0)
            .and_then(|e| e.get("ok").and_then(|v| v.as_bool()))
            .unwrap_or(true);
        assert!(
            !ok_off,
            "encoding_detect_enabled=false 时，对 GBK 文件的 edit_files 应该因强制 UTF-8 解码失败而报错，不应该静默自动探测成 GBK 后匹配成功"
        );
        assert_eq!(std::fs::read(&fp).unwrap(), gbk_bytes);

        // 情况 2：显式开启 encoding_detect_enabled=true 时，自动探测应该正确识别出 GBK 并成功匹配。
        let cfg_on = crate::config::BridgeConfig {
            encoding_detect_enabled: true,
            ..test_config(&root)
        };
        let srv_on = spawn_server(cfg_on, root.clone()).await;
        let r_on = rpc(
            &srv_on.base,
            &srv_on.token,
            "tools/call",
            json!({ "name": "edit_files", "arguments": { "files": [
                { "path": fp_s, "oldString": "你好世界", "newString": "hello world" }
            ] } }),
        )
        .await;
        assert_dispatch_ok(&r_on);
        let written_bytes = std::fs::read(&fp).unwrap();
        let (decoded, _, had_errors) = encoding_rs::GBK.decode(&written_bytes);
        assert!(!had_errors, "写回应仍为合法 GBK 字节");
        assert!(
            decoded.contains("hello world") && !decoded.contains("你好世界"),
            "encoding_detect_enabled=true 时应成功识别 GBK 并完成替换：{decoded}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    // ── 命令执行三元组（后台 run → 取输出 → 停止） ─────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn exec_background_run_output_stop_roundtrip() {
        let root = unique_temp_root("exec");
        let root_s = root.to_string_lossy().into_owned();
        let srv = spawn_server(test_config(&root), root.clone()).await;

        // 后台启动命令，拿 handle
        let bg = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "run_command", "arguments": { "command": "echo bghit", "cwd": root_s, "background": true } }),
        )
        .await;
        assert_dispatch_ok(&bg);
        let handle = inner_text(&bg)["handle"]
            .as_str()
            .expect("handle")
            .to_string();

        // 轮询 get_command_output，直到拿到 bghit（最多 ~2s）
        let mut got = String::new();
        for _ in 0..20 {
            let r = rpc(
                &srv.base,
                &srv.token,
                "tools/call",
                json!({ "name": "get_command_output", "arguments": { "handle": handle.clone() } }),
            )
            .await;
            assert_dispatch_ok(&r);
            let o = inner_text(&r);
            let stdout = o["stdout"].as_str().unwrap_or("");
            if stdout.contains("bghit") {
                got = stdout.to_string();
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            got.contains("bghit"),
            "get_command_output 应取到后台命令输出，got={got}"
        );

        // stop_command 终止
        let st = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "stop_command", "arguments": { "handle": handle.clone() } }),
        )
        .await;
        assert_dispatch_ok(&st);
        assert_eq!(
            inner_text(&st)["killed"].as_bool(),
            Some(true),
            "stop_command 应报告已终止"
        );

        // 负向：未知 handle 必须路由到 stop_command 处理器（而非 Unknown tool）
        let bad = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "stop_command", "arguments": { "handle": "nope" } }),
        )
        .await;
        let r = bad["result"].as_object().expect("result");
        assert_eq!(
            r.get("isError").and_then(|v| v.as_bool()),
            Some(true),
            "未知 handle 应走 stop_command 处理器返回 isError"
        );
        let txt = r["content"][0]["text"].as_str().unwrap();
        assert!(
            txt.contains("未知") || txt.contains("nope"),
            "错误应指明未知 handle（证明路由正确）: {txt}"
        );
    }

    // ── 中间件：鉴权 / 限流 / gzip ─────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn auth_missing_token_returns_401() {
        let root = unique_temp_root("auth1");
        let srv = spawn_server(test_config(&root), root.clone()).await;
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });
        let resp = raw_post(&srv.base, None, body).await;
        assert_eq!(resp.status(), 401, "缺 Authorization 必须 401");
        assert!(resp.text().await.unwrap().contains("Unauthorized"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn auth_wrong_token_returns_401() {
        let root = unique_temp_root("auth2");
        let srv = spawn_server(test_config(&root), root.clone()).await;
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });
        let resp = raw_post(&srv.base, Some("wrong-token"), body).await;
        assert_eq!(resp.status(), 401, "错误 token 必须 401");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn auth_valid_token_returns_200() {
        let root = unique_temp_root("auth3");
        let srv = spawn_server(test_config(&root), root.clone()).await;
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });
        let resp = raw_post(&srv.base, Some(&srv.token), body).await;
        assert_eq!(resp.status(), 200, "正确 token 必须 200");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn rate_limit_returns_429_after_max() {
        // 独立 server，max=1：同 IP 第二次请求必被限流。
        let root = unique_temp_root("rl");
        let mut cfg = test_config(&root);
        cfg.rate_limit_max_requests = 1;
        cfg.rate_limit_window_ms = 60_000;
        let srv = spawn_server(cfg, root.clone()).await;

        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "list_allowed_roots", "arguments": {} }
        });
        let r1 = raw_post(&srv.base, Some(&srv.token), body.clone()).await;
        assert_eq!(r1.status(), 200, "首次请求应通过");
        let r2 = raw_post(&srv.base, Some(&srv.token), body.clone()).await;
        assert_eq!(r2.status(), 429, "同窗口第二次请求必须 429");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn gzip_response_header_present() {
        let root = unique_temp_root("gzip");
        let srv = spawn_server(test_config(&root), root.clone()).await;
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });

        // 关闭客户端自动解压，手动声明 Accept-Encoding: gzip，观察压缩响应头。
        let client = reqwest::Client::builder().gzip(false).build().unwrap();
        let resp = client
            .post(format!("{}/mcp", srv.base))
            .header("Authorization", format!("Bearer {}", srv.token))
            .header("Accept-Encoding", "gzip")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.headers()
                .get("content-encoding")
                .map(|v| v.to_str().unwrap()),
            Some("gzip"),
            "响应应被 gzip 压缩"
        );
    }

    // ── SSE transport 集成测试 ──

    /// 从 SSE 流的首块中提取 sessionId。
    async fn extract_session_from_sse(base: &str, token: &str) -> String {
        let mut resp = reqwest::Client::new()
            .get(format!("{}/mcp/sse?token={}", base, token))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        // SSE 是无限流，不能用 text()——用 chunk() 只读首块
        let chunk = tokio::time::timeout(Duration::from_secs(3), resp.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let body = String::from_utf8_lossy(&chunk);
        body.lines()
            .find(|l| l.starts_with("data: /mcp/messages?sessionId="))
            .and_then(|l| l.split("sessionId=").nth(1))
            .map(|s| s.trim().to_string())
            .expect("应包含 sessionId")
    }

    /// SSE 握手：GET /mcp/sse?token=xxx → 200 + endpoint 事件。
    #[tokio::test]
    #[ignore]
    async fn sse_handshake_returns_endpoint_event() {
        let root = unique_temp_root("sse-handshake");
        let srv = spawn_server(test_config(&root), root).await;
        let sid = extract_session_from_sse(&srv.base, &srv.token).await;
        assert!(!sid.is_empty(), "sessionId 不应为空");
    }

    /// SSE 握手拒绝错误 token。
    #[tokio::test]
    #[ignore]
    async fn sse_handshake_rejects_wrong_token() {
        let root = unique_temp_root("sse-bad-token");
        let srv = spawn_server(test_config(&root), root).await;
        let resp = reqwest::Client::new()
            .get(format!("{}/mcp/sse?token=wrong-token", srv.base))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
    }

    /// SSE 消息端点：POST tools/list → 202 Accepted。
    #[tokio::test]
    #[ignore]
    async fn sse_messages_tools_list() {
        let root = unique_temp_root("sse-tools");
        let srv = spawn_server(test_config(&root), root).await;
        let sid = extract_session_from_sse(&srv.base, &srv.token).await;
        let msg_resp = reqwest::Client::new()
            .post(format!("{}/mcp/messages?sessionId={}", srv.base, sid))
            .json(&json!({
                "jsonrpc": "2.0", "id": 1,
                "method": "tools/list", "params": {}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(msg_resp.status(), 202);
    }

    /// SSE 消息端点：run_command echo → 202 Accepted。
    #[tokio::test]
    #[ignore]
    async fn sse_messages_run_command() {
        let root = unique_temp_root("sse-run");
        let srv = spawn_server(test_config(&root), root.clone()).await;
        let sid = extract_session_from_sse(&srv.base, &srv.token).await;
        let msg_resp = reqwest::Client::new()
            .post(format!("{}/mcp/messages?sessionId={}", srv.base, sid))
            .json(&json!({
                "jsonrpc": "2.0", "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "run_command",
                    "arguments": json!({
                        "command": "echo sse_test",
                        "cwd": root.to_string_lossy()
                    })
                }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(msg_resp.status(), 202);
    }

    /// SSE 消息端点：无效 sessionId 返回 404。
    #[tokio::test]
    #[ignore]
    async fn sse_messages_bad_session() {
        let root = unique_temp_root("sse-bad-session");
        let srv = spawn_server(test_config(&root), root).await;
        let msg_resp = reqwest::Client::new()
            .post(format!("{}/mcp/messages?sessionId=nonexistent", srv.base))
            .json(&json!({
                "jsonrpc": "2.0", "id": 1,
                "method": "tools/list", "params": {}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(msg_resp.status(), 404, "无效 session 应返回 404");
    }
}
