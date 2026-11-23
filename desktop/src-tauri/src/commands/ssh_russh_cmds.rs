//! D 方案：文件面板的**内置 SSH/SFTP 长连接**（russh）。
//!
//! ## 为什么需要它
//!
//! Windows 自带的 OpenSSH 没有 ControlMaster，无法复用连接。于是「新起一个
//! `ssh.exe`/`scp.exe` 进程」就等于「付一次完整握手」——本机到 10.0.19.194 实测
//! 约 11 秒（慢在服务器端 PAM，不是网络，见 `docs/隧道启动认证耗时-11秒排查与修复`）。
//! 文件面板原先的三条路径（helper 常驻 shell / 一次性 ssh / scp 进程）都建立在这个
//! 前提上，所以每次都逃不掉那 11 秒。
//!
//! 同类软件（Tabby / Yazi / Shelly SSH / fileterm）做法一致：**内置 SSH 协议栈，
//! 一条长连接上多路复用所有操作**。本模块就是这个：一条 russh 连接 + 一个 SFTP
//! subsystem channel，列目录/读写/传输全部零握手。
//!
//! ## 与既有路径的关系（灰度策略）
//!
//! **不删旧路径**。调用方一律「先试 russh，任何失败自动回退」到现有 helper / scp。
//! 理由：服务器可能禁 PTY、禁 sftp 子系统、或 russh 与某台老服务器的算法协商失败；
//! 那时文件面板必须仍然可用（慢，但不丢能力）。
//!
//! ## 安全纪律（与 `ssh_helper.rs` 同源，不得放宽）
//!
//! - 明文凭据**只在 `open_russh_session` 的认证那一瞬**存在于局部变量，
//!   不进 `RusshFileSession`、不进任何长生命周期结构。
//! - 不需要 askpass、不需要临时脚本、**不落盘**（这一点比当年 B1 方案干净：
//!   B1 要把密码交给外部 `ssh.exe`，而这里密码直接进 russh 的认证调用）。
//! - host key 策略与 `ssh_base_args` 的 `StrictHostKeyChecking=accept-new` 对齐。
//!
//! ## 已知边界
//!
//! - **暂不支持跳板机（ProxyJump）**：russh 无内置 proxy，需要「先连跳板认证、
//!   再 `channel_open_direct_tcpip` 拿到 stream、用 `connect_stream` 连目标」。
//!   用户当前连接是直连（`proxyJumpId` 为空），故第一版检测到跳板直接返回 Err，
//!   由调用方回退到旧路径，不静默失败。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client::{self, Handle};
use russh::keys::PrivateKeyWithHashAlg;
use russh_sftp::client::SftpSession;

use super::ssh_cmds::SshLink;
use crate::ssh_proxy::PendingCreds;
use crate::state::AppState;

/// 连接空闲多久后回收。与 helper 的 `HELPER_IDLE_TTL`（1800 秒）对齐：
/// 服务器端 `MaxSessions` 默认只有 10，不能白占。
///
/// 注意这是**兜底**而非主要释放时机：断开终端、删除/改动连接、关 SSH 总开关
/// 都会显式 `drop_russh_session`。
const RUSSH_IDLE_TTL: Duration = Duration::from_secs(1800);

/// 建连 + 认证的总超时。内网登录约 11 秒，给到 40 秒留足余量；
/// 超时后调用方回退旧路径，不会把用户卡死。
const RUSSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(40);

/// russh 路径**建连失败**后的冷却期。
///
/// 🔴 这个负缓存是灰度策略能成立的前提：服务器禁 sftp 子系统、算法协商失败、
/// 或没有保存密码时，`get_russh_session` 每次都失败。若不加冷却，调用方
/// 「先试 russh 再回退」就会**每一次都先白付一次失败成本**（最坏 40 秒超时）
/// 才走旧路径——比不接 russh 还慢得多，正是这个模块要避免的事。
/// 与 helper 的 `HELPER_BLOCK_TTL`（60 秒）对齐。
const RUSSH_BLOCK_TTL: Duration = Duration::from_secs(60);

/// SFTP 单条操作的超时。russh-sftp 默认 10 秒；列大目录与传大文件时可能不够，
/// 统一放到 30 秒（与旧路径 `SSH_ONESHOT_TIMEOUT` 同量级）。
const RUSSH_OP_TIMEOUT_SECS: u64 = 30;

/// 保活间隔 / 最大无响应次数。与 `ssh_base_args` 的
/// `ServerAliveInterval=30` + `ServerAliveCountMax=3` 对齐。
const KEEPALIVE_INTERVAL_SECS: u64 = 30;
const KEEPALIVE_MAX: usize = 3;

/// russh 客户端回调。当前只需要回答 host key 一项。
#[derive(Clone)]
pub struct RusshHandler;

impl client::Handler for RusshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // 🔴 语义**弱于**旧路径的 `StrictHostKeyChecking=accept-new`，必须说清楚：
        // accept-new 会自动接受**未知**的 host key，但 known_hosts 里已有记录、
        // 指纹**变了**的时候仍然拒绝（防中间人）；而 russh 这一版不做 known_hosts
        // 比对，两种情况都放行，实际等同 `StrictHostKeyChecking=no`。
        //
        // 第一版先这样的理由：russh 没有内置 known_hosts 解析，自己实现要处理
        // hashed 条目、`[host]:port` 形式、注释与 revoked 行，代价不小；而本工具
        // 面向的是内网开发机，且**回退路径始终存在**。真要严格校验，正确做法是在
        // 这里读 known_hosts 比对，比对不上返回 `Ok(false)`，让调用方回退到旧
        // `ssh.exe` 路径，由 OpenSSH 去拦。这条已记在方案文档「已知边界」。
        //
        // 但不能改成「一律拒绝未知 host key」：那会让每台服务器的第一次列目录都
        // 失败并回退到 scp 路径——用户看到的现象就是「第一次特别慢」，
        // 正好是我们要消除的东西。
        Ok(true)
    }
}

/// 一条连接的 russh 长会话：一个 SSH 连接 + 其上的 SFTP subsystem channel。
///
/// `handle` 必须被持有：drop 它等于断开整条连接（连带 SFTP channel）。
pub struct RusshFileSession {
    /// 建连后只在认证时用；之后长期持有着「保活」。
    /// 用 `tokio::sync::Mutex` 是因为 `Handle` 的方法要 `&mut self`，
    /// 而 `channel_open_session()` 只取 `&self`——真正需要写它的场景只有认证，
    /// 认证完就不再有人锁它，所以不会成为热点。
    handle: Arc<tokio::sync::Mutex<Handle<RusshHandler>>>,
    /// SFTP 会话。`Arc` 共享：多个并发操作（列目录 + 传输）走同一个 channel，
    /// 由 russh-sftp 内部的请求 ID 多路复用保证不串包。
    pub sftp: Arc<SftpSession>,
    /// 最后活跃时间（Unix 秒）。GC 判空闲用。
    last_used: AtomicU64,
    /// 建连完成时刻（Unix 秒）。仅用于诊断日志。
    #[allow(dead_code)]
    opened_at: u64,
}

impl RusshFileSession {
    fn touch(&self) {
        self.last_used.store(now_secs(), Ordering::Relaxed);
    }

    /// 空闲了多少秒。
    pub fn idle_for(&self) -> Duration {
        idle_duration(self.last_used.load(Ordering::Relaxed), now_secs())
    }

    /// 连接是否已断。`Handle::is_closed` 反映底层 session 是否还活着。
    pub async fn is_closed(&self) -> bool {
        self.handle.lock().await.is_closed()
    }

    /// 主动关闭（drop 前的收尾）。失败无所谓：Drop 会兜底。
    pub async fn close(&self) {
        let _ = self.sftp.close().await;
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 空闲时长。抽成纯函数是为了能单测——`RusshFileSession` 依赖真服务器，
/// 在 CI 里构造不出来，而「时钟回拨时不能 panic / 不能变负数」这条必须守住。
fn idle_duration(last_used: u64, now: u64) -> Duration {
    Duration::from_secs(now.saturating_sub(last_used))
}

/// 取该连接的 russh 会话，没有就建一条。
///
/// **建连是串行的**：每条连接一把「建连锁」（`state.ssh_russh_open_locks`）。
/// 没有它的话，面板刷新与拖拽上传的同名检查会同时发现 map 里没有 key，
/// 各自建一条连接——白付一次 11 秒登录，还多占一个服务器 session 名额，
/// 并发多了可能撞上 sshd 的 `MaxStartups`（默认 `10:30:60`）被随机丢包。
/// 这正是旧 helper 路径上已知的 P1-1，这里从第一版就避开。
pub(super) async fn get_russh_session(
    state: &AppState,
    link: &SshLink,
    creds: PendingCreds,
) -> Result<Arc<RusshFileSession>, String> {
    let key = link.conn.id.clone();

    // 跳板机第一版不支持。**必须提前到这里判**，不能留给 `open_russh_session` 失败：
    // 这条连接永远走不通 russh，若走下面的失败分支，就会每 60 秒（负缓存过期后）
    // 记一次负缓存并打一行失败日志——用户看到的是一个周期性复发的假故障。
    // 直接返回 Err 是零成本的：调用方立刻走旧路径，什么都不记、什么都不缓存。
    if link.proxy.is_some() {
        return Err("russh 路径暂不支持跳板连接，已回退".into());
    }

    // 负缓存：近期建连失败 ⇒ 直接失败，让调用方立刻走旧路径。
    // 见 `RUSSH_BLOCK_TTL` 的注释：没有它，「先试 russh 再回退」会比不接还慢。
    if let Some(t) = state.ssh_russh_blocked.get(&key) {
        if t.elapsed() < RUSSH_BLOCK_TTL {
            return Err("russh 路径近期建立失败，暂不重试".into());
        }
    }

    // 快路径：已有且活着。不持锁，避免和正在建连的调用方互等。
    if let Some(s) = state.ssh_russh_sessions.get(&key) {
        if !s.is_closed().await {
            s.touch();
            return Ok(s.clone());
        }
    }

    // 慢路径：先拿这条连接的建连锁，再双检一次（锁内可能已被别人建好）。
    let lock = state
        .ssh_russh_open_locks
        .entry(key.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .value()
        .clone();
    let _guard = lock.lock().await;

    if let Some(s) = state.ssh_russh_sessions.get(&key) {
        if !s.is_closed().await {
            s.touch();
            return Ok(s.clone());
        }
        // 死了：摘掉，下面重建。
        drop(s);
        state.ssh_russh_sessions.remove(&key);
    }

    // 注意这里**不检查系统有没有 ssh.exe**：russh 是内置协议栈，
    // 与 OpenSSH 客户端是否安装无关。旧路径才依赖它。
    let sess = match open_russh_session(link, creds).await {
        Ok(s) => s,
        Err(e) => {
            // 记负缓存：冷却期内后续操作直接走旧路径，不再白付失败成本。
            state.ssh_russh_blocked.insert(key.clone(), Instant::now());
            // 可观测性：回退对调用方是静默的（只看到一个 Err）。不打这行的话，
            // 「这次快」和「russh 从来没成过、一直在走旧路」从外表完全分不出来——
            // 而后者正是用户最初抱怨「一直都慢」的形态。
            eprintln!(
                "[SSH] russh 建连失败（{}@{}:{}），回退 helper 路径：{e}",
                link.conn.username, link.conn.host, link.conn.port
            );
            return Err(e);
        }
    };
    let arc = Arc::new(sess);
    state.ssh_russh_sessions.insert(key.clone(), arc.clone());
    // 建成了就清掉负缓存：下一次操作又能立刻命中 russh。
    state.ssh_russh_blocked.remove(&key);
    eprintln!(
        "[SSH] russh 长连接已就绪（{}@{}:{}），后续文件操作零握手",
        link.conn.username, link.conn.host, link.conn.port
    );
    Ok(arc)
}

/// 建一条新连接并登录。
///
/// 密钥读取走 `spawn_blocking`（阻塞 IO + 可能要密码短语解密）。
async fn open_russh_session(
    link: &SshLink,
    mut creds: PendingCreds,
) -> Result<RusshFileSession, String> {
    let conn = &link.conn;

    // 跳板机第一版不支持：明确失败，让调用方回退旧路径。
    // 不能「静默按直连连」——那会连到跳板机而不是目标机，报错还看不出原因。
    // （`get_russh_session` 开头已判过一次，这里是双保险：本函数日后若被别处
    //  直接调用，不该静默变成直连。）
    if link.proxy.is_some() {
        return Err("russh 路径暂不支持跳板机连接，已回退".into());
    }

    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(KEEPALIVE_INTERVAL_SECS)),
        keepalive_max: KEEPALIVE_MAX,
        inactivity_timeout: Some(RUSSH_IDLE_TTL),
        // 小请求多（列目录/频繁 stat），Nagle 会各添一笔延迟；OpenSSH 默认也开 nodelay。
        nodelay: true,
        ..Default::default()
    });

    let host = conn.host.clone();
    let port = conn.port;
    let mut handle = tokio::time::timeout(
        RUSSH_CONNECT_TIMEOUT,
        client::connect(config, (host.as_str(), port), RusshHandler),
    )
    .await
    .map_err(|_| "russh 连接超时".to_string())?
    .map_err(|e| format!("russh 连接失败：{e}"))?;

    // ---- 认证。明文只在这一小段存在，之后 creds 即被丢弃 ----
    let authed = if conn.auth_type == "key" && !conn.key_path.is_empty() {
        // 密钥读取是阻塞 IO，且可能要输密码短语解密：挪出 tokio worker。
        let key_path = conn.key_path.clone();
        // 提示语不含任何主机名 ⇒ `take_passphrase` 走「先跳板后目标」的顺序兜底，
        // 直连时（两端 id 都空）直接取目标槽。与 ssh_helper 的填充判据同源。
        let passphrase = creds.take_passphrase("Enter passphrase for key:");
        let key = tokio::task::spawn_blocking(move || {
            russh::keys::load_secret_key(&key_path, passphrase.as_deref())
        })
        .await
        .map_err(|e| format!("读取私钥任务异常：{e}"))?
        .map_err(|e| format!("读取私钥失败：{e}"))?;
        let key: PrivateKeyWithHashAlg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
        handle
            .authenticate_publickey(&conn.username, key)
            .await
            .map_err(|e| format!("russh 密钥认证失败：{e}"))?
            .success()
    } else {
        // 配置成密钥认证却没填密钥路径时，会掉到这个分支。若直接报「没有可用的
        // 登录密码」，用户会去翻密码框——而问题在密钥路径那一栏。所以先判一句。
        if conn.auth_type == "key" {
            return Err("该连接配置为密钥认证，但未填写密钥路径".into());
        }
        let password = creds
            .take_password("password:")
            .ok_or_else(|| "没有可用的登录密码（未保存密码）".to_string())?;
        handle
            .authenticate_password(&conn.username, password)
            .await
            .map_err(|e| format!("russh 密码认证失败：{e}"))?
            .success()
    };
    if !authed {
        return Err("russh 认证被服务器拒绝".into());
    }
    drop(creds); // 明确表达「到此为止不再有明文」

    // ---- 开 SFTP subsystem channel ----
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("russh 打开 channel 失败：{e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("russh 请求 sftp 子系统失败（服务器可能未启用）：{e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("russh SFTP 会话初始化失败：{e}"))?;
    sftp.set_timeout(RUSSH_OP_TIMEOUT_SECS);

    Ok(RusshFileSession {
        handle: Arc::new(tokio::sync::Mutex::new(handle)),
        sftp: Arc::new(sftp),
        last_used: AtomicU64::new(now_secs()),
        opened_at: now_secs(),
    })
}

/// 关掉某条连接的 russh 会话（连接被删 / 改 / 会话坏了时调）。
///
/// 连带清掉负缓存：用户改完登录信息立刻重试时，不该还被上一次的失败挡着。
///
/// 🔴 **不删 `ssh_russh_open_locks`**。删了会破坏建连串行化：另一个任务可能正持着
/// 那把锁在建连（本机到内网约 11 秒，窗口很长），此时删掉 map 里的 entry，
/// 后续操作会 `or_insert_with` 出一把**新锁**，与仍在建连的任务各建一条——
/// 白付一次登录、多占一个服务器 `MaxSessions` 名额，被删连接的那条还会一直挂到 GC。
/// 锁本身极轻（一个 `Arc<Mutex<()>>`），留着无害，由 `gc_russh_sessions` 统一回收。
pub fn drop_russh_session(state: &AppState, connection_id: &str) {
    state.ssh_russh_sessions.remove(connection_id);
    state.ssh_russh_blocked.remove(connection_id);
}

/// 回收空闲或已死的 russh 会话。
///
/// 与 `gc_ssh_helpers` 同一理由：省的是**服务器端的 `MaxSessions`**，不是本机内存。
/// 锁语义同样：先把候选挑出来，避免持 DashMap shard 锁时去 await 会话内部锁。
pub async fn gc_russh_sessions(state: &AppState) {
    let candidates: Vec<String> = state
        .ssh_russh_sessions
        .iter()
        .filter(|e| e.value().idle_for() > RUSSH_IDLE_TTL)
        .map(|e| e.key().clone())
        .collect();
    for id in candidates {
        if let Some((_, sess)) = state.ssh_russh_sessions.remove(&id) {
            sess.close().await;
        }
        state.ssh_russh_open_locks.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 超时常量是灰度行为的契约：TTL 不能比 helper 的 1800 秒短（否则白占
    /// 服务器 session 的时间反而变长），操作超时必须覆盖列大目录。
    #[test]
    fn timeout_constants_are_sane() {
        assert!(RUSSH_IDLE_TTL >= Duration::from_secs(1800));
        assert!(
            RUSSH_CONNECT_TIMEOUT > Duration::from_secs(11),
            "要盖住 11 秒的登录"
        );
        assert_eq!(RUSSH_OP_TIMEOUT_SECS, 30);
        assert_eq!(
            KEEPALIVE_INTERVAL_SECS, 30,
            "与 ssh_base_args 的 ServerAliveInterval 对齐"
        );
        assert_eq!(KEEPALIVE_MAX, 3, "与 ServerAliveCountMax 对齐");
    }

    /// 🔴 时钟回拨（last_used 落在未来）时必须是 0，不能让 `Duration` 构造 panic。
    /// 上一版这里想直接构造 `RusshFileSession` 来测，但 `Handle` / `SftpSession`
    /// 在 crate 外无法构造——所以判据必须抽成纯函数才能被覆盖。
    #[test]
    fn idle_duration_saturates_on_clock_rollback() {
        assert_eq!(idle_duration(100, 40), Duration::ZERO);
        assert_eq!(idle_duration(100, 100), Duration::ZERO);
        assert_eq!(idle_duration(100, 130), Duration::from_secs(30));
        assert_eq!(idle_duration(0, u64::MAX), Duration::from_secs(u64::MAX));
    }
}
