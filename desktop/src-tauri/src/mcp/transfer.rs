//! 文件直传：一次性票据 + `PUT/GET /transfer/{ticket}` 流式传输入口。
//!
//! WHY：AI 端（Linux）与桥端（Windows）之间传文件的唯一原路是
//! `write_files(base64)` / `read_files`，**每个字节都要过模型上下文**——一个 169KB
//! 的 pptx 单向传一次十几万 token。这里让字节走 MCP 之外的 HTTP 通道，MCP 只负责
//! 「发票据 + 回报校验结果」。方案原文见 `docs/token_saving_tools_rfc.md` 一~十二节。
//!
//! 三层结构：
//! - [`TicketStore`]：内存票据表（进程重启即失效，不落盘）。
//! - [`routes`]：只声明路由，鉴权/限流由 `http.rs::build_router` 统一挂载。
//! - [`transfer_handler`]：票据校验 + 流式收发 + 备份/原子改名 + 审计。
//!
//! 🔴 三条不可动摇的判据：
//! 1. **票据一次性**：`take()` 先摘除再处理，同一票据并发两个 PUT 只有一个成功。
//!    票据值会随工具返回值进对话、也会进审计日志（AI 自己能 `read_files` 读日志），
//!    所以「短时效 + 一次性 + 绑单路径单方法」是唯一防线，不能放宽。
//! 2. **`/transfer` 不挂 `/mcp` 那一组层**（`RequestBodyLimit` / gzip / 413 改写）。
//!    理由不是「整包缓冲」——`RequestBodyLimitLayer` 本身是**流式**上限（内部就是
//!    `http_body_util::Limited` 包一层，不缓存整包）。真正的原因是：
//!    ① 它给的 413 是 `text/plain "length limit exceeded"`，而这里的调用方是 curl、
//!    拿不到结构化错误；② `CompressionLayer` 一旦压缩响应就会**删掉 `Content-Length`**，
//!    而下载侧的 `Content-Length` + `X-Content-SHA256` 正是我们承诺给调用方的校验值；
//!    ③ 那个上限是 `6 × max_file_size`（且不低于 1MB），对「单文件 ≤ max_file_size」
//!    的上传永远不会触发，纯属多余。上传侧自己按 `max_file_size_bytes` 流式截断。
//! 3. **临时文件必须落在目标同目录**：跨盘 rename 不是原子操作（Windows 直接失败），
//!    而「同目录临时文件 + rename」是覆盖写的原子性来源（同 `edit_files::write_atomic`）。

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path as UrlPath, State};
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use futures_util::StreamExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::state::AppState;

/// 同时有效的票据上限。票据表是纯内存结构，被刷爆等于服务不可用；
/// 正常使用（AI 一次传一个文件）远远到不了 64。
pub const MAX_TICKETS: usize = 64;
/// 默认有效期：够 AI 生成文件 + 起 curl，又短到泄露后基本没用。
pub const DEFAULT_TTL_SECS: u64 = 300;
/// 有效期上限，防止调用方要一个「一天有效的上传口」。
pub const MAX_TTL_SECS: u64 = 1800;

/// 流式读写块大小。64KB 是 tokio 协作调度与 syscall 次数的折中。
const CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketKind {
    Upload,
    Download,
}

impl TicketKind {
    fn method(self) -> &'static str {
        match self {
            TicketKind::Upload => "PUT",
            TicketKind::Download => "GET",
        }
    }
}

/// 票据取用失败的原因。**内部判别**，不是给人看的分类器：响应文案对「不存在」与
/// 「已用过」故意用同一句，猜票据的人得不到「猜中了」的信号。
///
/// 🔴 但封禁记账必须区分，否则会把合法调用方锁死：票据有效期默认 5 分钟，AI 想久一点
/// 再来 curl 就会拿到「过期」，那是**正常运维事件**，不是攻击。旧实现一律按鉴权失败
/// 记账 → 同一 IP 攒够 5 次（默认阈值）就被封 15 分钟，而 `/transfer` 被封意味着桥端
/// 自己不可用，且用户完全看不出原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketReject {
    /// 表里没有这张票：随机的，或已经用掉了。**这才是攻击特征**。
    NotFound,
    /// 票是真的，但过期了。正常运维事件。
    Expired,
    /// 票是真的，但 HTTP 方法不对。
    WrongMethod(&'static str),
}

impl TicketReject {
    fn message(self) -> String {
        match self {
            TicketReject::NotFound => "票据无效或已使用，请重新调用工具申请".to_string(),
            TicketReject::Expired => "票据已过期，请重新调用工具申请".to_string(),
            TicketReject::WrongMethod(m) => format!("票据与请求方法不匹配：该票据只接受 {m}"),
        }
    }

    /// 是否计入封禁失败次数。只有「票根本不存在」才算：猜不到真票据的调用方
    /// 永远落在这一档，而拿到过真票据的调用方永远落在另外两档。
    fn counts_as_auth_failure(self) -> bool {
        matches!(self, TicketReject::NotFound)
    }
}

#[derive(Debug)]
pub struct Ticket {
    pub kind: TicketKind,
    /// 发票据时**已校验过**的绝对路径（白名单 + 扩展名都过了）。处理时仍会重校验一次。
    pub path: PathBuf,
    pub expected_size: Option<u64>,
    pub expected_sha256: Option<String>,
    pub overwrite: bool,
    pub expires_at: Instant,
}

/// 内存票据表。
///
/// 用 `StdMutex<HashMap>` 而不是 DashMap：临界区只有几次 map 操作、不跨 await，
/// 且「检查上限 + 清理过期 + 插入」必须在同一把锁里完成（分开会超发）。
#[derive(Default)]
pub struct TicketStore {
    inner: StdMutex<HashMap<String, Ticket>>,
}

impl TicketStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 发票据。返回 `(票据 id, 到期时刻)`。
    pub fn issue(
        &self,
        kind: TicketKind,
        path: PathBuf,
        expected_size: Option<u64>,
        expected_sha256: Option<String>,
        overwrite: bool,
        ttl: Duration,
    ) -> Result<(String, Instant), String> {
        let now = Instant::now();
        let expires_at = now + ttl;
        let id = random_ticket_id(kind);
        let mut map = self.lock();
        // 顺手清过期条目：不需要独立定时任务，签发频率天然高于过期频率。
        map.retain(|_, t| t.expires_at > now);
        if map.len() >= MAX_TICKETS {
            return Err(format!(
                "同时有效的传输票据已达上限（{MAX_TICKETS}），请等已有票据过期或稍后重试"
            ));
        }
        map.insert(
            id.clone(),
            Ticket {
                kind,
                path,
                expected_size,
                expected_sha256,
                overwrite,
                expires_at,
            },
        );
        Ok((id, expires_at))
    }

    /// 取走票据（**一次性**：无论后续处理成败，票据都不再可用）。
    ///
    /// 先摘除再判过期/种类，是刻意的：「不存在」与「刚被用过」在响应里是同一句话，
    /// 不给暴力猜票据的调用方一个判别器。代价是拿错方法会烧掉票据——同一调用方自己
    /// 重发一次即可，不构成实际损失。
    pub fn take(&self, id: &str, kind: TicketKind) -> Result<Ticket, TicketReject> {
        let now = Instant::now();
        let ticket = {
            let mut map = self.lock();
            map.remove(id)
        };
        let Some(ticket) = ticket else {
            return Err(TicketReject::NotFound);
        };
        if ticket.expires_at <= now {
            return Err(TicketReject::Expired);
        }
        if ticket.kind != kind {
            return Err(TicketReject::WrongMethod(ticket.kind.method()));
        }
        Ok(ticket)
    }

    /// 当前有效票据数（测试与诊断用）。
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 锁中毒后继续用内部数据：票据表里没有跨调用不变量，panic 期间被中断的
    /// 至多是一条 insert/remove，继续服务比整站 500 好。
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Ticket>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 32 字节 CSPRNG 随机数 → base64url（无填充）。前缀只是给人看/看日志时区分类型。
fn random_ticket_id(kind: TicketKind) -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let prefix = match kind {
        TicketKind::Upload => "u_",
        TicketKind::Download => "d_",
    };
    format!(
        "{prefix}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
    )
}

// ── 本次请求的对外基地址（供工具拼 URL） ─────────────────────────────────────
//
// 工具 handler 拿不到 HTTP 请求，只能靠 task_local 把 `mcp_handler` 里读到的
// Host 头带下去。`prepare_*` 是纯 async、不经 `spawn_blocking`，作用域不会丢。
tokio::task_local! {
    static BASE_URL: String;
}

/// 进入一次工具调用的基地址作用域。
pub async fn with_base_url<F>(base: String, fut: F) -> F::Output
where
    F: std::future::Future,
{
    BASE_URL.scope(base, fut).await
}

/// 读取当前请求的基地址（形如 `https://192.168.1.5:7823`）。不在作用域内返回 `None`。
pub fn current_base_url() -> Option<String> {
    BASE_URL.try_with(|b| b.clone()).ok()
}

/// 由本次请求的 `Host` 头 + 配置推导对外基地址。
///
/// Host 是**调用方自己写进请求的**，理论上可伪造；但这里只用来给调用方自己拼 curl
/// 命令，伪造只会让它自己拿到一个连不通的 URL，不构成越权。仍做字符白名单校验：
/// 这个值会被拼进单引号包裹的 shell 示例，不能让 `'` 之类的字符逃逸出去。
pub async fn base_url(headers: &HeaderMap, state: &Arc<AppState>) -> String {
    let (tls, host, port) = {
        let config = state.config.read().await;
        (config.remote_tls_enabled, config.host.clone(), config.port)
    };
    let scheme = if tls { "https" } else { "http" };
    let authority = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .filter(|h| is_safe_authority(h))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            // 没有 Host（HTTP/1.0 或测试直调）：绑 0.0.0.0 时回退到第一张网卡的 IPv4，
            // 否则 0.0.0.0 对 AI 端不可连。
            let h = if host.is_empty() || host == "0.0.0.0" {
                state
                    .lan_ips
                    .lock()
                    .map(|g| g.first().cloned())
                    .unwrap_or(None)
                    .unwrap_or_else(|| "127.0.0.1".to_string())
            } else {
                host
            };
            format!("{h}:{port}")
        });
    format!("{scheme}://{authority}")
}

/// `host:port` / `[v6]:port` 的字符白名单。刻意不收 `'`、`"`、`/`、`@`、空格。
fn is_safe_authority(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 255
        && h.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']' | b'_')
        })
}

// ── 路由 ────────────────────────────────────────────────────────────────────

/// 只声明路由；鉴权（跳过 Bearer、仍走限流与封禁）与并发限制由
/// `http.rs::build_router` 统一挂载——放这里会和别的路由各挂一套，早晚漂移。
pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/transfer/{ticket}", any(transfer_handler))
}

async fn transfer_handler(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    UrlPath(ticket_id): UrlPath<String>,
    req: Request<Body>,
) -> Response {
    match *req.method() {
        Method::PUT => upload(state, addr.ip(), &ticket_id, req).await,
        Method::GET => download(state, addr.ip(), &ticket_id).await,
        _ => (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, "PUT, GET")],
            Json(json!({ "ok": false, "error": "该端点只支持 PUT（上传）与 GET（下载）" })),
        )
            .into_response(),
    }
}

/// 票据校验失败的统一出口：计入鉴权拒绝指标，并按原因决定是否累计封禁失败次数
/// （口径见 [`TicketReject::counts_as_auth_failure`]）。
async fn deny_ticket(state: &Arc<AppState>, peer: IpAddr, reject: TicketReject) -> Response {
    state.inc_auth_denies();
    if reject.counts_as_auth_failure() {
        let ban_active = {
            let config = state.config.read().await;
            crate::mcp::http::is_ban_active(&config)
        };
        if ban_active {
            state.ban.record_failure(peer);
        }
    }
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "ok": false, "error": reject.message() })),
    )
        .into_response()
}

/// 票据有效 = 调用方手上有一次合法的 MCP 会话，清掉该 IP 累积的鉴权失败计数。
///
/// 🔴 `auth_middleware` 对 `/transfer` 走的是 `skip_token` 分支，**不会**替我们调
/// `record_success`。漏掉这一步有两个后果：治理页的「令牌失效」提示会一直亮着
/// （它靠「窗口内还有失败记录」判断问题是否解决），失败计数也永远不清零。
fn note_authorized(state: &Arc<AppState>, peer: IpAddr) {
    state.ban.record_success(peer);
}

fn json_err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "ok": false, "error": msg.into() }))).into_response()
}

// ── 上传 ────────────────────────────────────────────────────────────────────

/// 一次上传所需的配置快照（避免处理中途反复读锁）。
struct UploadConfig {
    max_bytes: u64,
    backup_enabled: bool,
    backup_dir: String,
    backup_retention: u32,
    allowed_extensions: Vec<String>,
    exclude_patterns: Vec<String>,
    whitelist_enabled: bool,
}

async fn snapshot(state: &Arc<AppState>) -> UploadConfig {
    let config = state.config.read().await;
    UploadConfig {
        max_bytes: config.max_file_size_bytes,
        backup_enabled: config.backup_enabled,
        backup_dir: config.backup_dir.clone(),
        backup_retention: config.backup_retention,
        allowed_extensions: config.allowed_extensions.clone(),
        exclude_patterns: config.exclude_patterns.clone(),
        whitelist_enabled: config.whitelist_enabled,
    }
}

async fn upload(
    state: Arc<AppState>,
    peer: IpAddr,
    ticket_id: &str,
    req: Request<Body>,
) -> Response {
    let started = Instant::now();
    let ticket = match state.transfer_tickets.take(ticket_id, TicketKind::Upload) {
        Ok(t) => t,
        Err(e) => return deny_ticket(&state, peer, e).await,
    };
    note_authorized(&state, peer);
    let cfg = snapshot(&state).await;

    // 票据有效期最长 30 分钟，期间白名单/扩展名/只读可能被用户收紧。签发票据时校验过的
    // 事不等于此刻仍成立 —— 重校验一次，代价是一次 canonicalize。
    let resolved = match revalidate(&state, &cfg, &ticket.path, true).await {
        Ok(p) => p,
        Err(e) => return json_err(StatusCode::FORBIDDEN, e),
    };

    if !ticket.overwrite && resolved.exists() {
        return json_err(
            StatusCode::CONFLICT,
            format!("目标文件已存在（overwrite=false）：{}", resolved.display()),
        );
    }

    // Content-Length 只用来提前拒绝，不作为判据 —— 真正的大小以流式累计为准。
    if let Some(declared) = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    {
        if declared > cfg.max_bytes {
            return json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                format!(
                    "请求声明的 {} 字节超过上限 {} 字节",
                    declared, cfg.max_bytes
                ),
            );
        }
    }

    if let Err(e) = ensure_parent(&resolved).await {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    let tmp = temp_path(&resolved, ticket_id);

    let outcome = stream_into(
        req.into_body(),
        &tmp,
        cfg.max_bytes,
        ticket.expected_size,
        ticket.expected_sha256.as_deref(),
    )
    .await;

    let (bytes, sha256) = match outcome {
        Ok(v) => v,
        Err((status, msg, partial)) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            write_audit(
                &state,
                &resolved,
                None,
                false,
                Some(msg.clone()),
                peer,
                started,
                UploadStats {
                    // 记**实际已收字节**而不是 0：排查「传了一半断了」时，
                    // 「0 字节」和「3.2MB 后中断」是完全不同的两个结论。
                    bytes: partial,
                    sha256: "",
                },
            )
            .await;
            return json_err(status, msg);
        }
    };

    // 与 write_files 共用同一把路径锁：并发工具写同一文件时串行化备份 + 改名。
    let lock = state
        .path_locks
        .entry(resolved.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .value()
        .clone();
    let _guard = lock.lock().await;

    // 🔴 `overwrite=false` 必须在锁内**再判一次**：上面那次检查发生在流式落盘之前，
    // 而落盘耗时与文件大小成正比（几十 MB 就是几百毫秒的窗口），期间别的工具或另一个
    // 上传完全可能把目标建出来。这个开关是调用方用来「保证不覆盖已有文件」的，
    // 落在窗口里静默覆盖掉，等于把它的安全承诺作废。
    if !ticket.overwrite && resolved.exists() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return json_err(
            StatusCode::CONFLICT,
            format!(
                "目标文件在上传过程中出现（overwrite=false），已放弃本次写入：{}",
                resolved.display()
            ),
        );
    }

    // 备份：必须在改名前，否则旧版本已被覆盖。
    let backup_path = if resolved.exists() && cfg.backup_enabled {
        let db = state.db.lock().await;
        let bp = crate::backup::backup_before_overwrite(
            &resolved,
            &cfg.backup_dir,
            &state.data_dir,
            &db,
        )
        .and_then(|opt| {
            crate::backup::prune_backups(
                &resolved,
                &cfg.backup_dir,
                &state.data_dir,
                cfg.backup_retention,
                &db,
            )?;
            Ok(opt)
        });
        drop(db);
        match bp {
            Ok(opt) => opt,
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                write_audit(
                    &state,
                    &resolved,
                    None,
                    false,
                    Some(format!("备份失败：{e}")),
                    peer,
                    started,
                    UploadStats {
                        bytes,
                        sha256: &sha256,
                    },
                )
                .await;
                return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("备份失败：{e}"));
            }
        }
    } else {
        None
    };

    let t0 = Instant::now();
    let renamed = tokio::fs::rename(&tmp, &resolved).await;
    crate::timing::record_io(t0.elapsed());
    if let Err(e) = renamed {
        let _ = tokio::fs::remove_file(&tmp).await;
        write_audit(
            &state,
            &resolved,
            backup_path.clone(),
            false,
            Some(format!("改名失败：{e}")),
            peer,
            started,
            UploadStats {
                bytes,
                sha256: &sha256,
            },
        )
        .await;
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("落盘失败（临时文件已清理）：{e}"),
        );
    }

    write_audit(
        &state,
        &resolved,
        backup_path.clone(),
        true,
        None,
        peer,
        started,
        UploadStats {
            bytes,
            sha256: &sha256,
        },
    )
    .await;

    Json(json!({
        "ok": true,
        "path": resolved.to_string_lossy(),
        "bytes": bytes,
        "sha256": sha256,
        "backup": backup_path.map(|p| p.to_string_lossy().into_owned()),
    }))
    .into_response()
}

/// 处理前重校验：白名单 + 扩展名（+ 上传侧额外的只读判定）。
/// 返回**重新解析后**的路径（可能是 canonicalize 的结果）。
///
/// 🔴 `require_writable` 必须按方向区分：只读模式拦的是**写**，下载是读操作，
/// 拿这一条去挡 GET 会让「只读模式下取个文件」变成 403——票据都签出来了却取不走。
async fn revalidate(
    state: &Arc<AppState>,
    cfg: &UploadConfig,
    path: &Path,
    require_writable: bool,
) -> Result<PathBuf, String> {
    if require_writable {
        let readonly = state.config.read().await.readonly_mode;
        if readonly {
            return Err("只读模式已开启，已拒绝文件传输写入".to_string());
        }
    }
    let raw = path.to_string_lossy();
    let resolved = crate::security::path::resolve_safe_path_cached(
        &raw,
        &state.cached_roots(),
        &cfg.exclude_patterns,
        cfg.whitelist_enabled,
    )?;
    crate::security::extension::assert_extension_allowed(&resolved, &cfg.allowed_extensions)?;
    Ok(resolved)
}

async fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建父目录失败：{e}"))?;
    }
    Ok(())
}

/// 同目录临时文件。票据 id 已是 base64url（`[A-Za-z0-9_-]`），可直接进文件名。
fn temp_path(target: &Path, ticket_id: &str) -> PathBuf {
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("ccbridge");
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    dir.join(format!(".{name}.ccbridge-upload-{ticket_id}.part"))
}

/// 流式落盘：边写边算 sha256、边累计字节数，超限立即中止。
///
/// 返回 `(字节数, sha256 hex)`；失败时返回 `(状态码, 文案, 已收字节数)`——最后一个
/// 值是给审计用的，调用方还要负责删临时文件。
async fn stream_into(
    body: Body,
    tmp: &Path,
    max_bytes: u64,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
) -> Result<(u64, String), (StatusCode, String, u64)> {
    let mut file = tokio::fs::File::create(tmp).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("创建临时文件失败：{e}"),
            0,
        )
    })?;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut stream = body.into_data_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                format!("读取请求体失败：{e}"),
                total,
            )
        })?;
        total += chunk.len() as u64;
        if total > max_bytes {
            drop(file);
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("上传内容超过上限 {max_bytes} 字节，已中止并丢弃"),
                total,
            ));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("写临时文件失败：{e}"),
                total,
            )
        })?;
    }
    file.flush().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("刷盘失败：{e}"),
            total,
        )
    })?;
    // 🔴 Windows 上必须先把句柄 drop 掉，否则紧随其后的 rename 会报「另一个程序正在使用此文件」。
    drop(file);

    let sha256 = to_hex(&hasher.finalize());

    if let Some(expected) = expected_size {
        if expected != total {
            return Err((
                StatusCode::CONFLICT,
                format!("字节数不符：期望 {expected}，实际 {total}。未写入目标文件。"),
                total,
            ));
        }
    }
    if let Some(expected) = expected_sha256 {
        if !expected.eq_ignore_ascii_case(&sha256) {
            return Err((
                StatusCode::CONFLICT,
                format!("sha256 不符：期望 {expected}，实际 {sha256}。未写入目标文件。"),
                total,
            ));
        }
    }
    Ok((total, sha256))
}

/// 内存数据的 sha256（hex）。仅测试用：生产路径要么增量哈希（流式落盘），要么直接读盘。
#[cfg(test)]
pub(crate) fn sha256_of(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

// ── 下载 ────────────────────────────────────────────────────────────────────

async fn download(state: Arc<AppState>, peer: IpAddr, ticket_id: &str) -> Response {
    let started = Instant::now();
    let ticket = match state.transfer_tickets.take(ticket_id, TicketKind::Download) {
        Ok(t) => t,
        Err(e) => return deny_ticket(&state, peer, e).await,
    };
    note_authorized(&state, peer);
    let cfg = snapshot(&state).await;
    // 下载是读操作，不套只读模式判定（见 revalidate 的注释）。
    let resolved = match revalidate(&state, &cfg, &ticket.path, false).await {
        Ok(p) => p,
        Err(e) => return json_err(StatusCode::FORBIDDEN, e),
    };

    let meta = match tokio::fs::metadata(&resolved).await {
        Ok(m) if m.is_file() => m,
        Ok(_) => return json_err(StatusCode::BAD_REQUEST, "目标不是普通文件"),
        Err(e) => return json_err(StatusCode::NOT_FOUND, format!("读取文件失败：{e}")),
    };
    if meta.len() > cfg.max_bytes {
        return json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "文件 {} 字节超过上限 {} 字节，无法直传。请上调设置里的「最大文件大小」后重试",
                meta.len(),
                cfg.max_bytes
            ),
        );
    }

    // 🔴 哈希与发送必须共用**同一个** `File` 句柄。
    //
    // 此前是「阻塞线程里 hash 一遍，再重新 open 一遍去发」。文件在两次 open 之间被改写
    // （用户存了盘、别的工具写了它）时，`Content-Length` 与实际发出字节数就不一致：
    // 多了被 hyper 截断、少了客户端一直等不到结束——两种都表现为「传输卡死」。
    // 现在在同一句柄上 hash → seek(0) → 发送，中途改写也只会让两边同时变化。
    let hash_path = resolved.clone();
    let max_bytes = cfg.max_bytes;
    let hashed = tokio::task::spawn_blocking(move || hash_and_rewind(&hash_path, max_bytes)).await;
    let (bytes, sha256, std_file) = match hashed {
        Ok(Ok(v)) => v,
        Ok(Err((status, msg))) => return json_err(status, msg),
        Err(e) => {
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("哈希计算任务失败：{e}"),
            )
        }
    };

    // 审计**必须等发送结束再写**。原先在起发之前就记 `ok: true`，等于把「已经决定发」
    // 当成「已经发到」，客户端中途断开也记成功 —— 审计日志正是用来事后判断「这个文件到底
    // 有没有出去」的，早写一步就失去了这个能力。
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    {
        let audit_state = state.clone();
        let audit_path = resolved.clone();
        let audit_sha = sha256.clone();
        let declared = bytes;
        let std_file = tokio::fs::File::from_std(std_file);
        tokio::spawn(async move {
            let out = pump_file(std_file, declared, tx).await;
            let (ok, err) = if out.complete {
                (true, None)
            } else {
                (
                    false,
                    Some(out.error.unwrap_or_else(|| {
                        format!(
                            "传输中断：已发送 {}/{} 字节（客户端断开，或文件在发送期间被截短）",
                            out.sent, declared
                        )
                    })),
                )
            };
            write_audit(
                &audit_state,
                &audit_path,
                None,
                ok,
                err,
                peer,
                started,
                UploadStats {
                    bytes: out.sent,
                    sha256: &audit_sha,
                },
            )
            .await;
        });
    }

    let filename = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));
    let mut resp = Response::new(body);
    let headers = resp.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CONTENT_LENGTH, header::HeaderValue::from(bytes));
    if let Ok(v) = header::HeaderValue::from_str(&sha256) {
        headers.insert("x-content-sha256", v);
    }
    // 仅提示用途；真正的落盘名由 curl -o 决定。非 ASCII 文件名会让 HeaderValue 失败，
    // 失败就静默不带（不影响传输本身）。
    if let Ok(v) = header::HeaderValue::from_str(&percent_encode(filename)) {
        headers.insert("x-file-name", v);
    }
    resp
}

/// 把文件**按 `bytes` 字节精确**泵进 channel，结束就退出。
///
/// 🔴 必须按 `bytes` 截断，不能 `loop` 到 EOF。`bytes` 是刚在**同一个句柄**上哈希出的
/// 长度，也已经写进了 `Content-Length`；文件在哈希之后**变长**（别的进程追加/覆盖）时，
/// 读到 EOF 就会比声明的多，而 hyper 对「声明 N、实发 >N」的处理是终止连接、丢掉响应——
/// 客户端看到的只有「卡死 / 被截断」，服务端日志里只有一句含糊的连接错误。
/// 变短这一半无法补救（少发照样是 content-length 不符），但「多发」这一半必须堵死。
/// 一次下载发送的结果。审计要靠它判断「到底发完没有」。
struct PumpOutcome {
    /// 实际从文件读出并交给 hyper 的字节数（客户端提前断开时小于声明值）。
    sent: u64,
    /// 是否把声明的全部字节都发出去了。
    complete: bool,
    /// 读盘错误的原文（若有）。
    error: Option<String>,
}

async fn pump_file(
    mut file: tokio::fs::File,
    bytes: u64,
    tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
) -> PumpOutcome {
    let mut buf = vec![0u8; CHUNK];
    let mut remaining = bytes;
    let mut sent: u64 = 0;
    while remaining > 0 {
        let want = (buf.len() as u64).min(remaining) as usize;
        match file.read(&mut buf[..want]).await {
            // 文件被截短：只能就此收手，剩下的字节已经不存在了。
            Ok(0) => {
                return PumpOutcome {
                    sent,
                    complete: false,
                    error: None,
                }
            }
            Ok(n) => {
                remaining -= n as u64;
                sent += n as u64;
                if tx
                    .send(Ok(Bytes::copy_from_slice(&buf[..n])))
                    .await
                    .is_err()
                {
                    // 客户端提前断开：停手，别继续读磁盘。
                    return PumpOutcome {
                        sent,
                        complete: false,
                        error: None,
                    };
                }
            }
            Err(e) => {
                let msg = e.to_string();
                let _ = tx
                    .send(Err(std::io::Error::new(e.kind(), msg.clone())))
                    .await;
                return PumpOutcome {
                    sent,
                    complete: false,
                    error: Some(msg),
                };
            }
        }
    }
    PumpOutcome {
        sent,
        complete: true,
        error: None,
    }
}

/// 百分号编码成纯 ASCII，供响应头携带（文件名可能含中文）。
fn percent_encode(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'~') {
            out.push(*b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// 阻塞式流式哈希（在 `spawn_blocking` 里跑）。
pub(crate) fn sha256_file(path: &Path, max_bytes: u64) -> Result<(u64, String), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("打开文件失败：{e}"))?;
    hash_reader(&mut file, max_bytes)
}

/// 同 [`sha256_file`]，但把**同一个句柄的游标退回开头**再交出去，供下载侧直接接着发。
///
/// 下载必须走这个而不是「hash 完再 open 一遍」——两次 open 之间文件被改写会让
/// `Content-Length` 与实际发送字节数不符（见 `download` 的注释）。
fn hash_and_rewind(
    path: &Path,
    max_bytes: u64,
) -> Result<(u64, String, std::fs::File), (StatusCode, String)> {
    use std::io::{Seek, SeekFrom};
    let mut file = std::fs::File::open(path)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("打开文件失败：{e}")))?;
    let (len, hex) = hash_reader(&mut file, max_bytes).map_err(|e| {
        let status = if e.contains("超过上限") {
            StatusCode::PAYLOAD_TOO_LARGE
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        (status, e)
    })?;
    file.seek(SeekFrom::Start(0)).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("回绕游标失败：{e}"),
        )
    })?;
    Ok((len, hex, file))
}

/// 从一个 `Read` 里流式算 sha256，超过 `max_bytes` 立即报错。
fn hash_reader(r: &mut impl std::io::Read, max_bytes: u64) -> Result<(u64, String), String> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut total: u64 = 0;
    loop {
        let n = r.read(&mut buf).map_err(|e| format!("读取失败：{e}"))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > max_bytes {
            return Err(format!("文件超过上限 {max_bytes} 字节"));
        }
        hasher.update(&buf[..n]);
    }
    Ok((total, to_hex(&hasher.finalize())))
}

// ── 审计 ────────────────────────────────────────────────────────────────────

struct UploadStats<'a> {
    bytes: u64,
    sha256: &'a str,
}

/// 写一条传输审计。
///
/// 🔴 审计里**不出现完整票据值**：只落 `via: "transfer"`。票据会被塞进 `params` 的话，
/// 审计日志本身就成了一张可用的票据库（AI 能 `read_files` 读日志）。
#[allow(clippy::too_many_arguments)]
async fn write_audit(
    state: &Arc<AppState>,
    path: &Path,
    backup: Option<PathBuf>,
    ok: bool,
    error: Option<String>,
    peer: IpAddr,
    started: Instant,
    stats: UploadStats<'_>,
) {
    if !state.config.read().await.audit_enabled {
        return;
    }
    let duration_ms = started.elapsed().as_millis() as u64;
    let params = json!({
        "path": path.to_string_lossy(),
        "bytes": stats.bytes,
        "sha256": stats.sha256,
        "via": "transfer",
    });
    let mut entry = crate::audit::new_entry(
        "transfer",
        &params.to_string(),
        ok,
        error,
        Some(peer.to_string()),
        Some(duration_ms),
        Some(duration_ms),
        None,
        Some(0.0),
        None,
        None,
    );
    entry.backup_path = backup.map(|p| p.to_string_lossy().into_owned());
    entry.target_path = Some(path.to_string_lossy().into_owned());
    if crate::audit::write_audit_log(&state.data_dir, &entry).is_ok() {
        state.inc_audit_count();
    }
}

// ── 测试 ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::testutil::make_state;

    #[test]
    fn issue_and_take_is_one_shot() {
        let store = TicketStore::new();
        let (id, _) = store
            .issue(
                TicketKind::Upload,
                PathBuf::from("C:/tmp/a.txt"),
                None,
                None,
                true,
                Duration::from_secs(60),
            )
            .expect("issue");
        assert_eq!(store.len(), 1);
        assert!(store.take(&id, TicketKind::Upload).is_ok());
        assert_eq!(store.len(), 0, "取走后必须从表里消失");
        assert!(
            store.take(&id, TicketKind::Upload).is_err(),
            "同一票据不能二次使用"
        );
    }

    #[test]
    fn kind_mismatch_is_rejected() {
        let store = TicketStore::new();
        let (id, _) = store
            .issue(
                TicketKind::Download,
                PathBuf::from("C:/tmp/a.txt"),
                None,
                None,
                true,
                Duration::from_secs(60),
            )
            .expect("issue");
        let err = store
            .take(&id, TicketKind::Upload)
            .expect_err("must reject");
        assert_eq!(err, TicketReject::WrongMethod("GET"), "{err:?}");
        assert!(err.message().contains("GET"), "{err:?}");
        // 方法不符是**正常用法错误**，不能计入封禁（否则合法的 AI 重试会被封）
        assert!(!err.counts_as_auth_failure(), "{err:?}");
    }

    /// 只有「票根本不存在」才累计封禁失败次数；过期是运维事件。
    #[test]
    fn only_unknown_tickets_count_as_auth_failure() {
        let store = TicketStore::new();
        let (id, _) = store
            .issue(
                TicketKind::Upload,
                PathBuf::from("C:/tmp/a.txt"),
                None,
                None,
                true,
                Duration::from_millis(0),
            )
            .expect("issue");
        let expired = store.take(&id, TicketKind::Upload).expect_err("expired");
        assert_eq!(expired, TicketReject::Expired);
        assert!(
            !expired.counts_as_auth_failure(),
            "票据过期不是攻击特征，不能记失败次数"
        );

        let unknown = store
            .take("u_never_issued", TicketKind::Upload)
            .expect_err("unknown");
        assert_eq!(unknown, TicketReject::NotFound);
        assert!(
            unknown.counts_as_auth_failure(),
            "猜票据才是攻击特征，必须记失败次数"
        );
    }

    #[test]
    fn expired_ticket_is_rejected() {
        let store = TicketStore::new();
        let (id, _) = store
            .issue(
                TicketKind::Upload,
                PathBuf::from("C:/tmp/a.txt"),
                None,
                None,
                true,
                Duration::from_millis(0),
            )
            .expect("issue");
        assert!(store.take(&id, TicketKind::Upload).is_err());
    }

    #[test]
    fn unknown_ticket_is_rejected() {
        let store = TicketStore::new();
        assert!(store.take("nope", TicketKind::Upload).is_err());
    }

    #[test]
    fn ticket_capacity_is_capped() {
        let store = TicketStore::new();
        for i in 0..MAX_TICKETS {
            store
                .issue(
                    TicketKind::Upload,
                    PathBuf::from(format!("C:/tmp/{i}.txt")),
                    None,
                    None,
                    true,
                    Duration::from_secs(60),
                )
                .expect("issue within cap");
        }
        let err = store
            .issue(
                TicketKind::Upload,
                PathBuf::from("C:/tmp/overflow.txt"),
                None,
                None,
                true,
                Duration::from_secs(60),
            )
            .expect_err("must reject at cap");
        assert!(err.contains("上限"), "{err}");
    }

    #[test]
    fn ticket_ids_are_unique_and_prefixed() {
        let store = TicketStore::new();
        let a = store
            .issue(
                TicketKind::Upload,
                PathBuf::from("a"),
                None,
                None,
                true,
                Duration::from_secs(60),
            )
            .unwrap()
            .0;
        let b = store
            .issue(
                TicketKind::Download,
                PathBuf::from("b"),
                None,
                None,
                true,
                Duration::from_secs(60),
            )
            .unwrap()
            .0;
        assert_ne!(a, b);
        assert!(a.starts_with("u_"));
        assert!(b.starts_with("d_"));
        // 令牌必须能安全进文件名（Windows 非法字符集 `<>:"/\|?*` 一个都不能有）。
        for ch in a.chars().chain(b.chars()) {
            assert!(
                ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'),
                "{ch}"
            );
        }
    }

    #[test]
    fn authority_whitelist_blocks_shell_metachars() {
        assert!(is_safe_authority("192.168.1.5:7823"));
        assert!(is_safe_authority("[::1]:7823"));
        assert!(is_safe_authority("my-pc.local:7823"));
        assert!(!is_safe_authority("evil'$(rm -rf /)':1"));
        assert!(!is_safe_authority("a/b"));
        assert!(!is_safe_authority(""));
    }

    #[test]
    fn hex_is_lowercase_fixed_width() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn percent_encode_escapes_non_ascii() {
        assert_eq!(percent_encode("a b.png"), "a%20b.png");
        assert_eq!(percent_encode("图.png"), "%E5%9B%BE.png");
    }

    /// 流式落盘的三个判据：字数、哈希、以及超限中止且**不留残留**。
    #[tokio::test]
    async fn stream_into_enforces_limit_and_hash() {
        let dir = crate::mcp::tools::testutil::unique_subdir("stream");
        let tmp = dir.join(".x.part");
        let payload = b"hello transfer".to_vec();
        let expected = to_hex(&Sha256::digest(&payload));

        let len = payload.len() as u64;
        let ok = stream_into(
            Body::from(payload.clone()),
            &tmp,
            1024,
            Some(len),
            Some(&expected),
        )
        .await
        .expect("should succeed");
        assert_eq!(ok, (len, expected.clone()));
        assert_eq!(std::fs::read(&tmp).unwrap(), payload);

        // 期望哈希不符 → 409
        let tmp2 = dir.join(".y.part");
        let bad = stream_into(
            Body::from(payload.clone()),
            &tmp2,
            1024,
            None,
            Some("deadbeef"),
        )
        .await
        .expect_err("hash mismatch");
        assert_eq!(bad.0, StatusCode::CONFLICT);

        // 超限 → 413
        let tmp3 = dir.join(".z.part");
        let over = stream_into(Body::from(vec![0u8; 64]), &tmp3, 10, None, None)
            .await
            .expect_err("too large");
        assert_eq!(over.0, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn sha256_file_matches_memory_hash() {
        let dir = crate::mcp::tools::testutil::unique_subdir("sha");
        let path = dir.join("f.bin");
        let data = vec![7u8; CHUNK + 17]; // 跨块，验证分块哈希拼接
        std::fs::write(&path, &data).unwrap();
        let (len, hex) = sha256_file(&path, 1_000_000).unwrap();
        assert_eq!(len as usize, data.len());
        assert_eq!(hex, to_hex(&Sha256::digest(&data)));
        assert!(sha256_file(&path, 100).is_err(), "超限必须报错");
    }

    /// 🔴 回归：发送必须严格按声明的 `bytes` 停手。
    ///
    /// `bytes` 既是 `Content-Length`，也是「实发多少」的唯一依据。读到 EOF 就会在文件
    /// 变长时多发，hyper 随后丢弃响应（客户端表现为卡死/截断）。
    #[tokio::test]
    async fn pump_file_stops_at_declared_length() {
        let dir = crate::mcp::tools::testutil::unique_subdir("pump");
        let path = dir.join("grow.bin");
        std::fs::write(&path, vec![1u8; 4096]).unwrap();

        // 声明 100 字节而文件有 4096：只能发 100
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        tokio::spawn(pump_file(
            tokio::fs::File::open(&path).await.unwrap(),
            100,
            tx,
        ));
        let mut got = Vec::new();
        while let Some(chunk) = rx.recv().await {
            got.extend_from_slice(&chunk.expect("chunk"));
        }
        assert_eq!(got.len(), 100, "必须按声明长度截断，不能读到 EOF");
        assert!(got.iter().all(|b| *b == 1));

        // 声明 4096 而文件被截到 10：发完就停，不许 panic、不许补零
        let short = dir.join("short.bin");
        std::fs::write(&short, vec![2u8; 10]).unwrap();
        let (tx2, mut rx2) = tokio::sync::mpsc::channel(4);
        tokio::spawn(pump_file(
            tokio::fs::File::open(&short).await.unwrap(),
            4096,
            tx2,
        ));
        let mut got2 = Vec::new();
        while let Some(chunk) = rx2.recv().await {
            got2.extend_from_slice(&chunk.expect("chunk"));
        }
        assert_eq!(got2.len(), 10, "文件变短只能少发，不能补");
    }

    /// 基地址：Host 优先；无 Host 时回退配置；危险字符被丢弃。
    #[tokio::test]
    async fn base_url_prefers_safe_host_header() {
        let (state, dir) = make_state(|_| {});
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "10.0.0.9:7823".parse().unwrap());
        assert_eq!(
            base_url(&headers, &state).await,
            "http://10.0.0.9:7823",
            "dir={:?}",
            dir
        );

        let mut evil = HeaderMap::new();
        evil.insert(header::HOST, "a'b:1".parse().unwrap());
        let fallback = base_url(&evil, &state).await;
        assert!(
            fallback.starts_with("http://") && !fallback.contains('\''),
            "危险 Host 必须被丢弃并回退：{fallback}"
        );

        let empty = HeaderMap::new();
        assert!(base_url(&empty, &state).await.starts_with("http://"));
    }

    #[tokio::test]
    async fn base_url_reads_tls_flag() {
        let (state, _dir) = make_state(|c| c.remote_tls_enabled = true);
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "10.0.0.9:7823".parse().unwrap());
        assert_eq!(base_url(&headers, &state).await, "https://10.0.0.9:7823");
    }

    #[tokio::test]
    async fn base_url_task_local_roundtrip() {
        assert!(current_base_url().is_none(), "作用域外应为 None");
        let got = with_base_url("http://x:1".to_string(), async { current_base_url() }).await;
        assert_eq!(got.as_deref(), Some("http://x:1"));
    }
}
/// 端到端：真实 HTTP server + reqwest 客户端，把「MCP 签票 → 裸 HTTP 收发 → 校验/审计」
/// 整条链跑一遍。票据的一次性与 `/transfer` 不进 body-limit 这两条只有在这层才测得到。
#[cfg(test)]
mod over_wire {
    use super::*;
    use crate::config::BridgeConfig;
    use crate::state::AppState;
    use serde_json::{json, Value};

    const TOKEN: &str = "transfer-test-token";

    struct Server {
        base: String,
        /// 裸 TCP 直连用（造「慢 body」的测试需要绕过 reqwest 的整包发送）。
        addr: std::net::SocketAddr,
        /// 供测试中途改配置（如翻只读模式）。
        state: Arc<AppState>,
        _handle: tokio::task::JoinHandle<()>,
    }

    fn cfg(root: &Path, f: impl FnOnce(&mut BridgeConfig)) -> BridgeConfig {
        let mut ext = BridgeConfig::default().allowed_extensions;
        for e in [".bin", ".pptx"] {
            ext.push(e.to_string());
        }
        let mut c = BridgeConfig {
            allowed_roots: vec![root.to_string_lossy().into_owned()],
            token: TOKEN.to_string(),
            allowed_extensions: ext,
            whitelist_enabled: true,
            readonly_mode: false,
            backup_enabled: false,
            audit_enabled: false,
            rate_limit_enabled: true,
            rate_limit_max_requests: 100,
            rate_limit_window_ms: 60_000,
            ..Default::default()
        };
        f(&mut c);
        c
    }

    async fn spawn(c: BridgeConfig, data_dir: PathBuf) -> Server {
        let conn = rusqlite::Connection::open_in_memory().expect("in-mem db");
        let state = Arc::new(AppState::new(conn, c, data_dir));
        let router = crate::mcp::http::build_router(state.clone()).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        Server {
            base: format!("http://{addr}"),
            addr,
            state,
            _handle: handle,
        }
    }

    /// 调一次 MCP 工具，返回工具 content[0].text 解析出的 JSON。
    async fn call(base: &str, tool: &str, args: Value) -> Value {
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": tool, "arguments": args }
        });
        let resp: Value = reqwest::Client::new()
            .post(format!("{base}/mcp"))
            .header("Authorization", format!("Bearer {TOKEN}"))
            .json(&body)
            .send()
            .await
            .expect("rpc send")
            .json()
            .await
            .expect("rpc json");
        let text = resp
            .pointer("/result/content/0/text")
            .and_then(|t| t.as_str())
            .unwrap_or_else(|| panic!("unexpected rpc response: {resp}"));
        serde_json::from_str(text).expect("tool payload json")
    }

    /// 只取 URL 的相对 path：绝对地址里的 Host 是测试端口，直接拼 srv.base 更可靠。
    fn path_of(v: &Value) -> String {
        v["path"].as_str().expect("path").to_string()
    }

    /// 目录里残留的 `.part` 临时文件（失败路径必须为空）。
    fn part_files(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(rd) = std::fs::read_dir(dir) else {
            return out;
        };
        for e in rd.flatten() {
            let p = e.path();
            let is_part = p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".part"));
            if is_part {
                out.push(p);
            }
        }
        out
    }

    /// 跑一次 curl。
    ///
    /// 🔴 必须 `spawn_blocking`：`#[tokio::test]` 默认是**单线程**运行时，就地
    /// `Command::output()` 会把唯一的线程占死，同一运行时里的 axum server 再也拿不到
    /// 时间片 → curl 等响应、测试等 curl，双向死锁（实测整个 `cargo test` 挂 14 分钟不动）。
    async fn run_curl(args: Vec<std::ffi::OsString>) -> std::process::Output {
        tokio::task::spawn_blocking(move || {
            std::process::Command::new("curl")
                .args(args)
                .output()
                .expect("run curl")
        })
        .await
        .expect("curl 任务失败")
    }

    #[tokio::test]
    async fn upload_then_replay_is_rejected() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-up");
        let srv = spawn(cfg(&dir, |_| {}), dir.clone()).await;
        let target = dir.join("a.bin");
        let payload = b"hello transfer".to_vec();
        let sha = sha256_of(&payload);

        let issued = call(
            &srv.base,
            "prepare_upload",
            json!({ "path": target.to_string_lossy(), "sha256": sha, "size": payload.len() }),
        )
        .await;
        assert_eq!(issued["method"], "PUT");

        // 关键：/transfer 不带 Bearer 也必须能用（凭据是票据）。
        let resp = reqwest::Client::new()
            .put(format!("{}{}", srv.base, path_of(&issued)))
            .body(payload.clone())
            .send()
            .await
            .expect("put");
        let status = resp.status();
        assert_eq!(status, 200, "body={:?}", resp.text().await);
        assert_eq!(std::fs::read(&target).unwrap(), payload);

        // 一次性：同一票据重放必须 401
        let replay = reqwest::Client::new()
            .put(format!("{}{}", srv.base, path_of(&issued)))
            .body(payload)
            .send()
            .await
            .expect("replay");
        assert_eq!(replay.status(), 401);
        assert!(part_files(&dir).is_empty(), "不应留下 .part 残留");
    }

    #[tokio::test]
    async fn hash_mismatch_leaves_target_untouched() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-badhash");
        let srv = spawn(cfg(&dir, |_| {}), dir.clone()).await;
        let target = dir.join("keep.bin");
        std::fs::write(&target, b"original").unwrap();

        let issued = call(
            &srv.base,
            "prepare_upload",
            json!({ "path": target.to_string_lossy(), "sha256": "0".repeat(64) }),
        )
        .await;
        let resp = reqwest::Client::new()
            .put(format!("{}{}", srv.base, path_of(&issued)))
            .body(b"new content".to_vec())
            .send()
            .await
            .expect("put");
        assert_eq!(resp.status(), 409);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"original",
            "哈希不符必须整次作废，目标文件不动"
        );
        assert!(part_files(&dir).is_empty(), "不应留下 .part 残留");
    }

    #[tokio::test]
    async fn oversized_upload_is_aborted_without_residue() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-big");
        let srv = spawn(cfg(&dir, |c| c.max_file_size_bytes = 1024), dir.clone()).await;
        let target = dir.join("big.bin");
        let issued = call(
            &srv.base,
            "prepare_upload",
            json!({ "path": target.to_string_lossy() }),
        )
        .await;
        let resp = reqwest::Client::new()
            .put(format!("{}{}", srv.base, path_of(&issued)))
            .body(vec![0u8; 4096])
            .send()
            .await
            .expect("put");
        assert_eq!(resp.status(), 413);
        // 必须是**我们自己**的 JSON 错误，而不是 `RequestBodyLimitLayer` 的
        // `text/plain "length limit exceeded"`。这条同时守「/transfer 没有挂上 /mcp 那组层」：
        // 一旦哪天有人把两条子路由合回去，这里立刻变红。
        assert!(
            resp.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("application/json")),
            "413 必须是结构化 JSON 错误，而不是 RequestBodyLimitLayer 的 text/plain"
        );
        let body: Value = resp.json().await.expect("413 body 应为 JSON");
        assert_eq!(body["ok"], false, "{body}");
        assert!(!target.exists(), "超限不得写出目标文件");
        assert!(part_files(&dir).is_empty(), "不应留下 .part 残留");
    }

    /// 3MB 上传：验证 `/transfer` 确实绕开了 `RequestBodyLimitLayer`（整包缓冲），
    /// 也绕开了 axum 对普通 extractor 的默认 body 上限。
    #[tokio::test]
    async fn multi_megabyte_upload_streams_through() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-3mb");
        let srv = spawn(cfg(&dir, |_| {}), dir.clone()).await;
        let target = dir.join("big-ok.bin");
        let payload = vec![0x41u8; 3 * 1024 * 1024];
        let sha = sha256_of(&payload);
        let issued = call(
            &srv.base,
            "prepare_upload",
            json!({ "path": target.to_string_lossy(), "sha256": sha }),
        )
        .await;
        let resp = reqwest::Client::new()
            .put(format!("{}{}", srv.base, path_of(&issued)))
            .body(payload.clone())
            .send()
            .await
            .expect("put");
        let status = resp.status();
        assert_eq!(status, 200, "body={:?}", resp.text().await);
        assert_eq!(
            std::fs::metadata(&target).unwrap().len(),
            payload.len() as u64
        );
    }

    #[tokio::test]
    async fn download_returns_length_and_hash() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-down");
        let srv = spawn(cfg(&dir, |_| {}), dir.clone()).await;
        let target = dir.join("out.bin");
        let payload = vec![9u8; 5000];
        std::fs::write(&target, &payload).unwrap();

        let issued = call(
            &srv.base,
            "prepare_download",
            json!({ "path": target.to_string_lossy() }),
        )
        .await;
        assert_eq!(issued["bytes"], 5000);
        let expected = sha256_of(&payload);
        assert_eq!(issued["sha256"].as_str().unwrap(), expected);

        let resp = reqwest::Client::new()
            .get(format!("{}{}", srv.base, path_of(&issued)))
            .send()
            .await
            .expect("get");
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok()),
            Some("5000")
        );
        assert_eq!(
            resp.headers()
                .get("x-content-sha256")
                .and_then(|v| v.to_str().ok()),
            Some(expected.as_str())
        );
        assert_eq!(resp.bytes().await.unwrap().to_vec(), payload);

        // 一次性
        let again = reqwest::Client::new()
            .get(format!("{}{}", srv.base, path_of(&issued)))
            .send()
            .await
            .expect("get2");
        assert_eq!(again.status(), 401);
    }

    #[tokio::test]
    async fn wrong_method_on_ticket_is_rejected() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-method");
        let srv = spawn(cfg(&dir, |_| {}), dir.clone()).await;
        let target = dir.join("m.bin");
        let issued = call(
            &srv.base,
            "prepare_upload",
            json!({ "path": target.to_string_lossy() }),
        )
        .await;
        let resp = reqwest::Client::new()
            .get(format!("{}{}", srv.base, path_of(&issued)))
            .send()
            .await
            .expect("get");
        assert_eq!(resp.status(), 401, "PUT 票据拿去 GET 必须拒绝");
    }

    #[tokio::test]
    async fn random_ticket_is_rejected_and_counted() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-guess");
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let state = Arc::new(AppState::new(conn, cfg(&dir, |_| {}), dir.clone()));
        let before = state.auth_denies.load(std::sync::atomic::Ordering::Relaxed);
        let router = crate::mcp::http::build_router(state.clone()).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        let resp = reqwest::Client::new()
            .put(format!("http://{addr}/transfer/u_guessed"))
            .body(b"x".to_vec())
            .send()
            .await
            .expect("put");
        assert_eq!(resp.status(), 401);
        assert!(
            state.auth_denies.load(std::sync::atomic::Ordering::Relaxed) > before,
            "猜票据必须计入鉴权拒绝指标"
        );
    }

    /// 只读模式下**下载**必须照常可用（只读拦的是写）。
    #[tokio::test]
    async fn download_still_works_in_readonly_mode() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-ro-down");
        let srv = spawn(cfg(&dir, |c| c.readonly_mode = true), dir.clone()).await;
        let target = dir.join("ro.bin");
        let payload = b"readonly read".to_vec();
        std::fs::write(&target, &payload).unwrap();

        let issued = call(
            &srv.base,
            "prepare_download",
            json!({ "path": target.to_string_lossy() }),
        )
        .await;
        assert!(
            issued.get("error").is_none() && issued.get("ticketId").is_some(),
            "{issued}"
        );

        let resp = reqwest::Client::new()
            .get(format!("{}{}", srv.base, path_of(&issued)))
            .send()
            .await
            .expect("get");
        assert_eq!(resp.status(), 200, "只读模式不该挡下载");
        assert_eq!(resp.bytes().await.unwrap().to_vec(), payload);
    }

    /// 票据签发后用户开了只读：上传必须被拒（票据不等于永久授权）。
    #[tokio::test]
    async fn upload_rejected_when_readonly_turned_on_after_issue() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-ro-up");
        let srv = spawn(cfg(&dir, |_| {}), dir.clone()).await;
        let target = dir.join("late.bin");
        let issued = call(
            &srv.base,
            "prepare_upload",
            json!({ "path": target.to_string_lossy() }),
        )
        .await;
        srv.state.config.write().await.readonly_mode = true;

        let resp = reqwest::Client::new()
            .put(format!("{}{}", srv.base, path_of(&issued)))
            .body(b"nope".to_vec())
            .send()
            .await
            .expect("put");
        assert_eq!(resp.status(), 403);
        assert!(!target.exists());
    }

    /// 票据**过期**不能算攻击：它是正常运维事件（AI 想久了才来 curl）。
    /// 旧实现一律按鉴权失败记账 → 攒够阈值就把合法调用方封掉，而 `/transfer` 被封
    /// 等于桥端自己不可用、用户还看不出原因。
    #[tokio::test]
    async fn expired_ticket_is_401_but_does_not_ban() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-ban-exp");
        let srv = spawn(
            cfg(&dir, |c| {
                c.host = "0.0.0.0".to_string();
                c.remote_ban_enabled = true;
                // 阈值压到 1：只要记一次失败就会被封，能立刻区分「记了」和「没记」
                c.remote_ban_threshold = 1;
            }),
            dir.clone(),
        )
        .await;
        let peer: std::net::IpAddr = "127.0.0.1".parse().unwrap();

        // 直接塞一张已过期的上传票（prepare_upload 的 ttl 有 1 秒下限，造不出来）
        let (expired_id, _) = srv
            .state
            .transfer_tickets
            .issue(
                TicketKind::Upload,
                dir.join("expired.bin"),
                None,
                None,
                true,
                Duration::from_millis(0),
            )
            .expect("issue");

        let resp = reqwest::Client::new()
            .put(format!("{}/transfer/{expired_id}", srv.base))
            .body(b"late".to_vec())
            .send()
            .await
            .expect("put");
        assert_eq!(resp.status(), 401);
        assert!(
            srv.state.ban.check(peer),
            "票据过期不该累计封禁失败次数（阈值 1，记一次就会被封）"
        );

        // 对照：随机猜票据必须被记 → 同一阈值下立刻进入封禁
        let guessed = reqwest::Client::new()
            .put(format!("{}/transfer/u_guessed_ban", srv.base))
            .body(b"x".to_vec())
            .send()
            .await
            .expect("put");
        assert_eq!(guessed.status(), 401);
        assert!(
            !srv.state.ban.check(peer),
            "猜票据属于攻击特征，必须累计到封禁"
        );
    }

    /// 上传到尚不存在的子目录必须自动创建（`ensure_parent`）。
    #[tokio::test]
    async fn upload_creates_missing_parent_dirs() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-mkdir");
        let srv = spawn(cfg(&dir, |_| {}), dir.clone()).await;
        let target = dir.join("nested").join("deeper").join("x.bin");
        let payload = b"nested".to_vec();

        let issued = call(
            &srv.base,
            "prepare_upload",
            json!({ "path": target.to_string_lossy(), "sha256": sha256_of(&payload) }),
        )
        .await;
        assert!(issued.get("error").is_none(), "{issued}");

        let resp = reqwest::Client::new()
            .put(format!("{}{}", srv.base, path_of(&issued)))
            .body(payload.clone())
            .send()
            .await
            .expect("put");
        assert_eq!(resp.status(), 200, "body={:?}", resp.text().await);
        assert_eq!(std::fs::read(&target).unwrap(), payload);
    }

    /// 🔴 签发后被改写：响应头的长度/哈希必须仍然描述**实际发出去的那份字节**。
    ///
    /// 这条守的是「哈希与发送共用同一个 File 句柄」：若两遍各自 open，文件在这中间被
    /// 改写就会让 `Content-Length` 与实际字节数不符，客户端表现为卡死（等不到结束）
    /// 或被截断，而两者都很难从日志上看出来。
    #[tokio::test]
    async fn download_headers_match_bytes_even_if_file_changed_after_issue() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-down-race");
        let srv = spawn(cfg(&dir, |_| {}), dir.clone()).await;
        let target = dir.join("race.bin");
        std::fs::write(&target, vec![1u8; 5000]).unwrap();

        let issued = call(
            &srv.base,
            "prepare_download",
            json!({ "path": target.to_string_lossy() }),
        )
        .await;
        assert_eq!(issued["bytes"], 5000);

        // 票据已签出，此时文件被改写（长度也变了）
        let newer = vec![7u8; 777];
        std::fs::write(&target, &newer).unwrap();

        let resp = reqwest::Client::new()
            .get(format!("{}{}", srv.base, path_of(&issued)))
            .send()
            .await
            .expect("get");
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok()),
            Some("777"),
            "Content-Length 必须是**此刻**的字节数"
        );
        assert_eq!(
            resp.headers()
                .get("x-content-sha256")
                .and_then(|v| v.to_str().ok()),
            Some(sha256_of(&newer).as_str())
        );
        assert_eq!(resp.bytes().await.unwrap().to_vec(), newer);
    }

    /// 🔴 回归：`overwrite=false` 在**流式落盘期间**被别处建出目标文件，也必须放弃写入。
    ///
    /// 用裸 TCP 造「慢 body」（chunked + 中途停顿）：第一块发完就把目标文件建出来，再发剩下
    /// 的字节。这样「落盘前的检查已通过、落盘后文件才出现」这个窗口是**确定性**复现的，
    /// 不靠大文件抢时序。守护的是锁内那第二次 `exists()` 判定。
    #[tokio::test]
    async fn overwrite_false_wins_when_file_appears_mid_stream() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-ow-race");
        let srv = spawn(cfg(&dir, |_| {}), dir.clone()).await;
        let target = dir.join("race.bin");

        let issued = call(
            &srv.base,
            "prepare_upload",
            json!({ "path": target.to_string_lossy(), "overwrite": false }),
        )
        .await;
        assert!(issued.get("error").is_none(), "{issued}");
        let ticket = issued["ticketId"].as_str().expect("ticketId").to_string();

        let mut sock = tokio::net::TcpStream::connect(srv.addr)
            .await
            .expect("connect");
        let head = format!(
            "PUT /transfer/{ticket} HTTP/1.1\r\nHost: {}\r\nTransfer-Encoding: chunked\r\n\r\n",
            srv.addr
        );
        sock.write_all(head.as_bytes()).await.unwrap();
        let first = vec![0x11u8; 4096];
        sock.write_all(format!("{:x}\r\n", first.len()).as_bytes())
            .await
            .unwrap();
        sock.write_all(&first).await.unwrap();
        sock.write_all(b"\r\n").await.unwrap();
        sock.flush().await.unwrap();

        // 此时服务端已把第一块写进 .part，尚未走到锁内判定
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        std::fs::write(&target, b"created by someone else").unwrap();

        let second = vec![0x22u8; 4096];
        sock.write_all(format!("{:x}\r\n", second.len()).as_bytes())
            .await
            .unwrap();
        sock.write_all(&second).await.unwrap();
        sock.write_all(b"\r\n0\r\n\r\n").await.unwrap();
        sock.flush().await.unwrap();

        let mut buf = [0u8; 2048];
        // 加超时：裸 socket 上「服务端不回」会永久挂住整个测试进程（`cargo test` 里表现为
        // 一条测试跑十几分钟不停），超时至少能把失败点指到这一行。
        let n = tokio::time::timeout(std::time::Duration::from_secs(10), sock.read(&mut buf))
            .await
            .expect("等响应超时（10s）——服务端很可能卡在读 body 上")
            .expect("read response");
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        assert!(text.starts_with("HTTP/1.1 409"), "{text}");
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"created by someone else",
            "overwrite=false 不得覆盖中途出现的文件"
        );
        assert!(part_files(&dir).is_empty(), "不应留下 .part 残留");
    }

    /// 用**真的 curl** 跑一遍语义（参数原样传，不经 shell 解析）。
    ///
    /// 守的是 `--fail-with-body`（上传）与 `-f`（下载）：`curl -sS` 对 4xx/5xx **退出码仍是 0**，
    /// 于是「401 票据无效」会被调用方当成成功。这条只有真跑一次 curl 才测得到，
    /// 单测里断言字符串包含某个 flag 是不够的。
    #[tokio::test]
    async fn real_curl_exits_nonzero_on_http_error() {
        // 探针放在起 server 之前：此时运行时里没有别的任务，就地阻塞不会死锁。
        let curl_ok = std::process::Command::new("curl")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !curl_ok {
            eprintln!("跳过：本机没有可用的 curl");
            return;
        }

        let dir = crate::mcp::tools::testutil::unique_subdir("tr-curl");
        let srv = spawn(cfg(&dir, |_| {}), dir.clone()).await;

        // ── 上传：首次 200；重放 401 必须让 curl 退出码非 0 ──
        let target = dir.join("curl.bin");
        let payload_file = dir.join("payload.txt");
        std::fs::write(&payload_file, b"via-curl").unwrap();
        let issued = call(
            &srv.base,
            "prepare_upload",
            json!({
                "path": target.to_string_lossy(),
                "sha256": sha256_of(b"via-curl"),
            }),
        )
        .await;
        let url = format!("{}{}", srv.base, path_of(&issued));

        let first = run_curl(vec![
            "-sS".into(),
            "--fail-with-body".into(),
            "-T".into(),
            payload_file.clone().into_os_string(),
            url.clone().into(),
        ])
        .await;
        assert!(
            first.status.success(),
            "首次上传应当成功。stderr={}",
            String::from_utf8_lossy(&first.stderr)
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"via-curl");

        let replay = run_curl(vec![
            "-sS".into(),
            "--fail-with-body".into(),
            "-T".into(),
            payload_file.into_os_string(),
            url.clone().into(),
        ])
        .await;
        assert!(
            !replay.status.success(),
            "票据重放必须让 curl 退出码非 0（这正是 --fail-with-body 的意义）"
        );
        assert_eq!(
            replay.status.code(),
            Some(22),
            "curl 对 HTTP 4xx/5xx 的退出码是 22。stderr={}",
            String::from_utf8_lossy(&replay.stderr)
        );

        // ── 下载：首次成功；重放 401 必须退出码非 0 且不写出可用文件 ──
        let src = dir.join("src.bin");
        std::fs::write(&src, b"download-me").unwrap();
        let issued = call(
            &srv.base,
            "prepare_download",
            json!({ "path": src.to_string_lossy() }),
        )
        .await;
        let url = format!("{}{}", srv.base, path_of(&issued));
        let out = dir.join("local-copy.bin");
        let ok = run_curl(vec![
            "-sS".into(),
            "-f".into(),
            "-o".into(),
            out.clone().into_os_string(),
            url.clone().into(),
        ])
        .await;
        assert!(
            ok.status.success(),
            "下载应当成功。stderr={}",
            String::from_utf8_lossy(&ok.stderr)
        );
        assert_eq!(std::fs::read(&out).unwrap(), b"download-me");

        let again = run_curl(vec![
            "-sS".into(),
            "-f".into(),
            "-o".into(),
            dir.join("local-copy-2.bin").into_os_string(),
            url.into(),
        ])
        .await;
        assert!(
            !again.status.success(),
            "票据重放必须让 curl 退出码非 0（-f 的意义）"
        );
    }

    /// 审计必须留一条 `transfer` 记录，且**不含完整票据值**。
    #[tokio::test]
    async fn audit_record_has_no_ticket_value() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-audit");
        let srv = spawn(cfg(&dir, |c| c.audit_enabled = true), dir.clone()).await;
        let target = dir.join("audit.bin");
        let payload = b"audited".to_vec();
        let issued = call(
            &srv.base,
            "prepare_upload",
            json!({ "path": target.to_string_lossy(), "sha256": sha256_of(&payload) }),
        )
        .await;
        let ticket = issued["ticketId"].as_str().unwrap().to_string();
        let resp = reqwest::Client::new()
            .put(format!("{}{}", srv.base, path_of(&issued)))
            .body(payload)
            .send()
            .await
            .expect("put");
        assert_eq!(resp.status(), 200);

        let log = std::fs::read_to_string(dir.join("audit.log")).expect("audit.log");
        assert!(log.contains("\"tool\":\"transfer\""), "{log}");
        assert!(!log.contains(&ticket), "审计里不得出现完整票据值");
        assert!(log.contains("via"), "{log}");
    }

    /// 下载审计写在**发送任务**里（比响应返回晚），所以读日志要等一下。
    async fn wait_audit_line(dir: &Path, needle: &str) -> String {
        for _ in 0..200 {
            if let Ok(s) = std::fs::read_to_string(dir.join("audit.log")) {
                if s.contains(needle) {
                    return s;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!(
            "等了 4s 审计日志仍未出现 {needle}；当前内容：{:?}",
            std::fs::read_to_string(dir.join("audit.log")).unwrap_or_default()
        );
    }

    /// 下载成功后审计必须记 `success:true` 且字节数是**实际发出的量**。
    ///
    /// 这条守的是「审计时序」：原实现在起发之前就把 `success:true` 写死了。
    #[tokio::test]
    async fn download_audit_records_success_after_body_completes() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-audit-dl");
        let srv = spawn(
            cfg(&dir, |c| {
                c.audit_enabled = true;
                c.allowed_extensions.push(".dat".to_string());
            }),
            dir.clone(),
        )
        .await;
        let target = dir.join("payload.dat");
        let payload = vec![7u8; 8192];
        std::fs::write(&target, &payload).unwrap();

        let issued = call(
            &srv.base,
            "prepare_download",
            json!({ "path": target.to_string_lossy() }),
        )
        .await;
        let resp = reqwest::Client::new()
            .get(format!("{}{}", srv.base, path_of(&issued)))
            .send()
            .await
            .expect("get");
        assert_eq!(resp.status(), 200);
        let body = resp.bytes().await.expect("body").to_vec();
        assert_eq!(body.len(), payload.len());

        let log = wait_audit_line(&dir, "\"tool\":\"transfer\"").await;
        assert!(log.contains("\"success\":true"), "{log}");
        // `params` 在审计里是**字符串**，内部引号被转义成 \" —— 匹配要带反斜杠。
        assert!(
            log.contains(r#"\"bytes\":8192"#),
            "审计要记实际发送字节：{log}"
        );
    }

    /// 客户端读到一半就断开：审计必须记**失败**，并且带上实际已发字节。
    ///
    /// 用裸 TCP 而不是 reqwest——reqwest 不读 body 时数据仍可能整块进内核缓冲区，
    /// 服务端会误判为「发完了」。裸 TCP 读个响应头就 close 才是确定的提前断开。
    #[tokio::test]
    async fn download_audit_marks_abort_when_client_disconnects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let dir = crate::mcp::tools::testutil::unique_subdir("tr-audit-abort");
        let srv = spawn(
            cfg(&dir, |c| {
                c.audit_enabled = true;
                c.allowed_extensions.push(".dat".to_string());
            }),
            dir.clone(),
        )
        .await;
        let target = dir.join("big.dat");
        // 4MB 远大于 4×CHUNK 的 channel 缓冲 + socket 缓冲，保证断开时还没发完。
        let payload = vec![3u8; 4 * 1024 * 1024];
        std::fs::write(&target, &payload).unwrap();

        let issued = call(
            &srv.base,
            "prepare_download",
            json!({ "path": target.to_string_lossy() }),
        )
        .await;

        let addr = srv.base.trim_start_matches("http://").to_string();
        let mut sock = tokio::net::TcpStream::connect(&addr)
            .await
            .expect("connect");
        let req = format!(
            "GET {} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n",
            path_of(&issued)
        );
        sock.write_all(req.as_bytes()).await.expect("write req");
        let mut head = [0u8; 256];
        let _ = sock.read(&mut head).await;
        drop(sock); // 立刻断开，body 只读了几百字节

        let log = wait_audit_line(&dir, "\"tool\":\"transfer\"").await;
        assert!(
            log.contains("\"success\":false"),
            "客户端中途断开必须记失败：{log}"
        );
        assert!(log.contains("传输中断"), "失败原因应说明传输中断：{log}");
    }

    /// `/transfer` 与 `/mcp` 分桶：工具调用把配额打满后，传输仍然可用。
    ///
    /// 共用一个桶时，一轮密集的工具轮询就能把窗口耗到 429，紧接着的 `curl -T`
    /// 直接失败 —— 而传输是低频的一次性操作，被高频计数挤掉没有道理。
    #[tokio::test]
    async fn transfer_rate_limit_is_separate_from_mcp() {
        let dir = crate::mcp::tools::testutil::unique_subdir("tr-rl");
        let srv = spawn(
            cfg(&dir, |c| {
                c.rate_limit_enabled = true;
                c.rate_limit_max_requests = 2;
                c.rate_limit_window_ms = 60_000;
                c.allowed_extensions.push(".dat".to_string());
            }),
            dir.clone(),
        )
        .await;
        let target = dir.join("q.dat");
        std::fs::write(&target, b"quota").unwrap();

        // 用掉全部 /mcp 配额（两次），并留下一张待消费的票据
        let issued = call(
            &srv.base,
            "prepare_download",
            json!({ "path": target.to_string_lossy() }),
        )
        .await;
        let _second = call(
            &srv.base,
            "prepare_download",
            json!({ "path": target.to_string_lossy() }),
        )
        .await;

        // 第三次 /mcp 必须 429
        let third = reqwest::Client::new()
            .post(format!("{}/mcp", srv.base))
            .header("Authorization", format!("Bearer {TOKEN}"))
            .json(&json!({
                "jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": {}
            }))
            .send()
            .await
            .expect("third");
        assert_eq!(third.status(), 429, "/mcp 配额应已耗尽");

        // 但 /transfer 不受影响
        let resp = reqwest::Client::new()
            .get(format!("{}{}", srv.base, path_of(&issued)))
            .send()
            .await
            .expect("get");
        assert_eq!(
            resp.status(),
            200,
            "/transfer 不该被 /mcp 的配额挡住（分桶失效）"
        );
        assert_eq!(resp.bytes().await.unwrap().to_vec(), b"quota");
    }
}
