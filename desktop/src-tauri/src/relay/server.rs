//! 中转的 HTTP 服务：axum Router、监听生命周期、请求主流程。
//!
//! 主流程与 §4.2 一致：
//!
//! ```text
//! guard → auth → parse/sanitize → route → dispatch(Anthropic 透传) → log
//! ```
//!
//! 透传路径的五条铁律（§4.3）在这里落地，每一条都有对应的代码注释：
//! body 除必要改写外原样、响应逐块直通、错误体原样回、不设自己的
//! 超时、不改 query 与 header 值。

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::auth::{self, AuthOutcome};
use super::config::{RelaySettings, MAX_BODY_BYTES};
use super::guard;
use super::log::{LogPatch, RelayLog, RelayLogEntry};
use super::route::{self, RouteError};
use super::sanitize;
use super::usage::{UsageCollectionIssue, UsageObserver};

/// 一次监听的全部运行时依赖。热更新只换 `settings` / `token`，不重启监听。
pub struct ServerState {
    pub settings: Arc<tokio::sync::RwLock<Arc<RelaySettings>>>,
    pub token: Arc<tokio::sync::RwLock<String>>,
    pub log: Arc<RelayLog>,
    /// 实际监听地址（Host 白名单与自转发判定都要用真实值，不是配置里的意图）。
    pub listen_host: String,
    pub port: u16,
    /// 内网直连时对非回环来源启用封禁；隧道模式下全是回环，不封。
    pub ban: BanList,
    pub client: reqwest::Client,
    /// 允许的 Host 形态，启动时算一次。
    pub allowed_hosts: Arc<Vec<String>>,
}

/// 401 连击封禁。**只对非回环来源生效**——自建单人场景下回环请求 401 一定是
/// 自己配置错了，封掉只会让人更查不出来（§4.8.2 第 2 条）。
pub struct BanList {
    inner: std::sync::Mutex<std::collections::HashMap<IpAddr, FailRecord>>,
    threshold: u32,
    window: Duration,
    ban_for: Duration,
}

struct FailRecord {
    count: u32,
    window_start: Instant,
    banned_until: Option<Instant>,
}

impl BanList {
    pub fn new(threshold: u32, window_min: u64) -> Self {
        Self {
            inner: std::sync::Mutex::new(std::collections::HashMap::new()),
            threshold: threshold.max(1),
            window: Duration::from_secs(window_min.max(1) * 60),
            // 封禁时长与窗口同值：单 token 场景下没有「误伤同事」的问题，
            // 但也不该一封永逸——用户改完配置要能自己试回来。
            ban_for: Duration::from_secs(window_min.max(1) * 60),
        }
    }

    pub fn is_banned(&self, ip: IpAddr) -> bool {
        if ip.is_loopback() {
            return false;
        }
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(record) = guard.get(&ip) else {
            return false;
        };
        match record.banned_until {
            Some(until) if until > Instant::now() => true,
            Some(_) => {
                guard.remove(&ip);
                false
            }
            None => false,
        }
    }

    pub fn record_fail(&self, ip: IpAddr) {
        if ip.is_loopback() {
            return;
        }
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let record = guard.entry(ip).or_insert(FailRecord {
            count: 0,
            window_start: now,
            banned_until: None,
        });
        // 窗口过期就重新计数，否则昨天错几次、今天错两次就被封
        if now.duration_since(record.window_start) > self.window {
            record.count = 0;
            record.window_start = now;
        }
        record.count += 1;
        if record.count >= self.threshold {
            record.banned_until = Some(now + self.ban_for);
            log::warn!(
                "中转：来源 {ip} 连续 {} 次鉴权失败，已临时封禁 {} 分钟",
                record.count,
                self.ban_for.as_secs() / 60
            );
        }
    }

    pub fn record_success(&self, ip: IpAddr) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.remove(&ip);
        }
    }
}

/// 一个正在跑的监听。
pub struct RunningServer {
    pub addr: String,
    pub started_at: Instant,
    shutdown: tokio::sync::oneshot::Sender<()>,
    join: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    /// 优雅停止：先让 serve 收尾，5 秒还没完就 abort。
    ///
    /// 超时是必须的：停在一条长流式响应上时，graceful shutdown 会一直等那条流
    /// 结束，窗口就关不掉了（§4.11「优雅停止」）。
    pub async fn stop(mut self) -> bool {
        let _ = self.shutdown.send(());
        if tokio::time::timeout(Duration::from_secs(5), &mut self.join)
            .await
            .is_err()
        {
            self.join.abort();
            return false;
        }
        true
    }
}

/// 拼监听地址。**IPv6 必须带方括号**，否则 `::1:4100` 直接 bind 失败，
/// 而且错误信息里看不出原因（§4.11）。
pub fn socket_addr(host: &str, port: u16) -> String {
    let host = host.trim();
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// 构建客户端。**不设总超时**：长思考 + 128k `max_tokens` 可能跑几分钟，
/// 超时策略归客户端（§4.3 第 4 条）。只设连接超时，避免死连接挂住线程。
fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // 不跟随重定向：上游 302 多半是配置错（少了路径段），跟过去只会更难查，
        // 原样把 3xx 返给客户端更诚实。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("构建上游 HTTP 客户端失败：{e}"))
}

/// 启动监听。返回句柄，调用方负责保存与停止。
pub async fn start(
    settings: Arc<tokio::sync::RwLock<Arc<RelaySettings>>>,
    token: Arc<tokio::sync::RwLock<String>>,
    log: Arc<RelayLog>,
    listen_host: &str,
    port: u16,
    ban_threshold: u32,
    ban_window_min: u64,
) -> Result<RunningServer, String> {
    let addr = socket_addr(listen_host, port);
    let client = build_client()?;

    // 先 bind 再算 Host 白名单：`port` 传 0 时由系统分配端口（集成测试用），
    // 白名单必须用**实际**端口，否则所有请求都会被 421 拒掉。
    let listener = tokio::net::TcpListener::bind(&addr).await.map_err(|e| {
        // 绑定失败不吞错误：用户只看到「启动失败」时无从下手（§4.11）。
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!(
                "端口 {port} 已被占用（{addr}）。可能是上一次的中转还没退干净，\
                 或者别的程序占着这个端口。等几秒再试；仍在占用的话，重启 cc-bridge。"
            )
        } else if e.kind() == std::io::ErrorKind::PermissionDenied {
            format!("没有权限监听 {addr}。请换一个监听地址，或用管理员身份运行。")
        } else {
            format!("无法监听 {addr}：{e}")
        }
    })?;
    let local = listener.local_addr().ok();
    let actual_port = local.map(|a| a.port()).unwrap_or(port);
    let actual_addr = local.map(|a| a.to_string()).unwrap_or_else(|| addr.clone());
    let allowed_hosts = Arc::new(guard::allowed_hosts(listen_host, actual_port));

    let state = Arc::new(ServerState {
        settings,
        token,
        log,
        listen_host: listen_host.to_string(),
        port: actual_port,
        ban: BanList::new(ban_threshold, ban_window_min),
        client,
        allowed_hosts,
    });

    let app = Router::new()
        .route("/v1/messages", post(handle_messages))
        .route("/v1/messages/count_tokens", post(handle_count_tokens))
        .fallback(fallback)
        // 32MB：Claude Code 的大 payload 实测到过 937KB 量级，带历史与工具定义
        // 很容易破 axum 默认的 2MB（§4.11「Body 上限」）。
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state);

    let (shutdown, rx) = tokio::sync::oneshot::channel::<()>();
    let service = app.into_make_service_with_connect_info::<SocketAddr>();
    let started_at = Instant::now();
    let join = tokio::spawn(async move {
        let server = axum::serve(listener, service).with_graceful_shutdown(async {
            let _ = rx.await;
        });
        if let Err(e) = server.await {
            log::error!("中转服务退出：{e}");
        }
    });

    Ok(RunningServer {
        addr: actual_addr,
        started_at,
        shutdown,
        join,
    })
}

/// 未匹配的路径。返回 Anthropic 形态的错误体，客户端能正常显示。
async fn fallback(uri: axum::http::Uri) -> Response {
    error_response(
        StatusCode::NOT_FOUND,
        "invalid_request_error",
        &format!(
            "中转只提供 /v1/messages 与 /v1/messages/count_tokens，不认识 {}。\
             如果你的 BASE_URL 少了路径段（例如 /apps/anthropic），请补齐后重试。",
            uri.path()
        ),
    )
}

/// `/v1/messages` 的入口。
async fn handle_messages(
    State(state): State<Arc<ServerState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_path(state, peer, headers, body, "/v1/messages").await
}

/// `/v1/messages/count_tokens` 的入口。
///
/// 🔴 与 `/v1/messages` 分开注册是必须的：曾经两个路由共用同一个 handler，
/// 而 handler 里写死 `path = "/v1/messages"`——count_tokens 请求被当成普通
/// 补全转发，每次上下文探测都变成一次**真实计费**的请求，客户端还拿不到
/// `input_tokens`。路径只能从路由来。
async fn handle_count_tokens(
    State(state): State<Arc<ServerState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_path(state, peer, headers, body, "/v1/messages/count_tokens").await
}

/// 主处理函数。`path` 是客户端请求的路径（由路由给定），同时决定转发到上游的
/// 哪一个端点与日志里的记录。
async fn handle_path(
    state: Arc<ServerState>,
    peer: SocketAddr,
    headers: HeaderMap,
    body: Bytes,
    path: &str,
) -> Response {
    let started = Instant::now();
    let source = if peer.ip().is_loopback() {
        "local".to_string()
    } else {
        peer.ip().to_string()
    };

    // ── 来源守卫 ──────────────────────────────────────────────────────
    let verdict = guard::check(&headers, &state.allowed_hosts);
    if !verdict.is_allow() {
        let status = match verdict {
            guard::Verdict::BadHost { .. } => StatusCode::MISDIRECTED_REQUEST,
            _ => StatusCode::FORBIDDEN,
        };
        return error_response(status, "permission_error", &verdict.message());
    }

    // ── 封禁 ──────────────────────────────────────────────────────────
    if state.ban.is_banned(peer.ip()) {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limit_error",
            "这个来源连续多次鉴权失败，已临时封禁。请等待几分钟，或重新复制令牌。",
        );
    }

    // ── 鉴权 ──────────────────────────────────────────────────────────
    let expected = state.token.read().await.clone();
    match auth::verify(&expected, &headers) {
        AuthOutcome::Ok => state.ban.record_success(peer.ip()),
        outcome => {
            state.ban.record_fail(peer.ip());
            let mut resp = error_response(
                StatusCode::UNAUTHORIZED,
                "authentication_error",
                outcome.message(),
            );
            // 401 与「上游拒绝」必须能区分：加一个标记头，界面上也按它分类。
            resp.headers_mut()
                .insert("x-relay-auth", HeaderValue::from_static("failed"));
            return resp;
        }
    }

    // ── 配置快照 ──────────────────────────────────────────────────────
    let settings = state.settings.read().await.clone();
    let Some(provider) = settings.active().cloned() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "api_error",
            &RouteError::NoProvider.message(),
        );
    };
    if let Err(field) = provider.validate() {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "api_error",
            &RouteError::NotConfigured { field }.message(),
        );
    }

    // ── 清洗（三态）──────────────────────────────────────────────────
    let prepared = match sanitize::sanitize(&body, &provider) {
        Ok(p) => p,
        Err(refusal) => {
            log_rejected(&state, &source, path, &refusal, body.len() as u64);
            return (StatusCode::BAD_REQUEST, axum::Json(refusal.body())).into_response();
        }
    };

    // ── 路由 ──────────────────────────────────────────────────────────
    let client_model = prepared
        .json
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let decision = match route::resolve(&settings, &client_model) {
        Ok(d) => d,
        Err(e) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, "api_error", &e.message());
        }
    };

    // ── 改写 model 并序列化 ───────────────────────────────────────────
    // 这里是唯一「非必要也非规则」的 body 改写：客户端认的名字换成上游认的名字。
    // 保序序列化（Cargo.toml 的 preserve_order）保证其余字段的字节顺序不变。
    let mut out_json = prepared.json.clone();
    out_json["model"] = serde_json::Value::String(decision.upstream_model.clone());
    let upstream_body = match serde_json::to_vec(&out_json) {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "api_error",
                &format!("重新序列化请求体失败：{e}"),
            );
        }
    };

    // ── 记一条 in-flight ─────────────────────────────────────────────
    let (upstream_provider, upstream_key) = logged_upstream(&provider.base_url)
        .map_or((None, None), |(origin, key)| (Some(origin), Some(key)));
    let log_id = state.log.begin(RelayLogEntry {
        id: 0,
        started_at: Some(started),
        ts_ms: 0,
        source: source.clone(),
        client_model: decision.client_model.clone(),
        tier: decision.tier.as_str().to_string(),
        upstream_model: decision.upstream_model.clone(),
        upstream_provider,
        upstream_key,
        fell_back: decision.fell_back,
        via: decision.via.as_str().to_string(),
        rewrite: prepared.rewrite_label(),
        fold_summary: prepared.fold_summary(),
        sanitized: prepared.changed,
        status: None,
        first_byte_ms: None,
        total_ms: None,
        bytes_in: Some(body.len() as u64),
        bytes_out: None,
        error: None,
        path: path.to_string(),
        ..RelayLogEntry::default()
    });

    // ── 转发 ──────────────────────────────────────────────────────────
    let url = upstream_url(&provider.base_url, path);
    let mut request = state.client.post(&url).body(upstream_body);

    // header 值原样透传（§4.3 第 5 条）：`anthropic-beta` / `anthropic-version`
    // 的值一个字符都不能动，否则 beta 特性静默失效。
    // 只跳过这几类：由 reqwest 重算的、必须换掉的、以及会与压缩协商冲突的。
    const SKIP: [&str; 7] = [
        "host",
        "content-length",
        "authorization",
        "x-api-key",
        "connection",
        "transfer-encoding",
        "accept-encoding",
    ];
    for (name, value) in headers.iter() {
        let key = name.as_str();
        if SKIP.contains(&key) || key.starts_with("x-relay-") {
            continue;
        }
        if let Ok(hv) = reqwest::header::HeaderValue::from_bytes(value.as_bytes()) {
            request = request.header(key, hv);
        }
    }
    // 上游密钥：按 provider 配置的形态发**一种**。两种都带不会有「双保险」——
    // 只认 Authorization 的网关会把多出来的 x-api-key 连同请求一起拒（401 里
    // 看不出带了什么），只认 x-api-key 的则把 Bearer 当陌生头。探测失败时
    // probe 会提示换另一种（`switched_auth`），那才是正确的切换路径。
    request = match provider.auth_style {
        super::config::AuthStyle::XApiKey => request.header("x-api-key", provider.api_key.trim()),
        super::config::AuthStyle::Bearer => request.header(
            "authorization",
            format!("Bearer {}", provider.api_key.trim()),
        ),
    };

    let upstream = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            let message = describe_send_error(&e, &url);
            state.log.finish(
                log_id,
                LogPatch {
                    status: Some(502),
                    total_ms: Some(started.elapsed().as_millis() as u64),
                    error: Some(message.clone()),
                    ..LogPatch::default()
                },
            );
            return error_response(StatusCode::BAD_GATEWAY, "api_error", &message);
        }
    };

    let status = upstream.status();
    let resp_headers = upstream.headers().clone();

    // ── 响应直通 ──────────────────────────────────────────────────────
    // 用量旁路观察已转发的原始块，避免为统计而重新序列化或等待整条响应。
    let stream = resp_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream"))
        });
    let observe_usage = path == "/v1/messages" && status.is_success();
    let unsupported_encoding = observe_usage && !identity_encoded(&resp_headers);
    let mut usage = (observe_usage && !unsupported_encoding).then(|| UsageObserver::new(stream));
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    let log_handle = state.log.clone();
    let sanitized = prepared.changed;
    let status_code = status.as_u16();

    tokio::spawn(async move {
        let mut upstream = upstream;
        let mut first_byte_ms: Option<u64> = None;
        let mut bytes_out: u64 = 0;
        let mut error: Option<String> = None;

        loop {
            match upstream.chunk().await {
                Ok(Some(chunk)) => {
                    if first_byte_ms.is_none() {
                        first_byte_ms = Some(started.elapsed().as_millis() as u64);
                    }
                    bytes_out += chunk.len() as u64;
                    // 发送失败 = 客户端断开（用户 Ctrl+C / 关窗）。不是错误，
                    // 但要让上游停下来，不然一直读到完整响应白烧额度。
                    let retained = usage.as_ref().map(|_| chunk.clone());
                    let sent = tx.send(Ok(chunk)).await;
                    if let (Some(observer), Some(bytes)) = (&mut usage, retained) {
                        observer.push(&bytes);
                    }
                    if sent.is_err() {
                        error = Some("客户端提前断开".into());
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    error = Some(format!("读取上游响应失败：{e}"));
                    break;
                }
            }
        }

        let observed = usage.map(UsageObserver::finish).unwrap_or_default();
        if observed.stream_error && error.is_none() {
            error = Some("上游流式响应中断".into());
        }
        log_handle.finish(
            log_id,
            LogPatch {
                status: Some(status_code),
                first_byte_ms,
                total_ms: Some(started.elapsed().as_millis() as u64),
                bytes_out: Some(bytes_out),
                error,
                reported_model: observed.model,
                usage: observed.tokens,
                usage_collection_issue: if unsupported_encoding {
                    Some(UsageCollectionIssue::UnsupportedEncoding)
                } else if observed.limit_reached {
                    Some(UsageCollectionIssue::ResponseTooLarge)
                } else {
                    None
                },
            },
        );
    });

    let mut response = Response::new(Body::from_stream(
        tokio_stream::wrappers::ReceiverStream::new(rx),
    ));
    *response.status_mut() = status;
    copy_response_headers(&resp_headers, response.headers_mut());
    if sanitized {
        // 可观测：被折叠过的请求能被客户端/代理看到（§4.2 验收）。
        response
            .headers_mut()
            .insert("x-relay-sanitized", HeaderValue::from_static("1"));
    }
    response
}

fn logged_upstream(endpoint: &str) -> Option<(String, String)> {
    let url = reqwest::Url::parse(endpoint).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    // Separate gateway routes on the same host without retaining credentials, query or path.
    let identity = format!("{origin}{}", url.path());
    Some((origin, format!("{:x}", Sha256::digest(identity.as_bytes()))))
}

fn identity_encoded(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::CONTENT_ENCODING)
        .iter()
        .all(|value| {
            value.to_str().is_ok_and(|value| {
                value
                    .split(',')
                    .all(|coding| coding.trim().eq_ignore_ascii_case("identity"))
            })
        })
}

/// 把上游响应头搬到下游。跳过由本层重算或与流式冲突的字段。
///
/// 🔴 用 `append` 不用 `insert`：`HeaderMap::iter()` 对同名多值头会产出多项
/// （多个 `Set-Cookie` 是真实场景），`insert` 是覆盖语义——只活最后一个。
fn copy_response_headers(from: &HeaderMap, to: &mut HeaderMap) {
    const SKIP: [&str; 4] = [
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
    ];
    for (name, value) in from.iter() {
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        if let Ok(hv) = HeaderValue::from_bytes(value.as_bytes()) {
            to.append(name.clone(), hv);
        }
    }
}

/// `https://host/apps/anthropic/v1/messages` + `/v1/messages/count_tokens`
/// → `https://host/apps/anthropic/v1/messages/count_tokens`
fn upstream_url(base_url: &str, path: &str) -> String {
    let root = base_url
        .trim()
        .trim_end_matches('/')
        .strip_suffix("/v1/messages")
        .unwrap_or(base_url);
    format!("{root}{path}")
}

/// 把 reqwest 的错误翻成用户能动手的话。`probe` 也复用它。
///
/// 「连不通」在界面上必须能区分几种情况：域名解析不了（地址写错）、连接被拒
/// （上游端口/路径不对）、证书错误（中间人代理或企业 CA）、超时（网络慢）。
/// 一律回「请求失败」等于让人从头查。
pub fn describe_send_error(err: &reqwest::Error, url: &str) -> String {
    let host = url
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(rest))
        .unwrap_or(url);
    if err.is_connect() {
        let text = err.to_string();
        if text.contains("dns") || text.contains("resolve") {
            format!("解析不了上游地址 {host}。请检查「上游地址」有没有拼错。")
        } else if text.contains("certificate") || text.contains("tls") {
            format!(
                "连接 {host} 时证书校验失败。如果本机开了抓包代理（Clash / mitmproxy），\
                 请把它的根证书装进系统信任区。"
            )
        } else {
            format!("连不上 {host}。地址或端口可能不对，也可能被防火墙拦了。原始错误：{err}")
        }
    } else if err.is_timeout() {
        format!("连接 {host} 超时。上游可能很慢，或者网络不通。")
    } else {
        format!("请求上游失败：{err}")
    }
}

fn error_response(status: StatusCode, kind: &str, message: &str) -> Response {
    let body = json!({
        "type": "error",
        "error": { "type": kind, "message": message }
    });
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

/// 在清洗阶段就被拒的请求也要留痕——否则用户只看到 400，日志里什么都没有。
fn log_rejected(
    state: &ServerState,
    source: &str,
    path: &str,
    refusal: &sanitize::Refusal,
    bytes_in: u64,
) {
    let id = state.log.begin(RelayLogEntry {
        id: 0,
        ts_ms: 0,
        source: source.to_string(),
        client_model: String::new(),
        tier: String::new(),
        upstream_model: String::new(),
        fell_back: false,
        via: "refused".into(),
        rewrite: None,
        fold_summary: None,
        sanitized: false,
        status: None,
        first_byte_ms: None,
        total_ms: None,
        bytes_in: Some(bytes_in),
        bytes_out: None,
        error: None,
        path: path.to_string(),
        ..RelayLogEntry::default()
    });
    state.log.finish(
        id,
        LogPatch {
            status: Some(400),
            total_ms: Some(0),
            error: Some(refusal.cause.message()),
            ..LogPatch::default()
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv6_addresses_are_bracketed() {
        assert_eq!(socket_addr("::1", 4100), "[::1]:4100");
        assert_eq!(socket_addr("127.0.0.1", 4100), "127.0.0.1:4100");
        assert_eq!(socket_addr("[::1]", 4100), "[::1]:4100");
        assert_eq!(socket_addr(" 10.0.0.2 ", 4100), "10.0.0.2:4100");
    }

    #[test]
    fn upstream_url_keeps_prefix_and_swaps_suffix() {
        let base = "https://host/apps/anthropic/v1/messages";
        assert_eq!(
            upstream_url(base, "/v1/messages"),
            "https://host/apps/anthropic/v1/messages"
        );
        assert_eq!(
            upstream_url(base, "/v1/messages/count_tokens"),
            "https://host/apps/anthropic/v1/messages/count_tokens"
        );
        // 没归一化的地址也能用（防御：配置里存的是归一化值，但导入的旧数据可能不是）
        assert_eq!(
            upstream_url("https://host/apps/anthropic", "/v1/messages"),
            "https://host/apps/anthropic/v1/messages"
        );
    }

    #[test]
    fn upstream_identity_separates_paths_and_excludes_credentials_and_query() {
        let first = logged_upstream("https://proxy.example.com/team-a/v1/messages").unwrap();
        let second = logged_upstream("https://proxy.example.com/team-b/v1/messages").unwrap();
        let with_private_parts = logged_upstream(
            "https://demo:secret@proxy.example.com/team-a/v1/messages?token=demo#id",
        )
        .unwrap();
        assert_eq!(first.0, "https://proxy.example.com");
        assert_eq!(first, with_private_parts);
        assert_ne!(first.1, second.1);
    }

    #[test]
    fn encoded_responses_are_not_interpreted_as_plain_sse() {
        let mut headers = HeaderMap::new();
        assert!(identity_encoded(&headers));
        headers.insert(
            header::CONTENT_ENCODING,
            HeaderValue::from_static("Identity"),
        );
        assert!(identity_encoded(&headers));
        headers.append(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        assert!(!identity_encoded(&headers));
    }

    #[test]
    fn error_body_is_anthropic_shaped() {
        let resp = error_response(StatusCode::UNAUTHORIZED, "authentication_error", "nope");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let ct = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(ct.starts_with("application/json"));
    }

    #[test]
    fn ban_only_applies_to_non_loopback() {
        let ban = BanList::new(2, 1);
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        for _ in 0..10 {
            ban.record_fail(loopback);
        }
        assert!(!ban.is_banned(loopback), "回环永不封禁");

        let remote: IpAddr = "10.0.0.9".parse().unwrap();
        ban.record_fail(remote);
        assert!(!ban.is_banned(remote), "一次失败不封");
        ban.record_fail(remote);
        assert!(ban.is_banned(remote), "达到阈值应封禁");
        ban.record_success(remote);
        assert!(!ban.is_banned(remote), "成功一次应清零");
    }

    // ── 端到端：起真服务 + 假上游 ────────────────────────────────────────
    //
    // 纯函数测试守不住这一节：字节一致、SSE 直通、守卫顺序、日志回填都只有
    // 走一遍真实 HTTP 才算数。

    use crate::relay::config::{Provider, RelaySettings, Tier, TierKind};
    use crate::relay::log::RelayLog;
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;

    /// 假上游：把收到的 body 存下来，回一个固定 JSON。
    async fn spawn_upstream() -> (String, Arc<StdMutex<Vec<u8>>>, tokio::task::JoinHandle<()>) {
        let captured: Arc<StdMutex<Vec<u8>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink = captured.clone();
        let app = Router::new().route(
            "/v1/messages",
            post(move |body: Bytes| {
                let sink = sink.clone();
                async move {
                    *sink.lock().unwrap() = body.to_vec();
                    (
                        StatusCode::OK,
                        [(header::CONTENT_TYPE, "application/json")],
                        r#"{"id":"msg_1","type":"message","content":[{"type":"text","text":"ok"}]}"#,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (addr, captured, join)
    }

    fn test_settings(base_url: String) -> RelaySettings {
        RelaySettings {
            providers: vec![Provider {
                base_url,
                api_key: "sk-upstream".into(),
                tiers: vec![Tier {
                    tier: TierKind::Default,
                    upstream_model: "up-model".into(),
                }],
                ..Provider::default()
            }],
            overrides: vec![],
        }
    }

    async fn spawn_relay(settings: RelaySettings, log: Arc<RelayLog>) -> RunningServer {
        let shared = Arc::new(tokio::sync::RwLock::new(Arc::new(settings)));
        let token = Arc::new(tokio::sync::RwLock::new("rly_test".to_string()));
        start(shared, token, log, "127.0.0.1", 0, 5, 15)
            .await
            .expect("中转应能启动")
    }

    #[tokio::test(flavor = "current_thread")]
    async fn streamed_usage_is_recorded_without_changing_the_response() {
        const SSE: &str = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"actual-upstream\",\"usage\":{\"input_tokens\":2,\"cache_read_input_tokens\":80,\"output_tokens\":1}}}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let upstream = Router::new().route(
            "/v1/messages",
            post(|| async {
                (
                    [(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")],
                    SSE,
                )
            }),
        );
        let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let log = Arc::new(RelayLog::new(10, None));
        let relay = spawn_relay(
            test_settings(format!("http://{addr}/v1/messages")),
            log.clone(),
        )
        .await;
        let body = reqwest::Client::new()
            .post(format!("http://{}/v1/messages", relay.addr))
            .header("x-api-key", "rly_test")
            .json(&json!({"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"hi"}],"stream":true,"max_tokens":20}))
            .send().await.unwrap().text().await.unwrap();
        assert_eq!(body, SSE);
        let rows = log.recent(1);
        assert_eq!(rows[0].reported_model.as_deref(), Some("actual-upstream"));
        assert_eq!(
            rows[0].upstream_provider.as_deref(),
            Some(format!("http://{addr}").as_str())
        );
        let usage = rows[0].usage.as_ref().unwrap();
        assert_eq!(
            (usage.input, usage.cache_read, usage.output, usage.partial),
            (Some(2), Some(80), Some(7), false)
        );
        task.abort();
    }

    /// 折叠端到端：客户端发 `tool_addition`，上游必须收到**顶层 tools 里有那个工具**，
    /// 且响应带 `x-relay-sanitized`。只看 200 不算通过——那是「只剥离」方案也能过的线。
    #[tokio::test(flavor = "current_thread")]
    async fn fold_end_to_end_puts_tool_into_top_level_tools() {
        let (up_addr, captured, _up) = spawn_upstream().await;
        let log = Arc::new(RelayLog::new(100, None));
        let relay = spawn_relay(
            test_settings(format!("http://{up_addr}/v1/messages")),
            log.clone(),
        )
        .await;

        let body = serde_json::json!({
            "model": "claude-sonnet-5-5",
            "max_tokens": 64,
            "messages": [{
                "role": "system",
                "content": [
                    { "type": "text", "text": "工具在这" },
                    { "type": "tool_addition", "tool": {
                        "type": "tool_definition",
                        "definition": { "name": "web_search", "input_schema": { "type": "object" } }
                    }}
                ]
            }]
        })
        .to_string();

        let resp = reqwest::Client::new()
            .post(format!("http://{}/v1/messages", relay.addr))
            .header("x-api-key", "rly_test")
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .expect("请求应发出");

        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("x-relay-sanitized")
                .and_then(|v| v.to_str().ok()),
            Some("1"),
            "折叠过的请求必须带标记"
        );

        let received: serde_json::Value =
            serde_json::from_slice(&captured.lock().unwrap()).expect("上游应收到合法 JSON");
        // 工具定义进了顶层 tools —— 这是「折叠」而非「剥离」的证据
        assert_eq!(received["tools"][0]["name"], "web_search");
        assert_eq!(received["tools"][0]["input_schema"]["type"], "object");
        // model 换成上游真名
        assert_eq!(received["model"], "up-model");
        // 块被丢，文本保留，消息没被删
        assert_eq!(received["messages"].as_array().unwrap().len(), 1);
        assert_eq!(received["messages"][0]["content"][0]["text"], "工具在这");

        // 日志里能看出「折叠过」
        let row = log.recent(1).into_iter().next().expect("应有一条日志");
        assert!(row.sanitized);
        assert_eq!(row.rewrite.as_deref(), Some("fold"));
        assert_eq!(row.status, Some(200));
        assert_eq!(row.tier, "default");

        let _ = relay.stop().await;
    }

    /// 不含变更块的请求：上游收到的 body **除 model 外逐字节一致**。
    ///
    /// 这条同时守住两件事：`sanitize` 的 Unchanged 路径不改 body，以及
    /// `serde_json` 的 `preserve_order`（否则 key 会被重排成字母序，缓存全 miss）。
    #[tokio::test(flavor = "current_thread")]
    async fn plain_request_reaches_upstream_byte_identical_except_model() {
        let (up_addr, captured, _up) = spawn_upstream().await;
        let relay = spawn_relay(
            test_settings(format!("http://{up_addr}/v1/messages")),
            Arc::new(RelayLog::new(100, None)),
        )
        .await;

        // 刻意不按字母序写 key：如果序列化被重排，下面的断言会立刻失败。
        let original = r#"{"model":"claude-sonnet-5-5","max_tokens":16,"messages":[{"role":"user","content":"你好"}],"tools":[{"name":"Read","input_schema":{"type":"object"}}]}"#;

        let resp = reqwest::Client::new()
            .post(format!("http://{}/v1/messages", relay.addr))
            .header("x-api-key", "rly_test")
            .body(original)
            .send()
            .await
            .expect("请求应发出");
        assert_eq!(resp.status(), 200);
        assert!(
            resp.headers().get("x-relay-sanitized").is_none(),
            "没改动就不该带折叠标记"
        );

        let expected = original.replace("claude-sonnet-5-5", "up-model");
        let received = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
        assert_eq!(received, expected, "除 model 外必须逐字节一致");

        let _ = relay.stop().await;
    }

    /// 鉴权与守卫都要在**发上游之前**生效：上游一次都不该被打到。
    #[tokio::test(flavor = "current_thread")]
    async fn auth_and_guard_reject_before_reaching_upstream() {
        let (up_addr, captured, _up) = spawn_upstream().await;
        let relay = spawn_relay(
            test_settings(format!("http://{up_addr}/v1/messages")),
            Arc::new(RelayLog::new(100, None)),
        )
        .await;
        let client = reqwest::Client::new();
        let url = format!("http://{}/v1/messages", relay.addr);

        // 无凭据 → 401
        let resp = client
            .post(&url)
            .body(r#"{"model":"m","messages":[]}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
        assert_eq!(
            resp.headers()
                .get("x-relay-auth")
                .and_then(|v| v.to_str().ok()),
            Some("failed")
        );

        // 带 Origin → 403（浏览器）
        let resp = client
            .post(&url)
            .header("x-api-key", "rly_test")
            .header("origin", "https://evil.example")
            .body(r#"{"model":"m","messages":[]}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 403);

        assert!(
            captured.lock().unwrap().is_empty(),
            "被拒的请求不该打到上游"
        );

        let _ = relay.stop().await;
    }

    /// 上游的 400 原文要原样回到客户端（§4.3 第 3 条）。
    /// 上次那个难查的 400 就是因为被中间层包了一层。
    #[tokio::test(flavor = "current_thread")]
    async fn upstream_error_body_is_passed_through_verbatim() {
        let upstream = Router::new().route(
            "/v1/messages",
            post(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    [(header::CONTENT_TYPE, "application/json")],
                    r#"{"error":{"type":"invalid_request_error","message":"Request body format invalid"}}"#,
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let _ = axum::serve(listener, upstream).await;
        });

        let relay = spawn_relay(
            test_settings(format!("http://{up_addr}/v1/messages")),
            Arc::new(RelayLog::new(100, None)),
        )
        .await;

        let resp = reqwest::Client::new()
            .post(format!("http://{}/v1/messages", relay.addr))
            .header("x-api-key", "rly_test")
            .body(r#"{"model":"m","messages":[{"role":"wizard","content":"x"}]}"#)
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), 400);
        let text = resp.text().await.unwrap();
        assert!(text.contains("Request body format invalid"), "{text}");
        assert!(
            !text.contains("relay") && !text.contains("中转"),
            "不能把上游错误包成我们自己的话术：{text}"
        );

        let _ = relay.stop().await;
    }

    /// 只配 default 一档时，三种原生模型名都能跑通并落到同一个上游模型。
    #[tokio::test(flavor = "current_thread")]
    async fn single_tier_serves_all_native_model_names() {
        let (up_addr, captured, _up) = spawn_upstream().await;
        let log = Arc::new(RelayLog::new(100, None));
        let relay = spawn_relay(
            test_settings(format!("http://{up_addr}/v1/messages")),
            log.clone(),
        )
        .await;
        let client = reqwest::Client::new();

        for name in [
            "claude-3-5-haiku-20241022",
            "claude-sonnet-4-5-20250929",
            "claude-opus-4-1-20250805",
            "claude-sonnet-5-5",
        ] {
            let resp = client
                .post(format!("http://{}/v1/messages", relay.addr))
                .header("x-api-key", "rly_test")
                .json(&serde_json::json!({
                    "model": name,
                    "max_tokens": 8,
                    "messages": [{ "role": "user", "content": "hi" }]
                }))
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), 200, "{name} 应能跑通");
            let received: serde_json::Value =
                serde_json::from_slice(&captured.lock().unwrap()).unwrap();
            assert_eq!(
                received["model"], "up-model",
                "{name} 应落到 default 的上游模型"
            );
        }

        // 精确命中默认名为 alias：不能带回落标记
        let rows = log.recent(10);
        let alias_row = rows
            .iter()
            .find(|r| r.client_model == "claude-sonnet-5-5")
            .expect("应有默认名那条");
        assert!(!alias_row.fell_back, "默认名是精确命中，不该标回落");
        assert_eq!(alias_row.via, "alias");

        let _ = relay.stop().await;
    }

    /// 假上游（记录收到的路径）：两个端点都收，回固定 JSON。
    async fn spawn_upstream_capture_path(
    ) -> (String, Arc<StdMutex<String>>, tokio::task::JoinHandle<()>) {
        let seen: Arc<StdMutex<String>> = Arc::new(StdMutex::new(String::new()));
        // 两个 `move` 闭包各持一份克隆：`Arc` 不是 `Copy`，共用一个变量会被
        // 第一个闭包 move 掉。
        let sink_messages = seen.clone();
        let sink_count = seen.clone();
        let app = Router::new()
            .route(
                "/v1/messages",
                post(move |uri: axum::http::Uri| {
                    let sink = sink_messages.clone();
                    async move {
                        *sink.lock().unwrap() = uri.path().to_string();
                        (
                            StatusCode::OK,
                            [(header::CONTENT_TYPE, "application/json")],
                            r#"{"id":"msg_1","type":"message","content":[{"type":"text","text":"ok"}]}"#,
                        )
                    }
                }),
            )
            .route(
                "/v1/messages/count_tokens",
                post(move |uri: axum::http::Uri| {
                    let sink = sink_count.clone();
                    async move {
                        *sink.lock().unwrap() = uri.path().to_string();
                        (
                            StatusCode::OK,
                            [(header::CONTENT_TYPE, "application/json")],
                            r#"{"input_tokens":42}"#,
                        )
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (addr, seen, join)
    }

    /// 假上游（记录**最近一次**请求的请求头，每次请求整体覆盖，不跨请求累积）。
    /// 入站 token 头在 SKIP 列表里不透传，所以这里看到的只可能是中转补上的上游密钥。
    async fn spawn_upstream_capture_headers() -> (
        String,
        Arc<StdMutex<HashMap<String, String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let seen: Arc<StdMutex<HashMap<String, String>>> = Arc::new(StdMutex::new(HashMap::new()));
        let sink = seen.clone();
        let app = Router::new().route(
            "/v1/messages",
            post(move |headers: HeaderMap| {
                let sink = sink.clone();
                async move {
                    let snapshot: HashMap<String, String> = headers
                        .iter()
                        .map(|(name, value)| {
                            (
                                name.as_str().to_string(),
                                value.to_str().unwrap_or_default().to_string(),
                            )
                        })
                        .collect();
                    // 整体覆盖而不是 insert 累积：这个 helper 被同一个上游地址下的
                    // 多个用例（不同 auth_style）复用，累积会让第二次请求看到
                    // 第一次请求的头，从而把「Bearer 形态不该带 x-api-key」
                    // 误判成失败。
                    *sink.lock().unwrap() = snapshot;
                    (
                        StatusCode::OK,
                        [(header::CONTENT_TYPE, "application/json")],
                        r#"{"id":"msg_1","type":"message","content":[{"type":"text","text":"ok"}]}"#,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let join = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (addr, seen, join)
    }

    /// 回归：`/v1/messages/count_tokens` 必须按**自己的路径**转发。
    ///
    /// 曾经两个路由共用 handler、handler 里 `path` 写死 `/v1/messages`：
    /// count_tokens 请求被当成普通补全转发——每次上下文探测都变成一次真实
    /// 计费的请求，客户端还拿不到 `input_tokens`。日志里的 `path` 也必须是真的。
    #[tokio::test(flavor = "current_thread")]
    async fn count_tokens_is_forwarded_under_its_own_path() {
        let (up_addr, seen_path, _up) = spawn_upstream_capture_path().await;
        let log = Arc::new(RelayLog::new(100, None));
        let relay = spawn_relay(
            test_settings(format!("http://{up_addr}/v1/messages")),
            log.clone(),
        )
        .await;

        let resp = reqwest::Client::new()
            .post(format!("http://{}/v1/messages/count_tokens", relay.addr))
            .header("x-api-key", "rly_test")
            .body(r#"{"model":"claude-sonnet-5-5","messages":[]}"#)
            .send()
            .await
            .expect("请求应发出");
        assert_eq!(resp.status(), 200);
        assert_eq!(
            *seen_path.lock().unwrap(),
            "/v1/messages/count_tokens",
            "上游必须收到 count_tokens 路径"
        );
        let row = log.recent(1).into_iter().next().expect("应有一条日志");
        assert_eq!(row.path, "/v1/messages/count_tokens", "日志必须记真实路径");

        let _ = relay.stop().await;
    }

    /// 回归：上游的重复响应头（多个 `Set-Cookie`）必须**全部**透传。
    /// `HeaderMap::insert` 是覆盖语义，曾经只活最后一个。
    #[tokio::test(flavor = "current_thread")]
    async fn duplicate_response_headers_all_survive() {
        let upstream = Router::new().route(
            "/v1/messages",
            post(|| async {
                let mut headers = HeaderMap::new();
                headers.insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                );
                headers.append(header::SET_COOKIE, HeaderValue::from_static("a=1"));
                headers.append(header::SET_COOKIE, HeaderValue::from_static("b=2"));
                (StatusCode::OK, headers, r#"{"ok":true}"#)
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let _ = axum::serve(listener, upstream).await;
        });

        let relay = spawn_relay(
            test_settings(format!("http://{up_addr}/v1/messages")),
            Arc::new(RelayLog::new(100, None)),
        )
        .await;
        let resp = reqwest::Client::new()
            .post(format!("http://{}/v1/messages", relay.addr))
            .header("x-api-key", "rly_test")
            .body(r#"{"model":"m","messages":[]}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let cookies: Vec<String> = resp
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect();
        assert_eq!(
            cookies,
            vec!["a=1".to_string(), "b=2".to_string()],
            "两个 Set-Cookie 都必须活下来"
        );

        let _ = relay.stop().await;
    }

    /// 上游密钥按 `auth_style` 只发**一种**。两种都带不会有「双保险」：
    /// 只认 Authorization 的网关会把多出来的 x-api-key 连同请求一起拒，
    /// 只认 x-api-key 的则把 Bearer 当陌生头。切换路径是 probe 的
    /// `switched_auth` 提示，不是同时发两个头。
    #[tokio::test(flavor = "current_thread")]
    async fn upstream_auth_header_follows_configured_style() {
        let (up_addr, seen, _up) = spawn_upstream_capture_headers().await;

        // 默认形态 XApiKey：有 x-api-key，没有 authorization
        let relay = spawn_relay(
            test_settings(format!("http://{up_addr}/v1/messages")),
            Arc::new(RelayLog::new(100, None)),
        )
        .await;
        let url = format!("http://{}/v1/messages", relay.addr);
        let resp = reqwest::Client::new()
            .post(url)
            .header("x-api-key", "rly_test")
            .body(r#"{"model":"m","messages":[]}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        {
            let h = seen.lock().unwrap();
            assert_eq!(h.get("x-api-key").map(String::as_str), Some("sk-upstream"));
            assert!(
                h.get("authorization").is_none(),
                "XApiKey 形态不该带 Authorization：{h:?}"
            );
        }
        let _ = relay.stop().await;

        // Bearer 形态：只有 authorization
        let mut settings = test_settings(format!("http://{up_addr}/v1/messages"));
        settings.providers[0].auth_style = crate::relay::config::AuthStyle::Bearer;
        let relay = spawn_relay(settings, Arc::new(RelayLog::new(100, None))).await;
        let url = format!("http://{}/v1/messages", relay.addr);
        let resp = reqwest::Client::new()
            .post(url)
            .header("x-api-key", "rly_test")
            .body(r#"{"model":"m","messages":[]}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        {
            let h = seen.lock().unwrap();
            assert_eq!(
                h.get("authorization").map(String::as_str),
                Some("Bearer sk-upstream")
            );
            assert!(
                h.get("x-api-key").is_none(),
                "Bearer 形态不该带 x-api-key：{h:?}"
            );
        }
        let _ = relay.stop().await;
    }
}
