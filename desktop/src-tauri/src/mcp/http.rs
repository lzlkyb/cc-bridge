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
    // HTTP body 上限。
    //
    // 🔴 `max_file_size × 2` 只够**一个**文件（base64 膨胀 + JSON 外壳），而
    // `write_files` 收的是**文件数组**：3 个 20MB 文件的请求约 80MB，旧上限 40MB
    // 把完全合法的调用挡成 413（审查 P2）。这里按「单次最多 3 个满额文件」给余量，
    // 再用绝对上限压住内存——Body limit 是整包缓冲，乘上 256 并发不能无界。
    const MAX_BODY_LIMIT: usize = 96 * 1024 * 1024;
    let body_limit = (config.max_file_size_bytes as usize)
        .saturating_mul(2)
        .saturating_mul(3)
        .clamp(1024 * 1024, MAX_BODY_LIMIT);
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
        // 最外层：把 body-limit 的裸 413 改成 JSON-RPC 错误（见函数头注释）。
        .layer(axum::middleware::from_fn(jsonrpc_oversize_middleware))
        .with_state(state)
}

/// 把 `RequestBodyLimitLayer` 的 413 改写成 **JSON-RPC 错误**。
///
/// 🔴 为什么必须改写：413 原本是纯文本 `length limit exceeded`，模型看到的不是工具错误、
/// 也拿不到任何可执行信息——它只会重试同一个请求。写成 JSON-RPC 错误并给出
/// 「拆成多次调用」的指引，模型才有自纠路径。拿不到请求 id（body 都没读完）时
/// `id: null` 是规范允许的形态。
async fn jsonrpc_oversize_middleware(req: Request<Body>, next: Next) -> Response<Body> {
    let is_mcp = req.uri().path().starts_with("/mcp");
    let resp = next.run(req).await;
    if !is_mcp || resp.status() != StatusCode::PAYLOAD_TOO_LARGE {
        return resp;
    }
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {
                "code": -32600,
                "message": "请求体超出上限。请拆成多次调用：write_files 一次少传几个文件，每个文件不超过 maxFileSizeBytes 配置值。"
            }
        })),
    )
        .into_response()
}

pub async fn spawn_mcp_server(state: Arc<AppState>) {
    let (host, port, tls_enabled) = {
        let config = state.config.read().await;
        (config.host.clone(), config.port, config.remote_tls_enabled)
    };

    // 保留一份用于翻转运行状态标志（router 会 move 掉 state）。
    let running_state = state.clone();

    let app = build_router(state.clone()).await;

    let addr = format!("{}:{}", host, port);
    let sock: std::net::SocketAddr = match addr.parse() {
        Ok(a) => a,
        Err(e) => {
            log::error!("Invalid MCP bind address {}: {}", addr, e);
            running_state
                .mcp_running
                .store(false, std::sync::atomic::Ordering::Relaxed);
            *running_state.startup_error.lock().unwrap() = Some(format!("监听地址无效：{}", addr));
            return;
        }
    };

    // P1：remote_tls_enabled 开启时整条监听切 TLS（单端口，无 HTTP/HTTPS 并存）。
    if tls_enabled {
        crate::mcp::tls::install_crypto_provider();
        let ips = crate::mcp::tls::detect_local_ips();
        let cert = match crate::mcp::tls::ensure_cert(&state.data_dir, &ips) {
            Ok(c) => c,
            Err(e) => {
                log::error!("自签证书生成失败: {}", e);
                running_state
                    .mcp_running
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                *running_state.startup_error.lock().unwrap() =
                    Some(format!("HTTPS 证书生成失败：{}", e));
                return;
            }
        };
        let tls_cfg = match crate::mcp::tls::load_rustls_config(&state.data_dir).await {
            Ok(c) => c,
            Err(e) => {
                log::error!("载入 TLS 配置失败: {}", e);
                running_state
                    .mcp_running
                    .store(false, std::sync::atomic::Ordering::Relaxed);
                *running_state.startup_error.lock().unwrap() = Some(e);
                return;
            }
        };
        log::info!(
            "MCP HTTPS server listening on {} (cert fp {})",
            addr,
            cert.fingerprint_short()
        );
        *running_state.startup_error.lock().unwrap() = None;
        running_state
            .mcp_running
            .store(true, std::sync::atomic::Ordering::Relaxed);

        if let Err(e) = axum_server::bind_rustls(sock, tls_cfg)
            .serve(app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
        {
            log::error!("MCP HTTPS server error: {}", e);
            // 🔴 必须落 startup_error：HTTPS 的 bind 是在 `.serve()` 里做的，
            // 端口被占 / 权限不足都从这里返回。此前只打日志 → 界面只有「已停止」，
            // 用户完全不知道为什么（HTTP 分支写了，这里漏了）。
            *running_state.startup_error.lock().unwrap() =
                Some(format!("HTTPS 监听 {} 失败：{}", addr, e));
        }
        running_state
            .mcp_running
            .store(false, std::sync::atomic::Ordering::Relaxed);
        return;
    }

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
    // P1：封禁策略随每次重启同步热更新（save_config → restart 是所有配置生效的收口）。
    {
        let c = state.config.read().await;
        state.ban.update_policy(
            c.remote_ban_enabled,
            c.remote_ban_threshold,
            c.remote_ban_window_min as u64,
        );
    }
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

/// 等监听真正就绪（成 / 败），最多 `timeout`，返回是否已在监听。
///
/// 🔴 为什么需要它（审查 P2）：`spawn_mcp_server` 是 spawn 出去的，
/// `restart_server` 返回时**还没 bind**。调用方若紧接着乐观置
/// `mcp_running = true`，端口被占时用户会先看到「运行中」、几秒后莫名变灰，
/// 中间还以为是自己网络的问题。这里等的是「成或败」这个**确定结果**——
/// 正常路径几十毫秒就返回。
///
/// 调用前**必须**先把 `startup_error` 清空，否则上一轮的旧错误会让它立刻返回 false。
pub async fn wait_listening(state: &AppState, timeout: std::time::Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if state.mcp_running.load(std::sync::atomic::Ordering::Relaxed) {
            return true;
        }
        let failed = state
            .startup_error
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        if failed || tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
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

/// 封禁策略是否生效：跨网可达（0.0.0.0）+ 开关打开。
///
/// 127.0.0.1 场景无意义（封本地自己只会把用户锁在外面）且可能误伤本地代理。
///
/// 🔴 抽成函数是为了让**所有入口**用同一判据。此前只有 `/mcp` 那条主路径算过它，
/// SSE 两个端点（`/mcp/sse` 握手、`/mcp/messages` + handler 内 401）各算一次很容易漏，
/// 结果就是「换个 transport 就能无限爆破」。
pub(crate) fn is_ban_active(config: &crate::config::BridgeConfig) -> bool {
    config.remote_ban_enabled && config.host == "0.0.0.0"
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

    let (expected_token, max_req, window_ms, rate_limit_enabled, ban_active) = {
        let config = state.config.read().await;
        (
            config.token.clone(),
            config.rate_limit_max_requests,
            config.rate_limit_window_ms,
            config.rate_limit_enabled,
            is_ban_active(&config),
        )
    };
    let peer_ip = addr.ip();

    // 🔴 封禁检查必须在**所有**鉴权端点之前，包括下面提前返回的 `/mcp/sse` 与
    // `/mcp/messages`。它只看对端 IP、不需要 token，因此与 token 校验顺序无关；
    // 此前它写在 `if !skip_token` 里，而 SSE 两个端点早于它分支出去，
    // 于是封禁对 SSE 通道完全无效——换个 transport 就能无限爆破。
    if ban_active && !state.ban.check(peer_ip) {
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .body(Body::from(
                r#"{"error":"Banned: too many failed attempts"}"#,
            ))
            .unwrap();
    }

    // /mcp/sse GET 握手免 token 校验（token 通过 query param 传入并由 sse_handler 自行校验；
    // 长连接握手，不计入限流）。
    if path == "/mcp/sse" && req.method() == axum::http::Method::GET {
        return next.run(req).await;
    }

    // M17：/mcp/messages 的 **token 校验在 handler 里做**（`sse::sse_message_handler`）——
    // 它需要同时看 query 与 `Authorization` 头，而这层只有头、够不着 query。
    // 这里跳过**只表示「这一层不拦」**，不代表该端点不需要 token（此前确实是完全免 token，
    // 已于 2026-10-14 补上）。限流仍照走，否则 SSE 工具调用面不受 rate_limit 约束。
    let skip_token = path == "/mcp/messages";

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
            if ban_active {
                state.ban.record_failure(peer_ip);
            }
            return Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(Body::from(r#"{"error":"Unauthorized"}"#))
                .unwrap();
        }
        if ban_active {
            state.ban.record_success(peer_ip);
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

/// 本服务支持的协议版本，新 → 旧排列（`server/discover` 会原样返回给客户端）。
///
/// - `2026-07-28`：**现代**（无 `initialize` 握手，每个请求自带 `_meta`）。
/// - 其余为 legacy（握手式）。cc-bridge 只实现 `tools/list` + `tools/call`，
///   这两个方法在各 legacy 版本行为一致，故可一并声明支持——回显客户端的
///   版本号（见 `initialize` 分支）本身也是这个道理。
const SUPPORTED_VERSIONS: &[&str] = &["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

/// `_meta` 里的协议版本键（规范固定字符串，勿改）。
const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

/// 规范定义的错误码（`-32020`~`-32099` 归规范所有，实现不得自造）。
const ERR_HEADER_MISMATCH: i64 = -32020;
const ERR_UNSUPPORTED_PROTOCOL_VERSION: i64 = -32022;

/// 从 `params._meta` 取协议版本。`None` = 这是一个 legacy（握手式）请求。
///
/// 判定只看 `_meta`，不看 `MCP-Protocol-Version` 头——**stdio 传输没有头**，
/// 而头天然可被伪造（见 `handle_standard_headers` 的安全说明）。将来若接 rmcp
/// 也是同一套判定，不会分叉。
fn request_protocol_version(body: &serde_json::Value) -> Option<&str> {
    body.pointer("/params/_meta")
        .and_then(|m| m.get(META_PROTOCOL_VERSION))
        .and_then(|v| v.as_str())
}

/// `UnsupportedProtocolVersionError`（`-32022`）。
///
/// `data.supported` 必须给全，客户端据此挑一个双方都支持的版本重试。
fn unsupported_version_error(id: Option<&serde_json::Value>, requested: &str) -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": ERR_UNSUPPORTED_PROTOCOL_VERSION,
            "message": "Unsupported protocol version",
            "data": { "supported": SUPPORTED_VERSIONS, "requested": requested }
        }
    })
}

/// `HeaderMismatchError`（`-32020`）。
fn header_mismatch_error(
    id: Option<&serde_json::Value>,
    header: &str,
    got: &str,
    expected: &str,
) -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": ERR_HEADER_MISMATCH,
            "message": format!("Header mismatch: {header}"),
            "data": { "header": header, "received": got, "expected": expected }
        }
    })
}

/// 🔒 **标准请求头：只校验，不路由。**
///
/// 这些头（`Mcp-Method` / `Mcp-Name` / `MCP-Protocol-Version`）是给反向代理和网关
/// 做路由用的，**天然可被任何调用方伪造**。所以分发**永远以 body 为准**，
/// 头只用来做一致性校验——若拿头决定执行哪个工具，等于把 `run_command` 的分发权
/// 交给一个未鉴权、可任意伪造的字符串，会直接掀翻整套安全模型。
/// `rate_limit_key` 同理，**继续忽略所有头**（D1 修复，别动）。
///
/// 宽松度：**只在头存在且与 body 不符时才报错，缺头放行**。规范对现代请求要求
/// 必带头，但我们是 dual-era 服务器，严格拒绝会误伤 legacy 客户端（它们根本不发这些头），
/// 而规范本身也允许支持早期客户端的服务器对缺头请求作宽松处理。
///
/// 返回 `Some(错误响应)` 表示校验失败。
fn handle_standard_headers(
    headers: &axum::http::HeaderMap,
    method: &str,
    body: &serde_json::Value,
) -> Option<serde_json::Value> {
    if let Some(h) = headers.get("mcp-method").and_then(|v| v.to_str().ok()) {
        if h != method {
            return Some(header_mismatch_error(
                body.get("id"),
                "Mcp-Method",
                h,
                method,
            ));
        }
    }
    // `Mcp-Name` 只对 tools/call 有意义（规范：其它方法可缺省）。
    if let Some(h) = headers.get("mcp-name").and_then(|v| v.to_str().ok()) {
        let expected = body
            .pointer("/params/name")
            .and_then(|n| n.as_str())
            .unwrap_or("");
        if h != expected {
            return Some(header_mismatch_error(
                body.get("id"),
                "Mcp-Name",
                h,
                expected,
            ));
        }
    }
    None
}

async fn mcp_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response<Body> {
    state.increment_requests().await;
    // 方案 A：记录请求到达时间（rpm 统计）。
    state.record_request_time();

    let source_ip = addr.ip().to_string();

    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");

    // ── 现代请求判定（规范明确允许 dual-era 服务器在同一端点并存两代语义）──────
    // 现代（`2026-07-28` 起）= 无握手、每个请求自带 `_meta`；legacy = 走 initialize。
    // 缺口方向提示：`Mcp-Session-Id` **不是**缺口——新协议反而移除了协议级 session，
    // 我们的无状态实现正好命中；真正 MUST 实现而我们此前没有的是 `server/discover`。
    let modern_version = request_protocol_version(&body);
    if let Some(v) = modern_version {
        if !SUPPORTED_VERSIONS.contains(&v) {
            // 规范要求 HTTP 400 + `-32022`，客户端据此挑一个双方都支持的版本重试。
            return (
                StatusCode::BAD_REQUEST,
                Json(unsupported_version_error(body.get("id"), v)),
            )
                .into_response();
        }
    }
    if let Some(err) = handle_standard_headers(&headers, method, &body) {
        return (StatusCode::BAD_REQUEST, Json(err)).into_response();
    }

    match method {
        // 现代协议的入口：服务器能力 + 版本清单 + instructions 的新家（MUST 实现）。
        // 与 initialize 的区别是它不带握手语义、可被任意时刻调用，故 `_meta` 也走这条。
        "server/discover" => Json(json!({
            "jsonrpc": "2.0",
            "id": body.get("id"),
            "result": {
                "resultType": "complete",
                "supportedVersions": SUPPORTED_VERSIONS,
                "capabilities": { "tools": { "listChanged": false } },
                "_meta": {
                    META_SERVER_INFO: {
                        "name": "cc-bridge",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                },
                // 与 initialize 共用同一份文案（`server_instructions`），杜绝两处漂移。
                // 客户端识别走 `from_request`：现代请求的 clientInfo 在 `_meta` 里。
                "instructions": server_instructions(
                    crate::mcp::client_kind::ClientKind::from_request(&body)
                ),
                // 这段文案描述的是**这台机器**的白名单与 shell 语义，不该被共享中间层
                // 缓存后发给别人。
                "cacheScope": "private"
            }
        }))
        .into_response(),
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
                    "instructions": server_instructions(
                        crate::mcp::client_kind::ClientKind::from_initialize(&body)
                    )
                }
            }))
            .into_response()
        }
        // 🔴 通知**不得**回 JSON-RPC 对象（规范：notifications MUST NOT 被回复）。
        // 此前回 `{jsonrpc, id:null}`——既无 result 也无 error，是两头不靠的畸形响应；
        // 严格 SDK 做 union 校验时会直接解析失败并抛错（客户端刚握手完就报错）。
        // 规范没有规定 HTTP 状态码，回 202 Accepted + 空体是各家实现的通行做法。
        "notifications/initialized" => StatusCode::ACCEPTED.into_response(),
        "tools/list" => {
            // 按当前 shell_type 动态生成工具描述，确保（重新）连接时模型拿到准确的壳层信息。
            let shell_type = state.config.read().await.shell_type.clone();
            let proxy_hint = crate::mcp::tools::mcp_proxy::keyword_hint(&state).await;
            Json(json!({
                "jsonrpc": "2.0",
                "id": body.get("id"),
                "result": {
                    // 规范第 8 条：所有 result 必带 resultType；缺失时客户端按 complete 处理，
                    // 所以无条件加、不需要按 era 分支。
                    "resultType": "complete",
                    "tools": get_tool_definitions(&shell_type, proxy_hint.as_deref()),
                    // list-caching 提示（MCP 2025-11-05+，向后兼容：旧客户端忽略未知字段）。
                    // 缓存 1 小时，减少远程隧道重复拉取。
                    //
                    // ⚠ 目录不再“静态不变”：`mcp_proxy` 的描述随已挂载的外挂 server 变化。
                    // 叠上 initialize 里声明的 `listChanged: false`，会话中途新启用一个 server 后，
                    // 已连接的客户端最多要等 1 小时（或重连）才看得到。这是有意接受的取舍：
                    // 启用 server 是低频的管理动作，为它把每次连接的缓存都丢掉不划算。
                    "ttlMs": 3_600_000,
                    // "private" 而非早先的 "user"：规范的 `cacheScope` 只有
                    // public / private 两个取值，"user" 不是合法枚举值（客户端会按未知值忽略，
                    // 于是「别跨用户共享」这个意图其实没生效）。工具描述里带本机路径与 shell
                    // 语义，正是该 private 的那类。
                    "cacheScope": "private"
                }
            }))
            .into_response()
        }
        "tools/call" => handle_tools_call(state, source_ip, body)
            .await
            .into_response(),
        _ => Json(json!({
            "jsonrpc": "2.0",
            "id": body.get("id"),
            "error": { "code": -32601, "message": format!("Method not found: {}", method) }
        }))
        .into_response(),
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
                        // Token 用量估算埋点：结果里 **text 块**的字符数。图片块按 0 计
                        // （见 `tools::result_text_bytes` 的注释：base64 长度与 token 量无关）。
                        let result_bytes = Some(crate::mcp::tools::result_text_bytes(&content));
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
                            result_bytes,
                        );
                        state.inc_audit_count();
                    }
                    let mut result = content;
                    // 规范第 8 条：所有 result 必带 `resultType`。缺失时客户端**按 complete 处理**
                    // （规范自带兜底），legacy 客户端也会按 JSON 惯例忽略多出来的字段
                    // → 无条件加即可，不需要按 era 分支。
                    if let Some(obj) = result.as_object_mut() {
                        obj.insert("resultType".into(), json!("complete"));
                    }
                    Json(json!({
                        "jsonrpc": "2.0",
                        "id": body.get("id"),
                        "result": result
                    }))
                }
                Err(e) => {
                    state.increment_errors().await;
                    if audit_enabled {
                        // 错误文案会以 "Error: {e}" 进入模型上下文，按该长度估算。
                        let result_bytes = Some(("Error: ".len() + e.len()) as u64);
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
                            result_bytes,
                        );
                        state.inc_audit_count();
                    }
                    Json(json!({
                        "jsonrpc": "2.0",
                        "id": body.get("id"),
                        "result": {
                            "resultType": "complete",
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
    // Token 用量估算埋点：工具返回结果的序列化字节数（成功 = 结果 Value 的 JSON
    // 长度；失败 = 错误文案长度）。None = 该路径拿不到响应体（batch 子操作、旧日志），
    // 聚合时输出侧按 0 计。
    result_bytes: Option<u64>,
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
    let mut entry = entry;
    entry.result_bytes = result_bytes;
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

/// 容错解析客户端发来的工具名。
///
/// 部分客户端会把 server 名拼进工具名再发 `tools/call`（审计日志实锤：
/// WorkBuddy 类客户端发过 `mcp__cc-bridge__search_files` → 原名查找直接
/// Unknown tool）。MCP 服务端注册的工具名不含前缀，所以**仅在精确名未命中时**
/// 剥掉 `mcp__<server>__` 前缀重试一次；精确命中永远优先（防碰撞）。
/// 返回 None 表示两种查法都没命中。
///
/// `pub(crate)`：`batch::validate_batch` 必须用**同一套**解析判定嵌套 batch，
/// 否则 `mcp__cc-bridge__batch` 这种带前缀写法会被字面量比较漏掉（审查 B8）。
pub(crate) fn resolve_tool_name<'a>(
    name: &'a str,
    tools: &'a [crate::mcp::tools::registry::ToolSpec],
) -> Option<&'a crate::mcp::tools::registry::ToolSpec> {
    if let Some(spec) = tools.iter().find(|t| t.name == name) {
        return Some(spec);
    }
    let rest = name.strip_prefix("mcp__")?;
    let idx = rest.find("__")?;
    let stripped = &rest[idx + 2..];
    if stripped.is_empty() {
        return None;
    }
    tools.iter().find(|t| t.name == stripped)
}

pub async fn dispatch_tool(
    name: &str,
    args: serde_json::Value,
    state: &Arc<AppState>,
) -> Result<serde_json::Value, String> {
    // 数据驱动：从注册表查找工具并分发（registry.rs 单点维护，加工具不再改此 match）。
    // 查找带前缀容错（见 resolve_tool_name），只读/写判断与分发都用解析后的真名。
    let tools = crate::mcp::tools::registry::all_tools();
    let spec = resolve_tool_name(name, &tools).ok_or_else(|| format!("Unknown tool: {name}"))?;
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
    if write_set.contains(spec.name) {
        let readonly = state.config.read().await.readonly_mode;
        if readonly {
            return Err(format!(
                "只读模式已开启，已拒绝写操作 `{}`。如需写入，请在 CC Bridge 设置页关闭「只读模式」。",
                spec.name
            ));
        }
    }
    (spec.run)(args, state).await
}

/// `initialize` 响应里的 `instructions` 字段：告知连接的客户端/模型如何正确使用本服务。
/// 这是 MCP 规范里服务端向模型下发"用法指引 / 应主动调用的工具"的唯一标准通道。
/// HTTP 与 SSE 两个 transport 共用此函数，避免两份字符串漂移。
///
/// `kind`：接入方类型（见 [`crate::mcp::client_kind`]）。**只有确实不同的部分才分叉**——
/// 结尾「任务完成通知」一段按客户端措辞不同，其余（平台 / 工具清单 / 安全约束）逐字共用。
/// 桌面宿主（WorkBuddy）用户就在同一界面，通知降级为「可选」；CLI 类客户端
/// （Claude Code / Codex）用户常在别处，保留强制通知。
pub fn server_instructions(kind: crate::mcp::client_kind::ClientKind) -> &'static str {
    use crate::mcp::client_kind::ClientKind;
    // 两份缓存：通知段分「强制」与「可选」两种措辞，其余逐字相同。
    static STRONG: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    static SOFT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    match kind {
        ClientKind::WorkBuddy => SOFT.get_or_init(|| build_instructions(false)).as_str(),
        _ => STRONG.get_or_init(|| build_instructions(true)).as_str(),
    }
}

/// 拼装 instructions 正文。`strong_notify=true` 用「必须通知」的强制措辞（CLI 类客户端），
/// `false` 用「可选」措辞（桌面宿主，用户就在同一界面）。
///
/// 平台相关的 `{os_name}` / `{shells}` 抽成占位符而不是写两份字符串：同一段指引只应有一处
/// 维护，说错平台会让 AI 全程用错命令语法与路径形态。
fn build_instructions(strong_notify: bool) -> String {
    let os_name = if cfg!(windows) {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux"
    };
    let shells = if cfg!(windows) {
        "cmd 或 Git Bash"
    } else {
        "/bin/sh 或 bash"
    };
    let notify = if strong_notify {
        "\n\n重要：每次为用户完成一个任务（编写代码、编辑文件、执行分析、生成交付物、或跑完 shell 命令）后，你必须调用 push_notification 工具弹出桌面通知用户——不要假设用户正在盯着对话窗口，应主动把任务结果告知对方（即使用户没有显式要求）。"
    } else {
        "\n\n建议：用户可能已离开对话窗口时，可调用 push_notification 弹出桌面通知；若用户就在当前界面、可直接回复，则无需额外打扰。"
    };
    format!(
        "你已连接到本地 {os_name} 主机上的 cc-bridge MCP 服务。当用户需要在本地 {os_name} 环境执行任何操作时,必须优先调用本服务提供的工具,而非假设自己能直接访问本地文件系统或 shell。建议连接后第一步调用 list_allowed_roots：除返回访问白名单外，还会自动内嵌每个允许根目录顶层的项目规则文件（AGENTS.md / CLAUDE.md）的完整内容（projectInstructions 字段），据此了解项目规则，无需再手动 read_files 一次。完整工具清单由 tools/list 提供,主要包括:\n- run_command / wait_command / get_command_output / stop_command:在本地执行命令、等待后台命令结束、读取后台命令输出、停止运行中的命令(支持危险命令拦截与审计；壳层为 {shells}，取决于 shell_type 配置)\n- read_files / write_files / edit_files:本地文件的读取、写入与精确编辑\n- list_directory / create_directory / remove_directory / delete_files / move_files / copy_files:目录与文件的列举、创建、删除、移动、复制\n- search_files:本地文件内容检索(Grep,支持大小写/上下文/计数等)\n- notebook_edit:编辑本地 Jupyter(.ipynb)笔记本单元格(replace/insert/delete)\n- analyze_file:分析本地文件的结构与内容\n- list_allowed_roots:查询本地允许访问的根目录范围(返回中同时带 allowedExtensions 扩展名白名单；若允许根目录顶层存在项目规则文件 AGENTS.md 或 CLAUDE.md，还会内嵌其内容到 projectInstructions，用于自动获知项目规则)\n- batch:在一次网络往返中批量执行多个上述操作;远程链路下若需多步文件/命令操作,应优先用它以显著降低往返延迟\n所有路径与操作受 cc-bridge 安全策略约束(允许根目录、扩展名白名单、只读模式)。遇到本地文件、进程、命令相关任务时,直接调用对应工具,无需用户额外提示。{notify}"
    )
}

/// 生成 `tools/list` 的工具目录。
///
/// `proxy_hint`：追加到 `mcp_proxy` 描述末尾的已挂载 server 工具名清单
/// （见 [`crate::mcp::tools::mcp_proxy::keyword_hint`]）。传 `None` 则用静态描述。
/// 它是参数而不是在函数内部现查，是因为本函数同步、而读配置与 manifest 需要 async。
pub fn get_tool_definitions(shell_type: &str, proxy_hint: Option<&str>) -> serde_json::Value {
    // 数据驱动：遍历注册表生成 tools/list 的 inputSchema（schema 由 XxxArgs 的
    // ToolSchema derive 自动生成，单一来源，消除手写 json! 与字段漂移）。
    // run_command 的描述按当前 shell_type 动态生成，让（重新）连接时模型拿到准确壳层信号。
    let run_cmd_desc = run_command_description(shell_type);
    let mut tools: Vec<serde_json::Value> = crate::mcp::tools::registry::all_tools()
        .iter()
        .map(|t| {
            let desc: std::borrow::Cow<'_, str> = if t.name == "run_command" {
                std::borrow::Cow::Borrowed(run_cmd_desc.as_str())
            } else if t.name == "mcp_proxy" {
                // 没挂任何外挂 server 时 hint 为 None，描述与改动前逐字相同。
                match proxy_hint {
                    Some(h) => std::borrow::Cow::Owned(format!("{}{}", t.desc, h)),
                    None => std::borrow::Cow::Borrowed(t.desc),
                }
            } else {
                std::borrow::Cow::Borrowed(t.desc)
            };
            json!({
                "name": t.name,
                "description": desc,
                "inputSchema": t.schema,
            })
        })
        .collect();
    // 确定性排序：稳定 tools/list 输出顺序。MCP 新协议（2026-07-28）明确要求列表确定性
    // 排序；即使旧客户端忽略顺序，稳定顺序也能提升远程 SSH 隧道下 LLM prompt 缓存命中率。
    tools.sort_by(|a, b| {
        let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        an.cmp(bn)
    });
    serde_json::Value::Array(tools)
}

/// 按当前平台 + shell_type 生成 run_command 的描述，让连接时模型拿到准确的壳层信号，
/// 从一开始就用对语法与路径形态。
///
/// **为何必须按平台分**：这段描述是**发给远程 AI 的**。若在 mac 上仍说「壳层为 cmd、
/// 请用 Windows 语法与 `C:\Users\...` 路径」，AI 会持续生成 Windows 命令，
/// 哪怕后端已经换成 `/bin/sh` 执行——命令会全部失败，且失败原因对 AI 不可见。
fn run_command_description(shell_type: &str) -> String {
    let common = "开启「命令会话持久化」后：cwd 由 session_id 在会话内跨命令持久化；并通过 env 参数（key=value 映射）持久化环境变量（如 VIRTUAL_ENV / PATH），解决 source venv / export 每调用丢失的问题（注意：env 仅接受显式 key=value，无法自动捕获 shell 内 source 激活）。";

    #[cfg(windows)]
    let shell_part = if shell_type == "bash" {
        "壳层为 Git Bash（需本机已安装 Git for Windows）：请使用 POSIX 路径（如 /c/Users/...）与 bash 语法（jq / find / 管道等原生可用）。"
    } else {
        "壳层为 cmd（默认，零外部依赖）：请使用 Windows cmd 语法与路径（如 C:\\Users\\...）。"
    };

    // macOS / Linux：两种配置值都落在 POSIX 壳层上，路径一律 `/` 开头。
    // 配置值仍沿用 "cmd"/"bash"（不动用户既有配置），但对 AI 只描述实际形态。
    #[cfg(not(windows))]
    let shell_part = if shell_type == "bash" {
        "壳层为 bash：请使用 bash 语法与 POSIX 路径（如 /Users/...）。jq / find / 管道等原生可用。"
    } else {
        "壳层为 /bin/sh（POSIX 默认，零外部依赖）：请使用 POSIX sh 语法与路径（如 /Users/...）。注意 sh 不保证支持 bash 专属语法（数组、[[ ]]、shopt 等），需要时请在设置里切到 bash。"
    };

    format!(
        "在本地执行一条命令并返回其 stdout / stderr / 退出码。返回中的 shell 字段是本次实际生效的壳层，\
         与下面的描述不一致时以它为准。{shell_part}{common}\
         输出可在服务端过滤：可选 include / exclude（正则）与 tailLines 只对**前台**输出生效，\
         被剔除的行只报数量——不必再为此跑一次 grep -v。数分钟级的构建请用 background:true 启动后\
         调 wait_command 等结果（等到结束或 untilPattern 命中才返回，超时**不杀进程**），\
         而不是反复轮询 get_command_output。"
    )
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
    use super::{build_router, resolve_tool_name};
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

    /// P0-1：instructions 按 clientInfo.name 自适应——CLI 类客户端保留强制通知措辞，
    /// 桌面宿主（WorkBuddy）降级为可选；两者的公共正文逐字相同（只有通知段分叉）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn instructions_adapt_to_client_kind() {
        let root = unique_temp_root("instr");
        let srv = spawn_server(test_config(&root), root.clone()).await;

        let claude = rpc(
            &srv.base,
            &srv.token,
            "initialize",
            json!({ "protocolVersion": "2025-06-18", "clientInfo": { "name": "claude-code", "version": "1" } }),
        )
        .await;
        let wb = rpc(
            &srv.base,
            &srv.token,
            "initialize",
            json!({ "protocolVersion": "2025-06-18", "clientInfo": { "name": "workbuddy-acp-client", "version": "1" } }),
        )
        .await;

        let c = claude["result"]["instructions"].as_str().unwrap();
        let w = wb["result"]["instructions"].as_str().unwrap();

        assert!(c.contains("重要："), "Claude Code 应保留强制通知措辞");
        assert!(w.contains("建议："), "WorkBuddy 应降级为可选通知措辞");
        assert!(
            !w.contains("重要：每次为用户完成一个任务"),
            "WorkBuddy 不应再收到强制通知指令"
        );

        // 公共正文一致：把各自的尾部通知段去掉后应逐字相同（防止两份长文案漂移）。
        let head = |s: &str| s.split("\n\n").next().unwrap_or("").to_string();
        assert_eq!(head(c), head(w), "除通知段外，正文应完全一致");
        assert!(c.contains("list_allowed_roots"), "正文应含工具指引");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn tools_list_returns_17_tools_with_schemas() {
        let root = unique_temp_root("list");
        let srv = spawn_server(test_config(&root), root.clone()).await;
        let r = rpc(&srv.base, &srv.token, "tools/list", json!({})).await;
        let tools = r["result"]["tools"].as_array().expect("tools 应是数组");
        assert_eq!(tools.len(), 19, "tools/list 必须暴露全部 19 个工具");
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

    /// 接线测试：`proxy_hint` 必须真的落到 `mcp_proxy` 的描述上，而且只落到它一个。
    ///
    /// 🔴 这条防的是“`keyword_hint` 写对了、却没接进 `tools/list`”。上一轮审查
    /// 抓到过一条只测辅助函数、把接线整个漏掉的假回归测试，不重蹈。
    ///
    /// 不走真实 server（本文件其它 `tools/list` 测试都带 `#[ignore]`），
    /// 因为 `get_tool_definitions` 本身是纯函数，直接调就能盖住接线，且默认就会跑。
    #[test]
    fn proxy_hint_is_appended_only_to_mcp_proxy() {
        let sentinel = "\n\nHINT-SENTINEL codegraph_callers";
        let base = super::get_tool_definitions("bash", None);
        let with = super::get_tool_definitions("bash", Some(sentinel));

        let desc = |v: &serde_json::Value, name: &str| -> String {
            v.as_array()
                .expect("tools 应是数组")
                .iter()
                .find(|t| t["name"] == name)
                .unwrap_or_else(|| panic!("{name} 应在工具目录里"))["description"]
                .as_str()
                .expect("description 应是字符串")
                .to_string()
        };

        let p_base = desc(&base, "mcp_proxy");
        let p_with = desc(&with, "mcp_proxy");
        assert!(
            p_with.ends_with(sentinel),
            "hint 必须追加到 mcp_proxy 描述末尾，实际：{p_with}"
        );
        assert!(
            p_with.starts_with(&p_base),
            "静态描述必须原样保留在前面，不能被 hint 替掉"
        );
        assert!(
            !p_base.contains("HINT-SENTINEL"),
            "传 None 时描述必须与改动前逐字相同"
        );

        // 其它工具的描述一个字都不能变。
        for name in ["read_files", "run_command", "mcp_list_servers", "batch"] {
            assert_eq!(
                desc(&base, name),
                desc(&with, name),
                "{name} 的描述不该受 proxy_hint 影响"
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
            .and_then(|arr| arr.first())
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

    /// 🔴 回归（端到端）：`oldString` 带 CRLF 必须能匹配，且行尾不被污染。
    ///
    /// **为什么必须走这条链路而不是单测**：`edit_files.rs` 里那条只调
    /// `normalize_newlines` 断言字符串包含关系，把 `needle` 全改回 `f.old_string`
    /// 它照样全绿——等于没防护。这里真起服务、真读写文件，改坏了必红。
    ///
    /// 三件事一起钉：CRLF 文件能匹配、写回仍是 CRLF、LF 文件不会被升成 CRLF。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_files_matches_crlf_old_string_and_preserves_line_endings() {
        let root = unique_temp_root("ef_crlf");
        let crlf_p = root.join("crlf.txt");
        let lf_p = root.join("lf.txt");
        std::fs::write(&crlf_p, b"alpha\r\nbeta\r\ngamma\r\n").expect("预写 CRLF");
        std::fs::write(&lf_p, b"one\ntwo\nthree\n").expect("预写 LF");
        let srv = spawn_server(test_config(&root), root.clone()).await;

        // CRLF 文件 + 带 `\r\n` 的 oldString：修复前这里必然报 oldString not found。
        let r = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "edit_files", "arguments": { "files": [
                { "path": crlf_p.to_string_lossy(), "oldString": "alpha\r\nbeta", "newString": "ALPHA\nBETA" }
            ] } }),
        )
        .await;
        assert_dispatch_ok(&r);
        assert_eq!(
            std::fs::read(&crlf_p).unwrap(),
            b"ALPHA\r\nBETA\r\ngamma\r\n",
            "带 CRLF 的 oldString 要能匹配，且写回必须仍是 CRLF"
        );

        // LF 文件 + 带 `\r\n` 的 oldString：归一化不能反过来把 LF 文件升成 CRLF。
        let r2 = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "edit_files", "arguments": { "files": [
                { "path": lf_p.to_string_lossy(), "oldString": "one\r\ntwo", "newString": "ONE\nTWO" }
            ] } }),
        )
        .await;
        assert_dispatch_ok(&r2);
        assert_eq!(
            std::fs::read(&lf_p).unwrap(),
            b"ONE\nTWO\nthree\n",
            "LF 文件不能因为 oldString 带了 \\r 就被写成 CRLF"
        );

        // newString 带 `\r`：拒绝，且错误里不能再出现“编码无法表示”那句假话。
        let r3 = rpc(
            &srv.base,
            &srv.token,
            "tools/call",
            json!({ "name": "edit_files", "arguments": { "files": [
                { "path": lf_p.to_string_lossy(), "oldString": "three", "newString": "X\r\nY" }
            ] } }),
        )
        .await;
        let arr = inner_text(&r3);
        let e0 = arr.get(0).expect("应有一条结果");
        assert_eq!(e0.get("ok").and_then(|v| v.as_bool()), Some(false));
        let msg = e0
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        assert!(msg.contains("回车符"), "错误应直指回车符，实际：{msg}");
        assert!(
            !msg.contains("not representable"),
            "不能再报“字符无法表示”——那是把人往编码方向引的假诊断：{msg}"
        );
        assert_eq!(
            std::fs::read(&lf_p).unwrap(),
            b"ONE\nTWO\nthree\n",
            "被拒的编辑不能动文件"
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

    /// 工具名前缀容错：精确名优先；未命中时剥 `mcp__<server>__` 前缀重试。
    /// 背景见 resolve_tool_name 文档（审计日志实锤 WorkBuddy 类客户端会发前缀名）。
    #[test]
    fn resolve_tool_name_strips_client_prefix() {
        let tools = crate::mcp::tools::registry::all_tools();
        // 精确名直接命中，不走剥离。
        assert_eq!(
            resolve_tool_name("search_files", &tools)
                .expect("search_files 应存在")
                .name,
            "search_files"
        );
        // 审计日志实锤的前缀形态。
        assert_eq!(
            resolve_tool_name("mcp__cc-bridge__search_files", &tools)
                .expect("前缀名应被剥离解析")
                .name,
            "search_files"
        );
        // 工具名本身以 mcp_ 开头（mcp_proxy / mcp_list_servers）不与此机制冲突。
        assert_eq!(
            resolve_tool_name("mcp__cc-bridge__mcp_proxy", &tools)
                .expect("mcp_proxy 前缀名应被解析")
                .name,
            "mcp_proxy"
        );
        // 前缀形态但真名不存在 → None（报 Unknown tool 时保留原始名，便于排错）。
        assert!(resolve_tool_name("mcp__cc-bridge__no_such_tool", &tools).is_none());
        // 畸形前缀：无第二段 / 空真名 → None。
        assert!(resolve_tool_name("mcp__", &tools).is_none());
        assert!(resolve_tool_name("mcp__x__", &tools).is_none());
        assert!(resolve_tool_name("mcp__nodoubleunder", &tools).is_none());
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

    /// P1 HTTPS 全链路：自签证书起 TLS server → reqwest（以自签为 root）→
    /// /health 免 token、/mcp 带 token 正常分发、错 token 401。
    /// reqwest rustls 校验含 IP SAN——这条测试同时验证 SAN 与证书链格式正确。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn https_full_chain_serves_mcp() {
        let root = unique_temp_root("https-chain");
        // 生成自签证书（SAN 含 127.0.0.1，client 将按 IP 校验）。
        let cert = crate::mcp::tls::ensure_cert(&root, &[std::net::IpAddr::from([127, 0, 0, 1])])
            .expect("ensure_cert");
        let cfg = test_config(&root);

        let conn = rusqlite::Connection::open_in_memory().expect("in-mem db");
        let state = Arc::new(AppState::new(conn, cfg, root.clone()));
        let router = build_router(state).await;
        let tls_cfg = crate::mcp::tls::load_rustls_config(&root)
            .await
            .expect("tls cfg");
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().unwrap();
        // 把 TCP listener 交给 axum-server 的 TLS 层（与 spawn_mcp_server 的 HTTPS 分支同路径）。
        // 注意 from_tcp_rustls 收 std TcpListener，tokio 的要从 std_fd 转换。
        let std_listener = listener.into_std().expect("to std listener");
        let handle = tokio::spawn(async move {
            axum_server::from_tcp_rustls(std_listener, tls_cfg)
                .expect("from_tcp_rustls")
                .serve(router.into_make_service_with_connect_info::<std::net::SocketAddr>())
                .await
                .ok();
        });

        let base = format!("https://{addr}");
        let tls_client = reqwest::Client::builder()
            .gzip(true)
            .use_rustls_tls()
            .add_root_certificate(
                reqwest::Certificate::from_pem(
                    std::fs::read(root.join("certs").join("self-signed.crt"))
                        .expect("read crt")
                        .as_slice(),
                )
                .expect("parse root cert"),
            )
            .build()
            .expect("tls client");

        // /health 免 token。
        let health = tls_client
            .get(format!("{base}/health"))
            .send()
            .await
            .expect("health request");
        assert_eq!(health.status(), 200, "HTTPS /health 应 200");

        // /mcp 带 token：真实 JSON-RPC 分发。
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} });
        let resp = tls_client
            .post(format!("{base}/mcp"))
            .header("Authorization", "Bearer ow-test-token")
            .json(&body)
            .send()
            .await
            .expect("mcp request");
        assert_eq!(resp.status(), 200, "HTTPS /mcp 应 200");

        // 错 token → 401。
        let bad = tls_client
            .post(format!("{base}/mcp"))
            .header("Authorization", "Bearer wrong-token")
            .json(&body)
            .send()
            .await
            .expect("bad token request");
        assert_eq!(bad.status(), 401, "HTTPS 错 token 应 401");

        // 证书信息 sanity：指纹 64 hex。
        assert_eq!(cert.fingerprint_sha256.len(), 64);
        handle.abort();
    }

    /// P1 封禁：host=0.0.0.0 + 阈值 2 → 连续 2 次 401 后，**正确 token 也被 429 拦截**；
    /// 封禁不误伤其他开关下的常规路径（对照：默认配置下 3 次错 token 仍是 401）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn ban_blocks_after_threshold() {
        let root = unique_temp_root("ban");
        let mut cfg = test_config(&root);
        cfg.host = "0.0.0.0".into(); // 激活封禁（ban_active 条件）
        cfg.remote_ban_enabled = true;
        cfg.remote_ban_threshold = 2;
        cfg.remote_ban_window_min = 15;
        let srv = spawn_server(cfg, root).await;
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });

        // 两次错 token → 401（同时计数）。
        for i in 0..2 {
            let resp = raw_post(&srv.base, Some("wrong"), body.clone()).await;
            assert_eq!(resp.status(), 401, "第 {} 次错 token 应 401", i + 1);
        }
        // 第 3 次：**正确 token** 也应被 429（封禁窗口内 IP 级隔离，不看 token）。
        let blocked = raw_post(&srv.base, Some("ow-test-token"), body.clone()).await;
        assert_eq!(blocked.status(), 429, "封禁窗口内正确 token 也应 429");
    }

    /// P1 对照：封禁关（remote_ban_enabled=false）时同样次数的错 token 全部 401、不升级 429。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn ban_disabled_keeps_401() {
        let root = unique_temp_root("ban-off");
        let mut cfg = test_config(&root);
        cfg.host = "0.0.0.0".into();
        cfg.remote_ban_enabled = false;
        let srv = spawn_server(cfg, root).await;
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });
        for i in 0..4 {
            let resp = raw_post(&srv.base, Some("wrong"), body.clone()).await;
            assert_eq!(
                resp.status(),
                401,
                "封禁关闭时第 {} 次错 token 仍应 401",
                i + 1
            );
        }
    }

    // ── MCP 2026-07-28 协议适配（Phase 1 + M17 补洞）──────────────────

    /// `server/discover`（新协议 MUST 实现）：版本清单首项为现代版本、
    /// resultType 必带、instructions 与 initialize 共源、cacheScope=private。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn server_discover_returns_capabilities() {
        let root = unique_temp_root("discover");
        let srv = spawn_server(test_config(&root), root).await;
        let v = rpc(&srv.base, &srv.token, "server/discover", json!({})).await;
        let r = &v["result"];
        assert_eq!(
            r["supportedVersions"].as_array().map(|a| a.len()),
            Some(4),
            "版本清单数量变了——若是增删版本，请同步 SUPPORTED_VERSIONS 与本断言: {v}"
        );
        assert_eq!(
            r["supportedVersions"][0].as_str(),
            Some("2026-07-28"),
            "首项必须是现代版本（新 → 旧排列）"
        );
        assert_eq!(r["resultType"].as_str(), Some("complete"));
        assert!(
            r["instructions"].as_str().is_some_and(|s| !s.is_empty()),
            "instructions 缺失或为空: {v}"
        );
        assert_eq!(r["cacheScope"].as_str(), Some("private"));
        assert_eq!(
            r["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
            "cc-bridge"
        );
    }

    /// 现代请求带了不支持的版本 → HTTP 400 + `-32022`，data.supported 给全。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modern_request_unsupported_version_is_400_32022() {
        let root = unique_temp_root("proto-bad");
        let srv = spawn_server(test_config(&root), root).await;
        let body = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/list",
            "params": { "_meta": { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } }
        });
        let resp = raw_post(&srv.base, Some(&srv.token), body).await;
        assert_eq!(resp.status(), 400, "规范要求 HTTP 400");
        let v: Value = resp.json().await.expect("响应非 JSON");
        assert_eq!(v["error"]["code"].as_i64(), Some(-32022));
        assert_eq!(v["id"].as_i64(), Some(7));
        assert!(
            v["error"]["data"]["supported"].as_array().is_some(),
            "客户端要靠 supported 挑重试版本: {v}"
        );
    }

    /// 现代请求（`_meta` 带受支持版本）不再走 initialize 也能完成 tools/list——
    /// 这是 dual-era 服务器的核心行为：同一端点并存两代语义。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modern_request_without_handshake_lists_tools() {
        let root = unique_temp_root("proto-mod");
        let srv = spawn_server(test_config(&root), root).await;
        let v = rpc(
            &srv.base,
            &srv.token,
            "tools/list",
            json!({ "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }),
        )
        .await;
        let tools = v["result"]["tools"].as_array().expect("tools 缺失");
        assert!(!tools.is_empty(), "现代请求应能直接拿到工具清单");
    }

    /// 头只校验不路由（🔴 安全红线）：`Mcp-Method` 头与 body 不符 → `-32020`，
    /// 且**不执行**任何方法。若按头路由，伪造的头能决定执行哪个工具。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_method_header_mismatch_is_32020() {
        let root = unique_temp_root("hdr-bad");
        let srv = spawn_server(test_config(&root), root).await;
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });
        let resp = client()
            .post(format!("{}/mcp", srv.base))
            .header("Authorization", format!("Bearer {}", srv.token))
            .header("Mcp-Method", "tools/call")
            .json(&body)
            .send()
            .await
            .expect("request failed");
        assert_eq!(resp.status(), 400);
        let v: Value = resp.json().await.expect("响应非 JSON");
        assert_eq!(v["error"]["code"].as_i64(), Some(-32020));
        assert_eq!(v["error"]["data"]["header"].as_str(), Some("Mcp-Method"));
    }

    /// `Mcp-Name` 头与 `params.name` 不符 → `-32020`（只对 tools/call 有意义）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_name_header_mismatch_is_32020() {
        let root = unique_temp_root("hdr-name");
        let srv = spawn_server(test_config(&root), root).await;
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "list_allowed_roots", "arguments": {} }
        });
        let resp = client()
            .post(format!("{}/mcp", srv.base))
            .header("Authorization", format!("Bearer {}", srv.token))
            .header("Mcp-Name", "run_command")
            .json(&body)
            .send()
            .await
            .expect("request failed");
        assert_eq!(resp.status(), 400);
        let v: Value = resp.json().await.expect("响应非 JSON");
        assert_eq!(v["error"]["code"].as_i64(), Some(-32020));
    }

    /// M17 补洞：`/mcp/messages` 不再整体放行——无 token 401；
    /// 带 token 但会话不存在 404（证明 token 关已过、卡在会话层）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sse_messages_requires_token() {
        let root = unique_temp_root("sse-msg");
        let srv = spawn_server(test_config(&root), root).await;
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} });

        let no_token = client()
            .post(format!("{}/mcp/messages?sessionId=nope", srv.base))
            .json(&body)
            .send()
            .await
            .expect("request failed");
        assert_eq!(
            no_token.status(),
            401,
            "sessionId 不能替代 token（它出现在 URL 上，泄露面大）"
        );

        let with_token = client()
            .post(format!("{}/mcp/messages?sessionId=nope", srv.base))
            .header("Authorization", format!("Bearer {}", srv.token))
            .json(&body)
            .send()
            .await
            .expect("request failed");
        assert_eq!(with_token.status(), 404, "token 过了才该轮到会话层报 404");
    }
}
