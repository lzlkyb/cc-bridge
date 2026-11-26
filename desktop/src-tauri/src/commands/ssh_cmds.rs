//! SSH 终端的 IPC 命令：可用性检测、连接、输入、缩放、断开、列表读取，
//! 以及密钥登录 + SFTP 文件传输（list/get/put/mkdir/remove）。
//!
//! 范围：人在面板手动操作交互终端 + 远程 Linux 登录（密码 / 私钥 + 密码短语），
//! 并支持在面板内做 SFTP 文件传输。后端用系统自带 OpenSSH（Windows/macOS 自带）
//! + `portable_pty` 提供的 PTY（Windows=ConPTY / Unix=pty），输出经
//! `app.emit(ssh_output_event(&sid), ...)` 事件流推前端（每会话一个事件名，并按一帧合批）；
//! SFTP 传输复用同一套「PTY + 凭据自动填充」机制，
//! 只是把输出捕获成结构化结果而非流式推屏。
//!
//! 🔴 安全：SSH 凭据只经 Tauri IPC 写入本机（`save_config` patch），绝不注册为 MCP 工具，
//! 不向远程 Claude Code 暴露（对齐 `external_mcp_servers` 注释，S1）。密码/密码短语以 aes-gcm
//! 密文存配置库，明文仅在「记住」自动填充那一瞬存在于内存。

use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::SshConnection;
use crate::ssh_helper::HelperSession;
use crate::ssh_proxy::PendingCreds;
use crate::state::AppState;

/// 一次终端输出增量（reader 线程持续推送）。
#[derive(Debug, Serialize, Clone)]
pub struct SshOutput {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub data: String,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<crate::ssh_output::OutputReceipt>,
}

/// ssh 进程退出（EOF）通知，前端据此清掉终端「已连接」态。
#[derive(Debug, Serialize, Clone)]
pub struct SshClosed {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

/// 连接早期失败通知：ssh 进程在「失败宽限期」内自行退出（非主动断开），
/// 通常是主机不可达 / 端口错 / 认证失败。前端据此立即弹「连接失败」而非静默黑屏。
/// 与 `SshClosed` 互斥：早期失败只发本事件，不发 `SshClosed`。
#[derive(Debug, Serialize, Clone)]
pub struct SshConnectFailed {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// 可读失败原因（中文）。
    pub reason: String,
}

/// `ssh_check` 的返回：ssh 是否可用 + 路径 + 不可用时的安装指引。
#[derive(Debug, Serialize)]
pub struct SshCheckResult {
    pub available: bool,
    pub path: Option<String>,
    #[serde(rename = "installHint")]
    pub install_hint: Option<String>,
}

/// 前端读取 SSH 配置（开关 + 连接列表）。写经 `save_config` patch，读走专用命令，
/// 与 `mcp_bridge_list` 模式一致。
#[derive(Debug, Serialize)]
pub struct SshConnectionList {
    pub enabled: bool,
    pub connections: Vec<SshConnection>,
}

/// `ssh_sftp_list` 的单条远程文件/目录条目。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshFileEntry {
    /// 文件名（**纯名字**，不含 ` -> target` 后缀；软链目标在 `link_target`）。
    pub name: String,
    /// 是否为目录。
    pub is_dir: bool,
    /// 字节大小（目录为 0）。
    pub size: u64,
    /// 修改时间（Unix 秒）。
    pub mtime: i64,
    /// 是否为软链接。
    pub is_symlink: bool,
    /// 软链目标（readlink 的原始返回值，可能是相对路径）；非软链为 None。
    ///
    /// russh 路径列目录时补齐；旧 `ls -la` 路径从 ` -> ` 后缀拆出（零额外开销）。
    pub link_target: Option<String>,
    /// 软链**目标**是否为目录（跟随 stat）。仅 russh 路径补齐；旧路径恒 false
    /// （双击软链进编辑器、读失败有出路，与加此字段前的行为一致）。
    ///
    /// 为什么前端需要它：readdir 是 lstat 语义，软链到目录也报 `is_dir=false`，
    /// 不补这个字段，双击 `sites-enabled/default` 这类链接会进编辑器然后读失败。
    pub link_target_is_dir: bool,
    /// 文件属主 uid（SFTP attrs）。`None` = 服务器没给（异常实现）或旧路径，
    /// 前端据此**放弃预判**而不是猜——猜会把能读的文件标成不能读。
    ///
    /// 为什么需要：2026-11-24 事故里文件属 `claude-svc`、mode 0600，用户列目录
    /// 看得见、一打开就 Errno 13（ACL mask 把授权剥成 effective `---`）。预标
    /// 「你不可读」能省掉这一轮「以为能开 → 打开失败 → 以为文件坏了」的误解。
    pub uid: Option<u32>,
    /// 文件属组 gid（同 `uid`）。
    pub gid: Option<u32>,
    /// 权限位（`0o7777` 语义，**已剥掉 `S_IF*` 类型位**，与 `setstat` 的 `perm_bits`
    /// 同一形状）。`None` 同 `uid`。
    pub mode: Option<u32>,
}

/// `ssh_connect` 入参。
#[derive(serde::Deserialize)]
pub struct SshConnectArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub rows: u16,
    pub cols: u16,
    /// 本次终端连接专用，不写连接配置，也不传给文件操作或恢复快照。
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

/// 探测系统 ssh 路径（不抛错，缺失返回 None）。
///
/// Windows：先 `System32\OpenSSH\ssh.exe`，回退 `SysWOW64\OpenSSH\ssh.exe`
/// （旧 Win10 / Server / 精简镜像可能只在其一）。
/// macOS / Linux：永远自带 `/usr/bin/ssh`。
/// Windows 下的 ssh 候选路径，按优先级排列。
///
/// 顺序即偏好：系统自带 → 微软 MSI 独立安装 → Git for Windows 自带 → PATH。
/// 之所以还要 Git 这一档：2026-10-29 实机遇到 `System32\OpenSSH` 下整套 8.1
/// （ssh/scp/ssh-keygen/ssh-agent）都存在、签名有效，但**执行即 exit 255 且零输出**；
/// 而 Git 自带的 OpenSSH 10.x 在同一台机器上完全正常。没有这一档，用户机器上系统
/// ssh 一坏，整个终端功能就全废，还只会看到「进程过早退出」这种误导信息。
#[cfg(windows)]
fn ssh_candidates() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    v.push(
        PathBuf::from(&sys)
            .join("System32")
            .join("OpenSSH")
            .join("ssh.exe"),
    );
    v.push(
        PathBuf::from(&sys)
            .join("SysWOW64")
            .join("OpenSSH")
            .join("ssh.exe"),
    );
    for key in ["ProgramFiles", "ProgramW6432"] {
        if let Ok(pf) = std::env::var(key) {
            let pf = PathBuf::from(pf);
            v.push(pf.join("OpenSSH").join("ssh.exe"));
            v.push(pf.join("Git").join("usr").join("bin").join("ssh.exe"));
        }
    }
    if let Ok(pf) = std::env::var("ProgramFiles(x86)") {
        v.push(
            PathBuf::from(pf)
                .join("Git")
                .join("usr")
                .join("bin")
                .join("ssh.exe"),
        );
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        v.push(
            PathBuf::from(la)
                .join("Programs")
                .join("Git")
                .join("usr")
                .join("bin")
                .join("ssh.exe"),
        );
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(';') {
            let d = dir.trim();
            if !d.is_empty() {
                v.push(PathBuf::from(d).join("ssh.exe"));
            }
        }
    }
    v
}

/// 单个候选的探测等待上限。健康 ssh 的 `-V` 是毫秒级，给到 1.5s 已极端宽松。
///
/// 仅 Windows 探测链路使用；Unix 侧 `find_ssh` 直接走 `/usr/bin/ssh`，
/// 编译期裁掉后本常量不可达，放行 dead_code（Windows 侧仍保持 lint 活跃）。
#[cfg_attr(not(windows), allow(dead_code))]
const SSH_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// 全部候选的探测总预算。候选集合里含 PATH 里的每个目录，数量不可控，
/// 必须给个整体上界（见 `find_ssh` 的说明）。
///
/// 仅 Windows 探测链路使用（同 `SSH_PROBE_TIMEOUT`，Unix 侧放行 dead_code）。
#[cfg_attr(not(windows), allow(dead_code))]
const SSH_PROBE_TOTAL_BUDGET: Duration = Duration::from_millis(3000);

/// 探测某个 ssh **是否真能执行**（`exists()` 远远不够，见 `ssh_candidates` 注释）。
///
/// `-V` 是最轻的自检：不联网、不读 config、不等终端，健康程序立刻返回 0。
/// 🔴 必须带 `CREATE_NO_WINDOW`：Tauri 是 GUI 进程，起控制台子程序会闪黑框。
/// 🔴 必须有超时：`status()` 会一直等到子进程退出，遇上「启动就挂住」的坏程序
/// （安全软件拦截的常见形态）会把调用线程永久堵死——宁可判它不可用。
///
/// `overall` 是调用方给的总预算，取它与「现在 + 单候选上限」中更早的那个作截止时间。
#[cfg(windows)]
fn ssh_runnable(path: &Path, overall: Instant) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = std::process::Command::new(path);
    cmd.arg("-V")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let deadline = (Instant::now() + SSH_PROBE_TIMEOUT).min(overall);
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return st.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return false,
        }
    }
}

/// 按顺序挑第一个**既存在又能执行**的候选。
///
/// 这次的线上故障就出在这个循环里：旧实现只判 `exists()`，于是「文件在、但执行
/// 即 exit 255 零输出」的 ssh 被当成可用程序，连接全程黑屏且报「进程过早退出」。
/// 抽成纯函数是为了把它测住——`exists` / `runnable` / `expired` 全由调用方注入，
/// 断言不依赖本机装了哪些 ssh（CI 上也跑得动）。
///
/// - 同一路径只探测一次（PATH 里同一目录重复出现很常见）
/// - `expired()` 为真时立刻收手，剩下的候选不再探测（避免总耗时不可控）
///
/// Unix 侧 `find_ssh` 不走候选探测（直接用 `/usr/bin/ssh`），本函数在 lib
/// target 不可达；测试 target 全平台都在用它（见本文件测试模块），
/// 故只对非 Windows 放行 dead_code，Windows 侧保持 lint 活跃。
#[cfg_attr(not(windows), allow(dead_code))]
fn pick_runnable(
    candidates: impl IntoIterator<Item = PathBuf>,
    exists: impl Fn(&Path) -> bool,
    runnable: impl Fn(&Path) -> bool,
    expired: impl Fn() -> bool,
) -> Option<PathBuf> {
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for cand in candidates {
        if expired() {
            break;
        }
        if !seen.insert(cand.clone()) || !exists(&cand) {
            continue;
        }
        if runnable(&cand) {
            return Some(cand);
        }
        // 存在但跑不起来：继续找下一个候选，别把坏程序当成「已安装」。
        #[cfg(debug_assertions)]
        eprintln!("[SSH] 跳过不可执行的 ssh={:?}", cand);
    }
    None
}

/// 探测可用的 ssh 路径（不抛错，一个都不可用返回 None）。
///
/// Windows：按 `ssh_candidates` 顺序挑第一个**能执行**的
/// （旧 Win10 / Server / 精简镜像可能只在其中一个目录）。
/// macOS / Linux：永远自带 `/usr/bin/ssh`。
///
/// 结果缓存：探测要起子进程（约几十毫秒），`ssh_check` / 连接 / 传输都会反复问，
/// 不缓存等于每次交互都多一次进程创建。代价是「用户修好 ssh 后需重启应用」。
///
/// 🔴 调用方都是 async 上下文（`ssh_check` / `ssh_connect` / SFTP），这里的阻塞会
/// 占住 tokio 工作线程，所以整个探测必须**有总预算**：候选再多、再异常也不能
/// 累计成十几秒卡顿。超预算直接放弃剩余候选（判不可用，报错比卡死好）。
pub(super) fn find_ssh() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::sync::OnceLock;
        static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
        CACHE
            .get_or_init(|| {
                let deadline = Instant::now() + SSH_PROBE_TOTAL_BUDGET;
                let picked = pick_runnable(
                    ssh_candidates(),
                    |p| p.exists(),
                    |p| ssh_runnable(p, deadline),
                    || Instant::now() >= deadline,
                );
                #[cfg(debug_assertions)]
                if let Some(p) = &picked {
                    eprintln!("[SSH] 选用 ssh={:?}", p);
                }
                picked
            })
            .clone()
    }
    #[cfg(not(windows))]
    {
        let p = PathBuf::from("/usr/bin/ssh");
        if p.exists() {
            Some(p)
        } else {
            // 兜底：交给 PATH 解析（CommandBuilder::new("ssh") 会用系统 shell 找）。
            None
        }
    }
}

/// 解析连接凭据为「待自动填充的密码 / 密码短语」。
///
/// - 密码认证：记住密码 → 解密出明文密码；否则 None（人在终端里手输）。
/// - 密钥认证：记住密码短语 → 解密出明文密码短语；否则 None（手输）。
///
/// 解密失败直接上抛，不静默回退到空密，避免把"解密失败"伪装成"密码错误"。
fn resolve_secrets(
    conn: &SshConnection,
    data_dir: &std::path::Path,
) -> Result<(Option<String>, Option<String>), String> {
    let key = crate::ssh_crypto::load_or_create_key(data_dir)
        .map_err(|e| format!("加载 SSH 密钥失败：{e}"))?;
    if conn.auth_type == "key" {
        // 密码短语（key 自身）
        let pp = if conn.remember_passphrase && !conn.encrypted_passphrase.is_empty() {
            Some(
                crate::ssh_crypto::decrypt_password(&key, &conn.encrypted_passphrase)
                    .map_err(|e| format!("解密密钥密码短语失败：{e}"))?,
            )
        } else {
            None
        };
        // 密钥认证失败时 ssh 可能 fallback 到密码登录：若用户也记住了登录密码，
        // 一并解出，供 reader 线程在出现 `password:` 提示时自动填充。
        let pw = if conn.remember_password && !conn.encrypted_password.is_empty() {
            Some(
                crate::ssh_crypto::decrypt_password(&key, &conn.encrypted_password)
                    .map_err(|e| format!("解密密码失败：{e}"))?,
            )
        } else {
            None
        };
        Ok((pw, pp))
    } else {
        if conn.remember_password && !conn.encrypted_password.is_empty() {
            let pw = crate::ssh_crypto::decrypt_password(&key, &conn.encrypted_password)
                .map_err(|e| format!("解密密码失败：{e}"))?;
            Ok((Some(pw), None))
        } else {
            Ok((None, None))
        }
    }
}

/// 解析「目标 + 可选跳板」两段的凭据，合成一个派发器。
///
/// 跳板机的凭据来自**被引用那条连接自己**的加密存储，不新增任何落盘面。
pub(super) fn resolve_link_secrets(
    link: &SshLink,
    data_dir: &std::path::Path,
) -> Result<PendingCreds, String> {
    let (pw, pp) = resolve_secrets(&link.conn, data_dir)?;
    let mut creds = PendingCreds::direct(&link.conn, pw, pp);
    if let Some(j) = &link.jump {
        let (jpw, jpp) = resolve_secrets(j, data_dir)?;
        creds = creds.with_jump(j, jpw, jpp);
    }
    Ok(creds)
}

/// A newly entered credential overrides saved ciphertext for this connection only.
/// In particular, it must allow replacing an unreadable old credential without decrypting it.
pub(super) fn resolve_connect_secrets(
    link: &SshLink,
    data_dir: &Path,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<PendingCreds, String> {
    let mut target = link.conn.clone();
    let password = password.filter(|v| !v.is_empty());
    let passphrase = passphrase.filter(|v| !v.is_empty());
    if password.is_some() && target.auth_type != "key" {
        target.remember_password = false;
    }
    if passphrase.is_some() && target.auth_type == "key" {
        target.remember_passphrase = false;
    }
    let (pw, pp) = resolve_secrets(&target, data_dir)?;
    let (pw, pp) = if target.auth_type == "key" {
        (pw, passphrase.or(pp))
    } else {
        (password.or(pw), pp)
    };
    let mut creds = PendingCreds::direct(&target, pw, pp);
    if let Some(jump) = &link.jump {
        let (pw, pp) = resolve_secrets(jump, data_dir)?;
        creds = creds.with_jump(jump, pw, pp);
    }
    Ok(creds)
}

/// 一次操作的完整目标：目标连接 + 可选跳板机。
///
/// 把两者绑在一起传，而不是给 `ssh_base_args` / `run_scp` / `spawn_capture` 一路
/// 都加一个 `Option<&SshConnection>` 参数——后者一旦在某个调用点忘了传，表现是
/// **静默地走直连**（连不上，且从报错里看不出为什么）。
#[derive(Clone)]
pub(super) struct SshLink {
    pub(super) conn: SshConnection,
    pub(super) jump: Option<SshConnection>,
    /// 已拼好的 `-o ProxyCommand=` 的值；None = 直连。
    ///
    /// 建连接时就拼好而不是每次用到再拼：拼接会因为非法字符失败，失败必须
    /// 在一开始就报出来，而不是埋在某一条传输路径里。
    /// `pub(super)`：`ssh_russh_cmds` 要据此判断「这条连接带跳板，内置协议栈
    /// 第一版不支持，明确失败并回退」——不能静默按直连连（那会连到跳板机）。
    pub(super) proxy: Option<String>,
}

fn same_login(a: &SshConnection, b: &SshConnection) -> bool {
    a.id == b.id
        && a.host == b.host
        && a.port == b.port
        && a.username == b.username
        && a.auth_type == b.auth_type
        && a.key_path == b.key_path
        && a.proxy_jump_id == b.proxy_jump_id
        && a.remember_password == b.remember_password
        && a.encrypted_password == b.encrypted_password
        && a.remember_passphrase == b.remember_passphrase
        && a.encrypted_passphrase == b.encrypted_passphrase
}

impl SshLink {
    pub(super) fn same_login(&self, other: &Self) -> bool {
        same_login(&self.conn, &other.conn)
            && match (&self.jump, &other.jump) {
                (Some(a), Some(b)) => same_login(a, b),
                (None, None) => true,
                _ => false,
            }
    }

    /// Pin both hops before any await, so editing a saved connection cannot redirect an in-flight token.
    pub(super) fn from_config(
        config: &crate::config::BridgeConfig,
        id: &str,
    ) -> Result<Self, String> {
        let conn = config
            .ssh_connections
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or("服务器不存在")?;
        let jump = if conn.proxy_jump_id.is_empty() {
            None
        } else {
            Some(
                config
                    .ssh_connections
                    .iter()
                    .find(|c| c.id == conn.proxy_jump_id)
                    .cloned()
                    .ok_or("跳板机不存在")?,
            )
        };
        Self::new(conn, jump)
    }
    pub(super) fn new(conn: SshConnection, jump: Option<SshConnection>) -> Result<Self, String> {
        // 所有生产路径（终端 / scp / 端口转发 / 会话连接）都经这一个构造器，
        // 身份校验放这里才叫「堵住」；保存路径另有一次同样的校验，只为把错误
        // 提前到用户点「保存」的那一刻，而不是点「连接」时。
        validate_identity(&conn)?;
        if let Some(j) = &jump {
            validate_identity(j)?;
        }
        let proxy = match &jump {
            None => None,
            Some(j) => {
                // ProxyCommand 里跑的是 **ssh**（即使外层是 scp），所以这里取的是 ssh 路径。
                let ssh = find_ssh()
                    .ok_or_else(|| "未检测到系统 OpenSSH 客户端，无法经跳板机连接".to_string())?;
                Some(crate::ssh_proxy::proxy_command_value(&ssh, j)?)
            }
        };
        Ok(Self { conn, jump, proxy })
    }

    /// 直连（无跳板）。仅测试用：生产路径上的连接一律经 `fetch_link` 构造，
    /// 那里会一并解析跳板机——给生产代码留一个「能绕过跳板解析」的构造器反而是陷阱。
    #[cfg(test)]
    fn direct(conn: SshConnection) -> Self {
        Self {
            conn,
            jump: None,
            proxy: None,
        }
    }
}

/// 用户名允许的字符集：字母数字 + `.` `-` `_`。
///
/// 为什么必须校验：`format!("{}@{}", username, host)` 是作为**一个参数**交给 ssh 的，
/// 而 ssh 会把 `-` 开头的目标当**选项**解析（实测 `ssh -G "-oProxyCommand=calc @h"`
/// 落到 usage，见 `rejects_dash_prefixed_username`）。host 一侧有
/// `ssh_tunnel::host_ok` 守着，username 此前完全没有校验，而连接也可以从导入文件
/// 进来、绕过 UI 输入限制。
///
/// 空用户名**放行**：那是「交给 ssh 用默认值」的既有语义（表单未做必填），
/// 这里只拦能改变参数性质的形态，不做顺手加严。
fn identity_ok(user: &str) -> bool {
    !user.starts_with('-')
        && user
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn validate_identity(conn: &SshConnection) -> Result<(), String> {
    if identity_ok(&conn.username) {
        return Ok(());
    }
    Err(format!(
        "用户名「{}」含有不支持的字符：只能用字母、数字、点、下划线和连字符，且不能以 - 开头",
        conn.username
    ))
}

/// 拼 ssh/scp 通用连接选项。`port_flag` 区分 ssh 的 `-p` 与 scp 的 `-P`。
/// 密钥认证时追加 `-i <key_path>`（仅当路径非空）。
///
/// 无跳板时（`link.proxy == None`）输出与加跳板机功能之前**逐字节一致**，
/// 老连接零影响（见本文件底部的 `direct_args_unchanged_by_proxy_support` 用例）。
pub(super) fn ssh_base_args(link: &SshLink, port_flag: &str) -> Vec<String> {
    let conn = &link.conn;
    let mut v = vec![
        "-o".into(),
        "ServerAliveInterval=30".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        port_flag.into(),
        conn.port.to_string(),
    ];
    if let Some(p) = &link.proxy {
        v.push("-o".into());
        v.push(format!("ProxyCommand={p}"));
    }
    if conn.auth_type == "key" && !conn.key_path.is_empty() {
        v.push("-i".into());
        v.push(conn.key_path.clone());
        // 只认指定的私钥，避免 ssh-agent 里其它 key 被先尝试触发
        // `Too many authentication failures` 或误用错误 key。
        v.push("-o".into());
        v.push("IdentitiesOnly=yes".into());
    }
    v
}

/// 探测系统 scp 路径（与 find_ssh 同目录）。SFTP 的 get/put 用 scp 实现。
pub(super) fn find_scp() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        for sub in ["System32", "SysWOW64"] {
            let p = PathBuf::from(&sys)
                .join(sub)
                .join("OpenSSH")
                .join("scp.exe");
            if p.exists() {
                return Some(p);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        let p = PathBuf::from("/usr/bin/scp");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
}

/// 判断一次失败（或一段输出）是不是「对端不认识这个选项」。
///
/// GNU / BSD 的 `ls`、新旧 OpenSSH 的 `scp` 都靠这个判定做降级。
pub(super) fn is_unknown_option_err(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("unknown option")
        || m.contains("illegal option")
        || m.contains("invalid option")
        || m.contains("unrecognized option")
        || m.contains("usage: scp")
}

/// 本机 scp 是否支持 `-s`（强制 SFTP 协议）。**探测一次，进程内缓存。**
///
/// 🔴 不能每次传输都先试一遍 `-s`：不支持时那一次会先跑完整的 TCP + 认证
/// 握手才失败，等于把每次上传/下载的握手次数翻倍。
/// 本机 OpenSSH_for_Windows_8.1p1 实测 `scp -s` → `unknown option -- s`，
/// 即长期走回退路径，那一次白跑的握手完全是浪费。
///
/// 探测手段：不带参数跑 scp 会打印 usage 并退出，usage 里的短选项簇列全了它认识的 flag
/// （8.1 是 `[-346BCpqrTv]`，9.x 是 `[-346ABCOpqRrsTv]`）。**不建立任何网络连接**，
/// 代价只是一次本地进程启动。
fn scp_supports_sftp_protocol(scp: &PathBuf) -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| match std::process::Command::new(scp).output() {
        Ok(o) => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            usage_lists_short_flag(&text, 's')
        }
        // 跑不起来就当不支持，走回退路径（那条路径在所有版本上都能用）。
        Err(_) => false,
    })
}

/// 从 usage 文本里的首个 `[-xxx]` 短选项簇里找某个 flag。
fn usage_lists_short_flag(usage: &str, flag: char) -> bool {
    usage
        .split_once("[-")
        .and_then(|(_, rest)| rest.split_once(']'))
        .is_some_and(|(cluster, _)| cluster.contains(flag))
}

/// 拼 scp 的远端端点 `user@host:path`。
///
/// 🔴 `quote_for_shell` 不是风格选择，两种协议对路径的处理是相反的：
/// - **遗留 SCP 协议**：远程路径由远端 shell 展开。不引则 `a b.txt` 被拆成两个参数
///   ——这正是带空格文件名传不了的原因；同文件的 `ls`/`mkdir`/`rm` 早就引了，
///   唯独 scp 这两处漏了。
/// - **`-s`（SFTP 协议）**：路径按字面处理，引了反而会让引号变成文件名的一部分。
pub(super) fn scp_endpoint(conn: &SshConnection, remote: &str, quote_for_shell: bool) -> String {
    let path = if quote_for_shell {
        shell_quote(remote)
    } else {
        remote.to_string()
    };
    format!("{}@{}:{}", conn.username, conn.host, path)
}

/// 一次 scp 传输的目标描述。把 remote/local/方向收成一体，
/// 免得 `run_scp` 参数表膨胀到 clippy 都看不下去（too_many_arguments）。
pub(super) struct ScpJob<'a> {
    pub(super) link: &'a SshLink,
    pub(super) remote: &'a str,
    pub(super) local: &'a str,
    /// true = 本机→远端，false = 远端→本机。
    pub(super) upload: bool,
}

/// 跑一次 scp。
///
/// 优先用 `-s` 强制 SFTP 协议：遗留 SCP 协议上远程路径会被远端 shell 展开
/// （CVE-2020-15778 一类），下载方向还有恶意服务端投放额外文件的历史问题
/// （CVE-2019-6111），而这里的远程路径是用户在面板里选的**远端文件名**
/// （列目录产出的条目，曾经来自 `parse_ls` 解析的 `ls -la` 输出）。
/// 不支持时回退到遗留协议，并**改用 shell 引号**保护路径。
///
/// 不传 `-q`：它会把进度条**和** ssh 的警告/诊断信息一起关掉，失败时错误几乎是空的；
/// 前端 `cleanErr` 本来就是为剔掉进度条噪声写的，噪声交给它处理。
pub(super) fn run_scp(
    scp: &PathBuf,
    job: ScpJob<'_>,
    creds: PendingCreds,
    hooks: TransferHooks,
) -> Result<(), String> {
    const SCP_TIMEOUT: Duration = Duration::from_secs(600);
    // `no_strict` = 遗留协议下载时带 `-T`（关掉 strict filename check）。
    // 🔴 远端 shell 会剥掉路径引号，本地 scp **收到的**文件名与**请求的**带引号名
    // 不一致，这道检查（CVE-2019-6111 缓解）会直接拒收——本机 OpenSSH 8.1 实测，
    // 每一次下载都秒失败：`protocol error: filename does not match request`。
    // 下载目标名由本端指定（`local.ccbpart` 临时名，传完才 rename），远端发来的
    // 名字不会被用于落盘，关掉检查的风险可控。
    let build = |sftp_mode: bool, no_strict: bool| -> Vec<String> {
        let mut a: Vec<String> = Vec::new();
        if sftp_mode {
            a.push("-s".into());
        } else if no_strict && !job.upload {
            a.push("-T".into());
        }
        a.extend(ssh_base_args(job.link, "-P"));
        let endpoint = scp_endpoint(&job.link.conn, job.remote, !sftp_mode);
        if job.upload {
            a.push(job.local.to_string());
            a.push(endpoint);
        } else {
            a.push(endpoint);
            a.push(job.local.to_string());
        }
        a
    };

    if scp_supports_sftp_protocol(scp) {
        match spawn_capture(
            scp,
            &build(true, false),
            creds.clone(),
            SCP_TIMEOUT,
            hooks.clone(),
        ) {
            Ok(_) => return Ok(()),
            // 探测说支持却仍报未知选项：探测判错了，退回遗留协议再试一次。
            Err(e) if is_unknown_option_err(&e) => {}
            Err(e) => return Err(e),
        }
    }
    match spawn_capture(
        scp,
        &build(false, true),
        creds.clone(),
        SCP_TIMEOUT,
        hooks.clone(),
    ) {
        Ok(_) => Ok(()),
        // scp 7.x 不认识 `-T`——但它也没有 strict filename check，去掉重跑即可。
        Err(e) if is_unknown_option_err(&e) => {
            spawn_capture(scp, &build(false, false), creds, SCP_TIMEOUT, hooks).map(|_| ())
        }
        Err(e) => Err(e),
    }
}

/// 把路径包成单引号并转义内部单引号，避免远程命令注入。
pub(super) fn shell_quote(p: &str) -> String {
    format!("'{}'", p.replace('\'', "'\\''"))
}

/// 凭据自动填充的**待命窗口**。
///
/// 🔴 这是安全边界，不是性能调参。原实现用「200 个不匹配的输出块」计数，
/// 而那个量与「认证阶段」没有任何关系：`resolve_secrets` 在密钥认证时也会解出
/// 登录密码（作为 fallback），而密钥认证成功时密码提示**永远不会出现**——
/// 于是密码会在**已经登录的交互 shell 里**继续待命，直到用户敲够 200 块输出。
/// 期间任何一块含 `password:` 的远程输出（`grep password: *`、sudo 提示、日志）
/// 都会把明文密码打进会话；PTY 会回显，明文随即进入终端滚动区、`ssh_output`
/// 事件与远程 shell history。
///
/// 认证要么在几秒内完成、要么就是失败了，用时间窗口才是对的语义。
pub(super) const CREDENTIAL_FILL_WINDOW: Duration = Duration::from_secs(30);

/// 剥掉 VT 转义序列（CSI / OSC / 两字节 ESC 序列），只留正文。
///
/// 🔴 为什么必须有它：密码提示是**子 ssh 进程**打到继承控制台上的，而 Windows
/// 的 ConPTY 会把控制台状态变化（清屏、光标、以及 OpenSSH for Windows 设置的
/// **控制台标题**）一并转译成转义序列塞进输出流。实测一段提示长这样：
///
/// ```text
/// \x1b[2J\x1b[m\x1b[Hlizuliang@host's password:\x1b[1C\x1b]0;C:\...\scp.exe\x07\x1b[?25h
/// ```
///
/// 提示**不以冒号结尾**（后面跟着 `\x1b[1C`、设标题 OSC 和 `\x1b[?25h`），
/// 「尾部冒号」判据永远不命中 → 自动填密码静默失效 → 一次性传输路径（scp）
/// 没有手输的机会，表现为进度条永远停在「连接中」，直到 600s 超时。
pub(super) fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match it.next() {
            // CSI：参数字节 0x30–0x3F、中间字节 0x20–0x2F，终止字节 0x40–0x7E。
            Some('[') => loop {
                match it.next() {
                    None => break,
                    Some(n) if ('@'..='~').contains(&n) => break,
                    _ => {}
                }
            },
            // OSC：到 BEL（\x07）或 ST（ESC \）为止。
            Some(']') => loop {
                match it.next() {
                    None | Some('\x07') => break,
                    Some('\x1b') => {
                        it.next();
                        break;
                    }
                    _ => {}
                }
            },
            // 其余两字节转义（\x1bM、\x1b7、\x1b= 之类）：丢掉引入符即可。
            Some(_) => {}
            None => {}
        }
    }
    out
}

/// 若这一块输出看着是**进程正阻塞等待输入的提示**，返回它的小写文本。
///
/// 判据是「去掉尾部空白后以冒号结尾」：真提示写完就阻塞等输入，所以它一定压在
/// 这一块的末尾；而 `grep password: foo.conf` 这类输出后面还跟着别的内容与换行，
/// 不会以冒号收尾。单靠 `contains("password:")` 无法区分二者——这正是原实现的漏洞。
///
/// 🔴 匹配前必须先 `strip_ansi`：ConPTY 会把控制台标题/光标状态的转义序列追加在
/// 提示后面（见 `strip_ansi` 文档），不剥掉的话尾部永远是 `\x1b[?25h` 而不是冒号。
pub(super) fn prompt_tail(chunk: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(chunk);
    let t = strip_ansi(&s);
    let t = t.trim_end();
    if t.ends_with(':') || t.ends_with('：') {
        Some(t.to_lowercase())
    } else {
        None
    }
}

/// 提示是否是**改密流程里的「设新密码」环节**（`New password:` / `Retype new password:`
/// / `确认密码：`）。
///
/// 🔴 这类提示和登录提示长得一模一样（同样冒号结尾、同样含 password），但语义相反：
/// 往里填旧密码等于**替用户把密码改成旧的**，而且换行会把这次提交坐实。
/// 密码过期强制改密时之所以没出事，只是靠「每个凭据槽只填一次、`Current password:`
/// 先把它消耗掉」这一个巧合——换个本地化提示（不以冒号结尾）这个巧合就没了，
/// 于是旧密码会被当成新密码提交。宁可不填、让用户手输。
fn password_change_prompt(t: &str) -> bool {
    const KEYS: [&str; 12] = [
        "new password",
        "retype",
        "repeat",
        "verify",
        "confirm",
        "再次",
        "重复",
        "确认",
        "重新输入",
        "新密码",
        "新密碼",
        "re-enter",
    ];
    KEYS.iter().any(|k| t.contains(k))
}

/// 判断输出块是否是**登录密码**提示（`user@host's password: ` / `密码：`）。
///
/// 改密流程的「设新密码」环节必须先排除（见 `password_change_prompt`）：
/// 那一步填进去的是**新密码**，我们手上只有旧的。
pub(super) fn password_prompt_in(chunk: &[u8]) -> bool {
    let Some(t) = prompt_tail(chunk) else {
        return false;
    };
    // 「密码短语」里含「密码」，必须先排除，否则密钥提示会被当成密码提示，
    // 把登录密码填进密码短语输入。英文侧无此问题（password 不是 passphrase 的子串）。
    if t.contains("passphrase") || t.contains("密码短语") {
        return false;
    }
    if password_change_prompt(&t) {
        return false;
    }
    t.contains("password") || t.contains("密码")
}

/// 判断输出块是否是**密钥密码短语**提示。
///
/// 真实形式是 `Enter passphrase for key '/path/id_rsa': `——注意它**不是**以
/// `passphrase:` 结尾，而是以引号路径加冒号结尾，所以锁定冒号、关键词用包含判定。
pub(super) fn passphrase_prompt_in(chunk: &[u8]) -> bool {
    prompt_tail(chunk).is_some_and(|t| t.contains("passphrase") || t.contains("密码短语"))
}

/// 传输被用户取消的错误前缀。
///
/// 🔴 用**前缀标记**而不是让前端去匹配中文文案：文案会改，前缀不会。
/// 设计稿 §4 要求「取消」「超时」「失败」三者在 UI 上可区分，靠字串包含去猜必然跑偏。
pub const ERR_CANCELLED: &str = "CCB_CANCELLED";
/// 下载目标已存在且未授权覆盖的错误前缀（同上，供前端弹覆盖确认框）。
pub const ERR_TARGET_EXISTS: &str = "CCB_TARGET_EXISTS";

/// 下载用的临时后缀。传完才 rename 到正式名。
pub(super) const PART_SUFFIX: &str = ".ccbpart";

/// 进度事件载荷。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SshTransferProgress {
    transfer_id: String,
    percent: u8,
}

/// 传输类调用的可选钩子：进度上报 + 取消。
///
/// 列目录 / mkdir / rm 用 `Default`（三个字段都是 None）——它们瞬时完成，
/// 既不需要进度也不需要取消。
#[derive(Default, Clone)]
pub(super) struct TransferHooks {
    pub(super) app: Option<AppHandle>,
    pub(super) transfer_id: Option<String>,
    pub(super) cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    pub(super) setup_input: Option<String>,
}

impl TransferHooks {
    /// 上报一次传输进度（百分比 0–100）。
    ///
    /// 抽成方法是为了让 **russh 路径与 scp 路径共用同一份事件契约**：
    /// 事件名 `ssh_transfer_progress` 与载荷字段都由这一处发出，前端只需监听一次。
    /// 没有 `app`（列目录等非传输调用用的 `Default`）时静默丢弃——那些调用
    /// 本就不该有进度。
    pub(super) fn emit_progress(&self, percent: u8) {
        let (Some(app), Some(tid)) = (&self.app, &self.transfer_id) else {
            return;
        };
        let _ = app.emit(
            "ssh_transfer_progress",
            SshTransferProgress {
                transfer_id: tid.clone(),
                percent,
            },
        );
    }
}

/// 从一块输出里取**最后一个** `NN%`。
///
/// 🔴 只认百分比，**不解析速率 / ETA 的列位**（设计稿 §5）：各版本 scp 的
/// 进度行格式不一致，百分比是唯一稳定的一项。速率与剩余时间由前端按变化率自己算。
///
/// 取最后一个而不是第一个：一块里可能堆了好几次刷新，最新那个才是当前值。
fn last_percent_in(chunk: &[u8]) -> Option<u8> {
    let s = String::from_utf8_lossy(chunk);
    let b = s.as_bytes();
    let mut found = None;
    for (i, &c) in b.iter().enumerate() {
        if c != b'%' {
            continue;
        }
        let mut start = i;
        while start > 0 && b[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start == i {
            continue; // `%` 前面没数字，不是进度
        }
        // start..i 全是 ASCII 数字，字节下标天然落在字符边界上。
        if let Ok(v) = s[start..i].parse::<u16>() {
            if v <= 100 {
                found = Some(v as u8);
            }
        }
    }
    found
}

/// 把累积输出里的**进度条刷新**折叠掉，防止长传输把内存撑爆。
///
/// 🔴 去掉 `-q` 是为了拿回 ssh 的诊断信息（`-q` 会把进度条**和**警告/诊断一起关掉，
/// 失败时错误几乎是空的），代价就是进度条会进缓冲区。scp 的进度条靠 `\r` 原地刷新、
/// 不换行，一次大文件传输能刷出几万次；不折叠的话 `captured` 会无限增长。
///
/// 只动**当前未完成行**（最后一个 `\n` 之后的部分）：只保留最后一个 `\r` 之后的内容。
/// 已换行的历史（包括所有真实错误信息）一律不动。
/// `\r` `\n` 都是 ASCII，字节下标天然落在字符边界上，不会切坏 UTF-8。
fn collapse_progress(buf: &mut String) {
    let line_start = buf.rfind('\n').map(|i| i + 1).unwrap_or(0);
    if let Some(cr) = buf[line_start..].rfind('\r') {
        buf.replace_range(line_start..line_start + cr + 1, "");
    }
}

/// 列目录 / 建目录 / 删除这类「请求-响应」操作的超时。
///
/// 本机 OpenSSH 不支持连接复用（无 ControlMaster），**每一次这类操作都是一次完整的
/// TCP + 认证握手**，慢链路上本来就要好几秒，所以给得比直觉宽。
pub(super) const SSH_ONESHOT_TIMEOUT: Duration = Duration::from_secs(30);

/// helper 建立失败后的冷却期。
///
/// 服务器禁 shell / 没有 /bin/sh 时 helper 永远建不起来，而失败不记的话
/// 每一次列目录/建目录/删除都要先白费一次完整的 TCP+认证握手。
/// 取 60 秒而不是永久：服务器配置可能被改好，不应该要重启应用才能重试。
const HELPER_BLOCK_TTL: Duration = Duration::from_secs(60);

/// 在阻塞线程池里跑一次 `spawn_capture`。
///
/// 🔴 `spawn_capture` 是**同步阻塞**的（等子进程退出 + 读到 EOF），而 tauri 的
/// `#[command] async fn` 跑在 tokio 的 worker 上。直接调等于把一个 worker 钉住最长 30 秒；
/// worker 被占满时，其它命令（包括**每敲一个字符都要走的 `ssh_input`**）会一起排队，
/// 表现就是「界面卡住 / 一直加载中」。
///
/// 传输路径（get/put）已经改用 spawn_blocking，列目录/建目录/删除当时漏了。
pub(super) async fn spawn_capture_off_runtime(
    program: PathBuf,
    args: Vec<String>,
    creds: PendingCreds,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        spawn_capture(
            &program,
            &args,
            creds,
            SSH_ONESHOT_TIMEOUT,
            TransferHooks::default(),
        )
    })
    .await
    .map_err(|e| format!("任务调度失败：{e}"))?
}

/// Windows OpenSSH needs terminal mode to forward the LF-delimited stdin frames immediately.
fn stable_setup_args(link: &SshLink, command: String) -> Vec<String> {
    let mut args = ssh_base_args(link, "-p");
    args.push("-tt".into());
    args.push(format!("{}@{}", link.conn.username, link.conn.host));
    args.push(command);
    args
}

/// Bounded, cancellable setup using the exact same credential and ProxyJump rules as SFTP.
pub(super) async fn run_stable_setup(
    state: &Arc<AppState>,
    link: &SshLink,
    script: (String, String),
    password: Option<String>,
    passphrase: Option<String>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
    if script.1.len() > 32 * 1024 {
        return Err("接入检查结果较多，请选择一个项目后重新检查。".into());
    }
    let ssh = find_ssh().ok_or("未检测到系统 OpenSSH 客户端")?;
    let creds = resolve_connect_secrets(link, &state.data_dir, password, passphrase)?;
    let args = stable_setup_args(link, script.0);
    tokio::task::spawn_blocking(move || {
        spawn_capture(
            &ssh,
            &args,
            creds,
            Duration::from_secs(45),
            TransferHooks {
                cancel: Some(cancel),
                setup_input: Some(script.1),
                ..Default::default()
            },
        )
    })
    .await
    .map_err(|e| format!("任务调度失败：{e}"))?
}

/// 在该连接的**常驻 helper 会话**上跑一条命令，返回（输出, 退出码）。
///
/// 这是列目录/建目录/删除的**快路径**：本机 OpenSSH 没有 ControlMaster，
/// 不复用的话每次都是一次完整的 TCP + 认证握手。
///
/// **任何失败都返回 Err，调用方必须退回一次性握手路径**（服务器禁 shell、
/// MaxSessions 满、远端没有 /bin/sh 都会让 helper 起不来）。helper 一旦出错就拆掉重建。
pub(super) async fn run_via_helper(
    state: &Arc<AppState>,
    link: &SshLink,
    ssh_path: &Path,
    creds: PendingCreds,
    cmd: String,
) -> Result<(String, i32), String> {
    let conn = &link.conn;
    let key = conn.id.clone();
    // 负缓存：上次起不来且还在冷却期内就直接失败，让调用方走一次性路径。
    if let Some(t) = state.ssh_helper_blocked.get(&key) {
        if t.elapsed() < HELPER_BLOCK_TTL {
            return Err("helper 会话近期建立失败，暂不重试".into());
        }
    }
    // 只取走 Arc 就立即放掉 DashMap 的 Ref：绝不能持着 shard 锁进 await。
    let existing = state.ssh_helpers.get(&key).map(|e| e.value().clone());
    let sess = match existing {
        Some(s) => s,
        None => {
            // to_path_buf 而不是 clone：`&Path` 上的 clone 克隆的是**引用**，
            // 拿进 'static 的 spawn_blocking 闭包会借用逸出。
            let ssh = ssh_path.to_path_buf();
            let args = ssh_base_args(link, "-p");
            let target = format!("{}@{}", conn.username, conn.host);
            let created = tokio::task::spawn_blocking(move || {
                HelperSession::open(
                    &ssh,
                    &args,
                    &target,
                    creds,
                    |s| password_prompt_in(s.as_bytes()),
                    |s| passphrase_prompt_in(s.as_bytes()),
                )
            })
            .await
            .map_err(|e| format!("任务调度失败：{e}"))?;
            let created = match created {
                Ok(c) => c,
                Err(e) => {
                    // 记下失败，冷却期内不再试（见 `ssh_helper_blocked`）。
                    state.ssh_helper_blocked.insert(key.clone(), Instant::now());
                    return Err(e);
                }
            };
            let arc = Arc::new(StdMutex::new(created));
            // 🔴 `get` 与插入之间有 `.await`，所以两个并发调用（例如面板刷新与
            // 拖拽上传的同名检查同时发生）都会拿到 None，各自建一条登录。
            // 用 `or_insert_with` 原子定胜负；落败的那条靠 `HelperSession` 的 Drop 关掉，
            // 否则它会永远占着服务器的 MaxSessions（默认只有 10）——而那正是本模块
            // 极力节省的东西。本段不跨 await，持 Ref 是安全的。
            let winner = state
                .ssh_helpers
                .entry(key.clone())
                .or_insert_with(|| arc.clone())
                .value()
                .clone();
            state.ssh_helper_blocked.remove(&key);
            winner
        }
    };

    let running = sess.clone();
    let res = tokio::task::spawn_blocking(move || {
        let mut h = running
            .lock()
            .map_err(|_| "helper 会话锁中毒".to_string())?;
        h.run(&cmd)
    })
    .await
    .map_err(|e| format!("任务调度失败：{e}"))?;

    // 跑坏了（超时/已退出/写失败）就拆掉，下次重建；本次交给调用方回退。
    if res.is_err() {
        state.drop_ssh_helper(&key);
    }
    res
}

/// `run_via_helper` 的阻塞版：给**本来就在 spawn_blocking 里**的调用方用
/// （批量传输的远端收尾命令 mkdir/mv/rm）。
///
/// 为什么有一份重复而不是把 `run_via_helper` 改成同步：它是列目录/读写的热路径，
/// 8 个调用方都在 await 它；而 `HelperSession::open` / `h.run` 都是阻塞调用，
/// 包在 `spawn_blocking` 里正是为了不占 tokio worker。批量传输整体跑在自己的
/// `spawn_blocking` 闭包里，再嵌一层 `spawn_blocking` 纯属浪费，直接阻塞调用即可。
/// 逻辑与 async 版逐行对应，改一边必须同步改另一边。
pub(super) fn run_via_helper_blocking(
    state: &Arc<AppState>,
    link: &SshLink,
    ssh_path: &Path,
    creds: PendingCreds,
    cmd: String,
) -> Result<(String, i32), String> {
    let conn = &link.conn;
    let key = conn.id.clone();
    if let Some(t) = state.ssh_helper_blocked.get(&key) {
        if t.elapsed() < HELPER_BLOCK_TTL {
            return Err("helper 会话近期建立失败，暂不重试".into());
        }
    }
    let existing = state.ssh_helpers.get(&key).map(|e| e.value().clone());
    let sess = match existing {
        Some(s) => s,
        None => {
            let args = ssh_base_args(link, "-p");
            let target = format!("{}@{}", conn.username, conn.host);
            let created = HelperSession::open(
                ssh_path,
                &args,
                &target,
                creds,
                |s| password_prompt_in(s.as_bytes()),
                |s| passphrase_prompt_in(s.as_bytes()),
            );
            let created = match created {
                Ok(c) => c,
                Err(e) => {
                    state.ssh_helper_blocked.insert(key.clone(), Instant::now());
                    return Err(e);
                }
            };
            let arc = Arc::new(StdMutex::new(created));
            let winner = state
                .ssh_helpers
                .entry(key.clone())
                .or_insert_with(|| arc.clone())
                .value()
                .clone();
            state.ssh_helper_blocked.remove(&key);
            winner
        }
    };

    let running = sess.clone();
    let res = {
        let mut h = running
            .lock()
            .map_err(|_| "helper 会话锁中毒".to_string())?;
        h.run(&cmd)
    };
    if res.is_err() {
        state.drop_ssh_helper(&key);
    }
    res
}

/// 在 PTY 里跑一次性命令（ssh 远程命令 / scp 传输），捕获全部输出并自动填充
/// 密码/密码短语，等待进程退出（带超时），返回捕获到的输出字符串。
///
/// 与交互终端 `ssh_connect` 共用「PTY + 凭据自动填充」机制，但输出不推屏、而是
/// 收集成字符串返回，便于 SFTP 这类「请求-响应」操作做结构化解析。
///
/// 注意它是**同步阻塞**的：在 `#[command] async fn` 里要走 `spawn_capture_off_runtime`，
/// 不要直接调。
pub(super) fn spawn_capture(
    program: &PathBuf,
    args: &[String],
    auto_creds: PendingCreds,
    timeout: Duration,
    hooks: TransferHooks,
) -> Result<String, String> {
    // 先拆开：app/transfer_id 要进 reader 线程，cancel 要进 monitor 线程。
    let TransferHooks {
        app,
        transfer_id,
        cancel,
        setup_input,
    } = hooks;
    let stable_setup = setup_input.is_some();
    let progress_target = app.zip(transfer_id);
    let pty_system = native_pty_system();
    let PtyPair { master, slave } = pty_system
        .openpty(PtySize {
            rows: 40,
            cols: 160,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("打开 PTY 失败：{e}"))?;

    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }

    let mut reader = master
        .try_clone_reader()
        .map_err(|e| format!("获取 PTY 读取端失败：{e}"))?;
    // writer 必须先取（Windows 上 inner.writable 是 Option，只此一份），
    // 移入 reader 线程供凭据自动填充。
    let writer = master
        .take_writer()
        .map_err(|e| format!("获取 PTY 写入端失败：{e}"))?;
    let mut child = slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 {} 失败：{e}", program.display()))?;
    // 🔴 子进程已拿到自己的 slave 副本，父进程这份必须立刻关掉：留着它，
    // Unix 上 master 读端在子进程退出后永远等不到 EIO/EOF。
    drop(slave);

    let captured = Arc::new(StdMutex::new(String::new()));
    let cap_for_reader = captured.clone();
    let setup_login_failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let login_for_reader = setup_login_failed.clone();

    // reader：持续读 → 累积输出；出现密码/密码短语提示则自动写对应凭据。
    let reader_handle = std::thread::spawn(move || {
        let mut writer = writer;
        let mut buf = [0u8; 4096];
        let mut creds = auto_creds;
        let mut last_percent: Option<u8> = None;
        let mut setup = setup_input.map(crate::stable_connect::SetupInput::new);
        // 🔴 必须跨 read 增量解码：4096 字节的读取边界会把一个中文字符劈成两半，
        // 逐块 from_utf8_lossy 会把两半各自变成 U+FFFD。这条路径上跑的是 `ls` 输出，
        // 直接体现为**中文文件名乱码**；同时还会让下面「密码：」的中文提示匹配失效。
        let mut dec = crate::utf8_stream::Utf8Stream::new();
        // 认证窗口：过期即丢弃待填凭据，不再对任何输出反应（见 CREDENTIAL_FILL_WINDOW）。
        let fill_deadline = Instant::now() + CREDENTIAL_FILL_WINDOW;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    let text = dec.push(chunk);
                    if !text.is_empty() {
                        if let Some(input) = setup.as_mut() {
                            let (send, output) = input.push(&strip_ansi(&text));
                            if let Some(payload) = send {
                                creds.clear();
                                let _ = writer.write_all(payload.as_bytes());
                                let _ = writer.write_all(b"\n");
                                let _ = writer.flush();
                            }
                            cap_for_reader.lock().unwrap().push_str(&output);
                        } else {
                            let mut s = cap_for_reader.lock().unwrap();
                            s.push_str(&text);
                            collapse_progress(&mut s);
                        }
                    }
                    // 进度：只在传输类调用（带钩子）时上报，且**百分比变了才发**——
                    // scp 一秒能刷很多次，每次都发一次 IPC 是白烧。
                    if let Some((app, tid)) = &progress_target {
                        if let Some(p) = last_percent_in(chunk) {
                            if last_percent != Some(p) {
                                last_percent = Some(p);
                                let _ = app.emit(
                                    "ssh_transfer_progress",
                                    SshTransferProgress {
                                        transfer_id: tid.clone(),
                                        percent: p,
                                    },
                                );
                            }
                        }
                    }
                    // 窗口关闭：立即丢弃明文，不让它在内存里挂着，也不再可能被误触。
                    if Instant::now() >= fill_deadline {
                        creds.clear();
                    }
                    // 提示未到就什么都不做，继续等（受上面的时间窗约束）。
                    // 哪一个槽该答这个提示交给 `PendingCreds`：走跳板机时一次连接有
                    // **两段登录**，把目标机密码填给跳板机提示是一个真实的泄露。
                    // 提示匹配走**解码后**的文本，不再看裸 chunk：否则一个被劈开的
                    // 「密、码」就能让整句中文提示匹配不上，表现为自动填密码静默失效。
                    if !text.is_empty() {
                        let prompt = password_prompt_in(text.as_bytes())
                            || passphrase_prompt_in(text.as_bytes());
                        let filled = if password_prompt_in(text.as_bytes()) {
                            creds.take_password(&text)
                        } else if passphrase_prompt_in(text.as_bytes()) {
                            creds.take_passphrase(&text)
                        } else {
                            None
                        };
                        if let Some(secret) = filled {
                            let _ = writer.write_all(secret.as_bytes());
                            let _ = writer.write_all(b"\n");
                            let _ = writer.flush();
                        } else if setup
                            .as_ref()
                            .is_some_and(crate::stable_connect::SetupInput::waiting)
                            && (prompt || text.contains("Permission denied"))
                        {
                            // A read-only stable inspection must return a login state promptly, not wait for a hung prompt.
                            login_for_reader.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        // EOF 收尾：ConPTY may leave the final protocol marker without a literal newline.
        let tail = dec.flush();
        if let Some(input) = setup.as_mut() {
            let mut output = input.push(&strip_ansi(&tail)).1;
            output.push_str(&input.finish());
            cap_for_reader.lock().unwrap().push_str(&output);
        } else if !tail.is_empty() {
            let mut s = cap_for_reader.lock().unwrap();
            s.push_str(&tail);
            collapse_progress(&mut s);
        }
    });

    // monitor：短轮询等子进程退出 / 取消 / 超时。本线程独占 child，kill 不需要锁。
    // 🔴 不能在这里等 reader 收尾：Windows 的 conhost 要等 master（HPC）关掉才退出，
    // 而 master 只有等子进程退出后由主线程显式 drop 才会关——先等 reader 就死锁了。
    let (done_tx, done_rx) = mpsc::channel::<Result<portable_pty::ExitStatus, String>>();
    let deadline = Instant::now() + timeout;
    std::thread::spawn(move || loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let _ = done_tx.send(Ok(st));
                return;
            }
            Ok(None) => {}
            Err(e) => {
                let _ = done_tx.send(Err(format!("等待进程失败：{e}")));
                return;
            }
        }
        if setup_login_failed.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = done_tx.send(Err("CCB_AUTH_REQUIRED".into()));
            return;
        }
        if cancel
            .as_ref()
            .is_some_and(|c| c.load(std::sync::atomic::Ordering::SeqCst))
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = done_tx.send(Err(format!("{ERR_CANCELLED}: 传输已取消")));
            return;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let error = if stable_setup {
                "CCB_SETUP_TIMEOUT"
            } else {
                "操作超时（网络不通或远程无响应），请重试"
            };
            let _ = done_tx.send(Err(error.into()));
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    });

    let exit = done_rx
        .recv()
        .unwrap_or_else(|_| Err("内部通道异常".into()));
    // 子进程已结束。此刻才关 master：Windows 上这一步触发 ClosePseudoConsole，
    // conhost 随之退出、输出管道关闭，reader 才能看到 EOF。
    // 原实现把 master 挪进了 reader 线程、又在收尾前 join reader——conhost 因
    // HPC 未关而常驻，reader 永远等不到 EOF，整个调用（连同 600s 超时与取消
    // 按钮）在子进程退光之后依然永久卡死，表现为进度条永远停在「连接中」。
    // 留一小段宽限让 conhost 把最后一批输出冲进管道，错误信息不至于被截断。
    std::thread::sleep(Duration::from_millis(200));
    drop(master);
    let _ = reader_handle.join();
    let output = captured.lock().unwrap().clone();

    match exit {
        Ok(status) if status.success() => Ok(output),
        Ok(status) => Err(format!(
            "远程命令失败（退出码 {}）：\n{}",
            status.exit_code(),
            output
        )),
        Err(e) if stable_setup && output.is_empty() => Err(e),
        Err(e) => Err(format!("{e}\n--- 输出 ---\n{output}")),
    }
}

/// 可用性检测：面板进「终端」Tab 时调用，决定是否展示安装指引降级卡片。
#[tauri::command]
pub async fn ssh_check() -> Result<SshCheckResult, String> {
    match find_ssh() {
        Some(path) => Ok(SshCheckResult {
            available: true,
            path: Some(path.to_string_lossy().into_owned()),
            install_hint: None,
        }),
        None => {
            #[cfg(windows)]
            let install_hint = Some(
                "未找到**可执行**的 OpenSSH 客户端。若系统已安装 OpenSSH，则其程序可能已损坏或被安全软件拦截。\n\
                 修复方式（管理员 PowerShell）：\n\
                 Remove-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0\n\
                 Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0\n\
                 或安装 Git for Windows（自带可用的 ssh）后重启本应用。"
                    .to_string(),
            );
            #[cfg(not(windows))]
            let install_hint = Some("未检测到 /usr/bin/ssh，请安装 OpenSSH 客户端。".to_string());
            Ok(SshCheckResult {
                available: false,
                path: None,
                install_hint,
            })
        }
    }
}

/// 读取 SSH 配置（开关 + 连接列表）给前端展示。
#[tauri::command]
pub async fn ssh_list_connections(
    state: State<'_, Arc<AppState>>,
) -> Result<SshConnectionList, String> {
    let config = state.config.read().await;
    Ok(SshConnectionList {
        enabled: config.ssh_enabled,
        connections: config.ssh_connections.clone(),
    })
}

/// `ssh_save_connection` 入参。`password` 为本次对话框里填入的明文（仅内存一瞬），
/// 记住时才在服务端加密落盘；不记住则忽略。
#[derive(Debug, serde::Deserialize)]
pub struct SshSaveArgs {
    pub connection: SshConnection,
    /// 对话框明文密码（可选）。仅在 `connection.remember_password == true` 且密码认证时使用。
    pub password: Option<String>,
    /// 对话框明文密钥密码短语（可选）。仅在 `connection.remember_passphrase == true` 且密钥认证时使用。
    pub passphrase: Option<String>,
}

/// 新增 / 更新一条 SSH 连接。**密码在服务端加密**（S1：明文密码不经通用 patch、不落库）。
///
/// - `connection.id` 为空 → 新建（生成 uuid）；否则按 id 覆盖。
/// - `remember_password == true` 且 `password` 有值 → aes-gcm 加密写入 `encrypted_password`。
/// - `remember_password == false` → 清空 `encrypted_password`。
/// 返回落库后的连接（含 `encrypted_password` 密文，绝不含明文）。
#[tauri::command]
pub async fn ssh_save_connection(
    state: State<'_, Arc<AppState>>,
    args: SshSaveArgs,
) -> Result<SshConnection, String> {
    save_ssh_connection(state.inner(), args).await
}

async fn save_ssh_connection(state: &AppState, args: SshSaveArgs) -> Result<SshConnection, String> {
    // 写凭据也要过总开关：功能关着时不应该还能往盘上写加密密码，
    // 也不应该因此凭空创建出 `ssh_key.bin`。（删除不拦：清理凭据任何时候都该允许。）
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用，无法保存连接".into());
    }
    let mut conn = args.connection;
    if conn.id.trim().is_empty() {
        conn.id = uuid::Uuid::new_v4().to_string();
    }
    crate::ssh_tunnel::validate_rules(&conn.forwards)?;
    // 用户名字符集校验：拼进 `user@host` 后是一个 argv 元素，而 ssh 把 `-` 开头的
    // 目标当选项（详见 `identity_ok`）。保存和连接两处都校验，前者给早反馈、
    // 后者兜住「导入配置 / 手改库」这条绕过 UI 的入口。
    validate_identity(&conn)?;
    for r in conn.forwards.iter_mut().filter(|r| r.id.is_empty()) {
        r.id = uuid::Uuid::new_v4().to_string();
    }
    // 跳板机校验。前端的下拉已经置灰了这些项，这里再守一层：
    // 配置也可以从导入文件进来，绕过 UI。
    if !conn.proxy_jump_id.is_empty() {
        if conn.proxy_jump_id == conn.id {
            return Err("不能把连接自己当作跳板机".into());
        }
        let config = state.config.read().await;
        let jump = config
            .ssh_connections
            .iter()
            .find(|c| c.id == conn.proxy_jump_id)
            .ok_or_else(|| "选中的跳板机连接不存在，请重新选择".to_string())?;
        // 只支持一跳：规则一句话说得清，也就不必做 A→B→A 的环检测。
        if !jump.proxy_jump_id.is_empty() {
            return Err(format!(
                "跳板机「{}」自身也配了跳板机，目前只支持一跳",
                jump.name
            ));
        }
    }
    // 密码字段（仅密码认证有意义）。密钥认证时清掉遗留的密码密文。
    if conn.auth_type != "key" {
        if conn.remember_password {
            match args.password {
                Some(ref pw) if !pw.is_empty() => {
                    let key = crate::ssh_crypto::load_or_create_key(&state.data_dir)
                        .map_err(|e| format!("加载 SSH 密钥失败：{e}"))?;
                    conn.encrypted_password = crate::ssh_crypto::encrypt_password(&key, pw)
                        .map_err(|e| format!("加密密码失败：{e}"))?;
                }
                _ => {
                    // 记住但本次没给新密码：保留库里已有密文（不覆盖为脏数据）。
                    let existing = state.config.read().await;
                    if let Some(old) = existing.ssh_connections.iter().find(|c| c.id == conn.id) {
                        conn.encrypted_password = old.encrypted_password.clone();
                    }
                }
            }
        } else {
            conn.encrypted_password.clear();
        }
    } else {
        conn.encrypted_password.clear();
    }

    // 密码短语字段（仅密钥认证有意义）。密码认证时清掉遗留的密码短语密文。
    if conn.auth_type == "key" {
        if conn.remember_passphrase {
            match args.passphrase {
                Some(ref pp) if !pp.is_empty() => {
                    let key = crate::ssh_crypto::load_or_create_key(&state.data_dir)
                        .map_err(|e| format!("加载 SSH 密钥失败：{e}"))?;
                    conn.encrypted_passphrase = crate::ssh_crypto::encrypt_password(&key, pp)
                        .map_err(|e| format!("加密密码短语失败：{e}"))?;
                }
                _ => {
                    // 记住但本次没给新密码短语：保留库里已有密文。
                    let existing = state.config.read().await;
                    if let Some(old) = existing.ssh_connections.iter().find(|c| c.id == conn.id) {
                        conn.encrypted_passphrase = old.encrypted_passphrase.clone();
                    }
                }
            }
        } else {
            conn.encrypted_passphrase.clear();
        }
    } else {
        conn.encrypted_passphrase.clear();
    }

    let _relay_lock = state.relay_tunnel_lock.lock().await;
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    // 转发规则、自动开启偏好和名称也走这里；它们不改变隧道启动时固定的服务器或凭据。
    let identity_changed =
        if let Some(slot) = config.ssh_connections.iter_mut().find(|c| c.id == conn.id) {
            let changed = !same_login(slot, &conn);
            *slot = conn.clone();
            changed
        } else {
            config.ssh_connections.push(conn.clone());
            false
        };
    crate::config::save_config_field(
        &db,
        "ssh_connections",
        &serde_json::to_value(&config.ssh_connections).unwrap(),
    )?;
    // 🔴 必须拆掉旧 helper：它以 connection_id 为 key、空闲 TTL 300 秒，而里面钉的是
    // **修改前**的主机/用户/端口/跳板。不拆的后果：把 host 从 10.0.1.5 改成 10.0.1.9
    // 并保存，5 分钟内再开文件面板，列目录/建目录/**删除**全部走缓存的旧会话——
    // `rm -rf` 会执行在**旧主机**上。删除连接的路径当时加了，保存这条漏了。
    state.drop_ssh_helper(&conn.id);
    // 服务器或凭据变更后，托管隧道不能继续用修改前的登录信息后台重连，直接停掉。
    // 🔴 手动转发隧道**不在这里停**：产品语义是「保存连接不打断用户正在用的转发」
    // （ssh_save_tests 三条用例守着）。防「连旧服务器」的责任在监管线程——
    // 每次重连前校验登录身份（`login_still_current`），不一致就停住提示重开，
    // 而不是放它拿旧信息无限重连。
    if identity_changed {
        if let Some(op) = state.stable_operations.get(&conn.id) {
            op.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let runtime_id = crate::stable_connect::runtime_id(&conn.id);
        state.halt_ssh_tunnel(&runtime_id);
        // 监管线程的 stop 标志已置位、`publish` 不会再发事件：手动补 stopped，
        // 否则前端 store 留着「运行中」的假状态（进程已经没了）。
        state.emit_tunnels_stopped(&[runtime_id]);
        let relay_ids = config
            .ssh_connections
            .iter()
            .filter(|c| c.id == conn.id || c.proxy_jump_id == conn.id)
            .map(|c| super::relay_tunnel_cmds::runtime_id(&c.id))
            .filter(|id| state.halt_ssh_tunnel(id).is_some())
            .collect::<Vec<_>>();
        state.emit_tunnels_stopped(&relay_ids);
    }
    Ok(conn)
}

/// 面板「显示密码」：把已保存的凭据解密成明文，回给本机前端。
///
/// 🔴 这是唯一一条把明文密码送出去的 IPC 命令，边界必须写死：
/// - **只在本机 WebView 内**：绝不注册为 MCP 工具（`registry.rs` 里没有它），
///   远程 AI 无论怎么调都够不到；也绝不进 `audit.log`——能读审计日志的 AI
///   等于拿到了凭据。
/// - **只读**：不改配置、不落盘，因此不受 `ssh_enabled` 写入门禁限制。功能关掉时
///   用户仍可能想看一眼存过什么再决定是否删除连接。
///
/// 威胁模型没变：能调这条命令的人本来就能读 `data_dir/ssh_key.bin` 自行解密，
/// 这里省的只是「手动解一次」，不新增本机暴露面。
///
/// `field` 取 `"password"`（密码认证）或 `"passphrase"`（密钥认证的密码短语）。
#[tauri::command]
pub async fn ssh_reveal_credential(
    state: State<'_, Arc<AppState>>,
    id: String,
    field: String,
) -> Result<String, String> {
    // 密文取出来立刻放开 config 读锁：解密要读密钥文件（阻塞 IO），不占着配置锁做。
    let cipher = {
        let config = state.config.read().await;
        let conn = config
            .ssh_connections
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| "连接不存在，可能已被删除".to_string())?;
        match field.as_str() {
            "password" => conn.encrypted_password.clone(),
            "passphrase" => conn.encrypted_passphrase.clone(),
            other => return Err(format!("不支持的凭据字段：{other}")),
        }
    };
    decrypt_saved_credential(&cipher, &state.data_dir)
}

/// 「已保存的密文 → 明文」这一步本身（与 AppState 解耦，便于单测）。
///
/// 三种失败各有各的可执行下一步，不能混成一句「解密失败」：
/// - 没存过 → 直接输入；
/// - 密钥文件坏了 → `load_or_create_key` 自带「删哪个文件」的指引；
/// - 密钥对不上（换机器/重装）→ 只能重输，因为旧密文永远解不开了。
fn decrypt_saved_credential(cipher: &str, data_dir: &Path) -> Result<String, String> {
    if cipher.is_empty() {
        return Err("这条连接没有保存密码，直接输入即可".into());
    }
    let key = crate::ssh_crypto::load_or_create_key(data_dir)?;
    crate::ssh_crypto::decrypt_password(&key, cipher)
        .map_err(|e| format!("{e}。密码可能是在另一台设备或另一次安装上保存的，请重新输入一次。"))
}

/// 删除一条 SSH 连接。
#[tauri::command]
pub async fn ssh_delete_connection(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let _relay_lock = state.relay_tunnel_lock.lock().await;
    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    // 先扫引用：删掉一个被当作跳板机的连接，会让引用方**下次连接才报错**。
    // 宁可在这里拦住并把受影响的名字列出来，也不静默地拆掉别人的链路。
    let refs: Vec<String> = config
        .ssh_connections
        .iter()
        .filter(|c| c.id != id && c.proxy_jump_id == id)
        .map(|c| c.name.clone())
        .collect();
    if !refs.is_empty() {
        return Err(format!(
            "还有 {} 条连接以它为跳板机（{}），请先把它们改成其它跳板机或直连",
            refs.len(),
            refs.join("、")
        ));
    }
    let before = config.ssh_connections.len();
    config.ssh_connections.retain(|c| c.id != id);
    if config.ssh_connections.len() == before {
        return Err(format!("未找到要删除的 SSH 连接：{id}"));
    }
    crate::config::save_config_field(
        &db,
        "ssh_connections",
        &serde_json::to_value(&config.ssh_connections).unwrap(),
    )?;
    // 连接都删了，它的 SFTP helper 会话没必要再占着服务器的 MaxSessions。
    state.drop_ssh_helper(&id);
    let runtime_id = crate::stable_connect::runtime_id(&id);
    state.halt_ssh_tunnel(&id);
    if let Some(op) = state.stable_operations.get(&id) {
        op.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    state.halt_ssh_tunnel(&runtime_id);
    let relay_id = super::relay_tunnel_cmds::runtime_id(&id);
    state.halt_ssh_tunnel(&relay_id);
    // 转发面板会随连接删除关闭，但侧栏/托盘可能还显示「运行中」：补发 stopped 归位。
    state.emit_tunnels_stopped(&[id.clone(), runtime_id, relay_id]);
    config
        .stable_connect
        .connections
        .retain(|s| s.connection_id != id);
    if config.stable_connect.selected_connection_id.as_deref() == Some(&id) {
        config.stable_connect.selected_connection_id = None;
    }
    crate::config::save_config_field(
        &db,
        "stable_connect",
        &serde_json::to_value(&config.stable_connect).unwrap(),
    )?;
    Ok(())
}

/// 终端输出的合批窗口（一帧）。
///
/// 以前每读到 4096 字节就 emit 一次，`cat 大文件` / `yes` 能把这个频率推到
/// 每秒上万个 IPC 事件，每个都要 JSON 序列化一次——webview 主线程直接被淹。
/// 选一帧是因为 xterm 本来就是攒到 rAF 才渲染，比一帧更细的推送不会让人更早看到。
const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// 单批上限：攻到这个量就立刻发，不等窗口走完。
const OUTPUT_BATCH_MAX: usize = 64 * 1024;

/// 按会话独立的输出事件名。
///
/// WHY 不再用全局的 `ssh_output`：Tauri 的事件是**广播**，N 个会话就有 N 个监听器，
/// 每条输出都要在每个监听器上反序列化一次，再被其中 N-1 个按 sessionId 丢掉。
///
/// 去掉 uuid 里的连字符、只留字母数字，是为了稳当地落在 Tauri 的事件名字符集里，
/// 不去赌它到底收不收 `-`。前端的 `sshOutputEvent()` 必须与此逐字一致。
pub fn ssh_output_event(session_id: &str) -> String {
    let mut s = String::with_capacity(11 + session_id.len());
    s.push_str("ssh_output_");
    s.extend(session_id.chars().filter(|c| c.is_ascii_alphanumeric()));
    s
}

/// 建立 SSH 终端会话：开 PTY 跑系统 ssh，启动 reader 线程持续推送输出。
///
/// 返回 session_id（前端后续 ssh_input / ssh_resize / ssh_disconnect 用它路由）。
/// 密码登录：默认由人在终端里交互输入（ssh 自动关本地 PTY 的 ECHO，密码不回显）。
/// 若连接勾选「记住密码」，reader 线程检测到 `password:` / `密码：` 提示后自动写密码。
#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    args: SshConnectArgs,
) -> Result<String, String> {
    // 1) 总开关闸门（默认关）。
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用，请先在设置中开启".into());
    }

    // 2) 取连接配置 + 解析跳板机。
    let link = fetch_link(&state, &args.connection_id).await?;
    let conn = link.conn.clone();

    // 3) 解析 ssh 路径（理论上前端已用 ssh_check 拦过，这里再守一层）。
    let ssh_path = find_ssh().ok_or_else(|| {
        "未检测到系统 OpenSSH 客户端，无法连接。请在 Windows 可选功能中启用「OpenSSH 客户端」"
            .to_string()
    })?;

    // 4) 凭据解析：密码 / 密码短语（仅此刻在内存出现明文，用过即丢）。
    // 下面两个字段会被 move 进这次解析，而文件通道的预热（见函数末尾）又需要同一份
    // 一次性凭据，所以先留副本——它只活在本次调用的栈上，不落盘、不进任何长生命周期结构。
    let preheat_secrets = (args.password.clone(), args.passphrase.clone());
    let auto_creds =
        resolve_connect_secrets(&link, &state.data_dir, args.password, args.passphrase)?;

    // 5) 开 PTY 跑 ssh。
    let pty_system = native_pty_system();
    let size = PtySize {
        rows: args.rows.max(1),
        cols: args.cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("打开 PTY 失败：{e}"))?;

    let mut cmd = CommandBuilder::new(&ssh_path);
    for a in ssh_base_args(&link, "-p") {
        cmd.arg(a);
    }
    cmd.arg(format!("{}@{}", conn.username, conn.host));
    // 让远程会话拿到 256 色终端 + UTF-8  locale（中文文件名/日志不乱码）。
    // TERM 直接作用于远端 shell 的渲染；LANG/LC_ALL=C.UTF-8 促远端以 UTF-8 输出
    // （xterm 自身也按 UTF-8 渲染，两端对齐才不会乱码）。
    cmd.env("TERM", "xterm-256color");
    cmd.env("LANG", "C.UTF-8");
    cmd.env("LC_ALL", "C.UTF-8");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 ssh 失败：{e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("获取 PTY 写入端失败：{e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("获取 PTY 读取端失败：{e}"))?;

    let session_id = uuid::Uuid::new_v4().to_string();

    // 6) 注册会话（master 留作 set_size；child 留作 kill；writer 供输入/自动填）。
    // 失败宽限期：ssh 进程若在 spawn 后这么短时间内自行退出（非主动断开），
    // 视为「连接早期失败」（主机不可达/端口错/认证失败），前端应立即报错而非静默黑屏。
    // 正常稳定会话绝不会在此窗口内 EOF；阈值留足首次 TCP/DNS 握手余量。
    const SSH_CONNECT_FAIL_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

    let disconnected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let output = Arc::new(crate::ssh_output::OutputFlow::default());
    state.ssh_sessions.insert(
        session_id.clone(),
        crate::state::SshSession {
            output: output.clone(),
            master: std::sync::Mutex::new(pair.master),
            child,
            writer: std::sync::Mutex::new(writer),
            dimensions: (args.rows.max(1), args.cols.max(1)),
            disconnected: disconnected.clone(),
        },
    );
    // 关窗可能早于会话注册；补查一次，避免错过 Destroyed 后永远等一个不存在的界面。
    if app.get_webview_window("main").is_none() {
        output.detach(None);
    }

    // 7) reader 线程：持续读 PTY 输出 → emit ssh_output；EOF → 按情形 emit
    //    ssh_closed（正常断开）或 ssh_connect_failed（早期失败）+ 移除会话。
    //    若 remember_password，检测密码提示后自动写密码（中英文提示兼容）。
    // 7a) 输出泵：另起一个线程把 reader 送过来的文本按时间窗合批后再 emit。
    //
    // 🔴 为什么不在 reader 里直接攒：reader 阻塞在 `read()` 上，一旦远端安静下来，
    // 攒在手里的最后一批就再也没人发了——命令输出的末尾几十字节会死在缓冲里。
    // 独立线程用 `recv_timeout` 就天然有一个「没新数据也要刷一次」的兵。
    // 泵等前端回执时，reader 的缓冲也必须有上限，背压才能传回 PTY。
    let (out_tx, out_rx) = mpsc::sync_channel::<String>(16);
    let app_pump = app.clone();
    let ev_pump = ssh_output_event(&session_id);
    let sid_pump = session_id.clone();
    let pump = std::thread::spawn(move || {
        let _completion = output.pump_guard();
        let mut buf = String::new();
        // 没 emit 过之前不讲节流：首屏（ssh banner / 密码提示）必须立刻出来。
        let mut ever_emitted = false;
        let mut last_emit = Instant::now();
        let emit = |data: String| {
            let Some(receipt) = output.reserve(data.len()) else {
                return;
            };
            if app_pump
                .emit(
                    &ev_pump,
                    SshOutput {
                        session_id: sid_pump.clone(),
                        data,
                        receipt: Some(receipt.clone()),
                    },
                )
                .is_err()
            {
                output.detach(Some(&receipt.stream_id));
            }
        };
        loop {
            match out_rx.recv_timeout(OUTPUT_FLUSH_INTERVAL) {
                Ok(s) => {
                    buf.push_str(&s);
                    // 🔴 「离上次发已经超过一帧」时立即发，而不是无条件等满一帧：
                    // 后者会给**每一次敲键回显**都加上 16ms 延迟。终端对这个极敏感，
                    // 而交互场景下上一次 emit 本来就早过一帧了——所以只有真在洪水时才会限流。
                    if buf.len() >= OUTPUT_BATCH_MAX
                        || !ever_emitted
                        || last_emit.elapsed() >= OUTPUT_FLUSH_INTERVAL
                    {
                        emit(std::mem::take(&mut buf));
                        ever_emitted = true;
                        last_emit = Instant::now();
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !buf.is_empty() {
                        emit(std::mem::take(&mut buf));
                        ever_emitted = true;
                        last_emit = Instant::now();
                    }
                }
                // reader 退出（丢了 tx）：把尾巴发完再收工。
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !buf.is_empty() {
                        emit(buf);
                    }
                    break;
                }
            }
        }
    });

    let app2 = app.clone();
    let app_state = state.inner().clone();
    let sid = session_id.clone();
    let spawn_time = Instant::now();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut creds = auto_creds;
        // 🔴 必须跨 read 增量解码：4096 字节的读取边界会把一个中文字符劈成两半，
        // 逐块 from_utf8_lossy 把两半各自变成 U+FFFD——实测纯中文下**每 ~4KB 烂一个字**。
        let mut dec = crate::utf8_stream::Utf8Stream::new();
        // 认证窗口：过期即丢弃待填凭据。密钥认证成功时密码提示永远不会到来，
        // 没有这道线密码就会在已登录的 shell 里继续待命（见 CREDENTIAL_FILL_WINDOW）。
        let fill_deadline = Instant::now() + CREDENTIAL_FILL_WINDOW;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF：ssh 进程结束
                Ok(n) => {
                    let text = dec.push(&buf[..n]);
                    // 窗口关闭：立即丢弃明文，不让它在内存里挂着，也不再可能被误触。
                    if Instant::now() >= fill_deadline {
                        creds.clear();
                    }
                    // 凭据自动填充：提示未到就什么都不做，继续等（受上面的时间窗约束）。
                    // 哪一个槽该答这个提示交给 `PendingCreds`：走跳板机时一次连接有
                    // **两段登录**，把目标机密码填给跳板机提示是一个真实的泄露。
                    //
                    // 提示匹配走**解码后**的文本，不再看裸 chunk：否则一个被劈开的
                    // 「密、码」就能让整句中文提示匹配不上，表现为自动填密码静默失效。
                    if creds.has_any() && !text.is_empty() {
                        let filled = if password_prompt_in(text.as_bytes()) {
                            creds.take_password(&text)
                        } else if passphrase_prompt_in(text.as_bytes()) {
                            creds.take_passphrase(&text)
                        } else {
                            None
                        };
                        if let Some(secret) = filled {
                            if let Some(entry) = app_state.ssh_sessions.get(&sid) {
                                if let Ok(mut w) = entry.writer.lock() {
                                    let _ = w.write_all(secret.as_bytes());
                                    let _ = w.write_all(b"\n");
                                    let _ = w.flush();
                                }
                            }
                        }
                    }
                    // 最后才交给输出泵（上面的提示匹配要借用 text，这里直接移走不用拷贝）。
                    // 发送失败只可能是泵线程已退，此时也就不必再推了。
                    if !text.is_empty() {
                        let _ = out_tx.send(text);
                    }
                }
                Err(_) => break,
            }
        }
        // EOF 收尾：残字节再等不到后续，此刻才该落盘。
        let tail = dec.flush();
        if !tail.is_empty() {
            let _ = out_tx.send(tail);
        }
        // 🔴 先关掉 tx 并等泵线程把攒的都发完，再发断开/失败事件。
        // 否则「连接已断开」会赶在最后一批输出前面到达，而那一批往往正是断开原因
        // （sshd 的 "Connection closed by ..."）——用户会看到一个没有上文的错误。
        drop(out_tx);
        let _ = pump.join();
        // EOF：ssh 进程结束。区分三种情形：
        // 1) 主动断开（disconnected 已置）→ 静默，前端早已清 UI。
        // 2) 进程在失败宽限期内自行退出且非主动断开 → 连接早期失败（主机/端口/认证），
        //    发 ssh_connect_failed 让前端立即报错，不再发 ssh_closed（语义互斥）。
        // 3) 其余（连上后稳定运行中途断开）→ 发 ssh_closed，前端正常清「已连接」态。
        if disconnected.load(std::sync::atomic::Ordering::SeqCst) {
            // 主动断开：静默收尾。
        } else if spawn_time.elapsed() < SSH_CONNECT_FAIL_GRACE {
            let _ = app2.emit(
                "ssh_connect_failed",
                SshConnectFailed {
                    session_id: sid.clone(),
                    reason: "SSH 进程过早退出，连接未能建立。请检查主机地址、端口、用户名与凭据是否正确，以及网络是否可达。".into(),
                },
            );
            #[cfg(debug_assertions)]
            eprintln!(
                "[SSH] 连接早期失败 session={}（ssh 进程在宽限期内退出）",
                &sid[..8.min(sid.len())]
            );
        } else {
            let _ = app2.emit(
                "ssh_closed",
                SshClosed {
                    session_id: sid.clone(),
                },
            );
            #[cfg(debug_assertions)]
            eprintln!("[SSH] 连接关闭 session={}", &sid[..8.min(sid.len())]);
        }
        app_state.ssh_sessions.remove(&sid);
    });

    // 连接成功：打印状态（debug 构建下），便于在 dev 后台观察握手/认证是否通过。
    #[cfg(debug_assertions)]
    eprintln!(
        "[SSH] 连接成功 session={} host={}@{}:{} size={}x{}",
        &session_id[..8.min(session_id.len())],
        conn.username,
        conn.host,
        conn.port,
        args.rows,
        args.cols
    );

    // 预热文件通道：登录成功后立刻把常驻 helper 会话建起来。
    //
    // WHY：helper 冷启动（PTY + ssh 进程 + TCP + KEX + 可能两段认证）是文件面板最大的
    // 延迟来源，而它原本**只在用户第一次点文件时才建**——也就是说那一次点击要替整个
    // 会话付账。实际使用里用户都是从终端里看到路径才去点，此时登录已经成功，这一跳纯属浪费。
    //
    // 为什么要等 `SSH_CONNECT_FAIL_GRACE`：本函数返回只代表 ssh **进程起来了**，主机不可达 /
    // 端口错 / 密码错都会在宽限期内退出。不等就预热的话，一次密码错误会额外多发一次登录
    // 尝试——服务器的 fail2ban 会把它记成连续失败，可能把用户锁在门外。
    {
        let preheat_state = state.inner().clone();
        let preheat_link = link.clone();
        let preheat_sid = session_id.clone();
        let (preheat_pw, preheat_pp) = preheat_secrets;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(SSH_CONNECT_FAIL_GRACE).await;
            // 宽限期后会话还在 = 登录成功（与上面 reader 里的早期失败判据同源）。
            if !preheat_state.ssh_sessions.contains_key(&preheat_sid) {
                return;
            }
            // 同一连接开多个标签会各自起一个预热任务；已有 helper 就不必再登一次，
            // 否则白占服务器一个 MaxSessions 名额。
            if preheat_state
                .ssh_helpers
                .contains_key(&preheat_link.conn.id)
            {
                return;
            }
            let Ok(creds) = resolve_connect_secrets(
                &preheat_link,
                &preheat_state.data_dir,
                preheat_pw,
                preheat_pp,
            ) else {
                return;
            };
            let Some(ssh) = find_ssh() else { return };
            // 失败静默：`run_via_helper` 自己会记 60 秒负缓存，用户点文件时直接走一次性
            // 路径（慢但不丢能力）。预热是纯优化，任何情况下都不该冒出一个错误提示。
            let _ = run_via_helper(&preheat_state, &preheat_link, &ssh, creds, "true".into()).await;
        });
    }
    Ok(session_id)
}

/// 向 SSH 会话写入键入数据（前端 xterm onData → 这里）。
#[tauri::command]
pub async fn ssh_input(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    // 总开关关掉后不允许再向存量会话写入。配合 `kill_all_ssh_sessions`（关闭开关时
    // 会直接杀掉活会话），这里是竞争窗口内的第二道防线。
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端已关闭".into());
    }
    let entry = state
        .ssh_sessions
        .get(&session_id)
        .ok_or_else(|| format!("SSH 会话不存在或已断开：{session_id}"))?;
    let mut w = entry
        .writer
        .lock()
        .map_err(|_| "SSH 写入端锁被毒化".to_string())?;
    w.write_all(data.as_bytes())
        .and_then(|_| w.flush())
        .map_err(|e| format!("写入 SSH 输入失败：{e}"))
}

/// 终端缩放（前端 xterm onResize → 这里）。更新 PTY 尺寸，vi/htop 之类才跟手。
#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端已关闭".into());
    }
    let mut entry = state
        .ssh_sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("SSH 会话不存在或已断开：{session_id}"))?;
    // master 包在 StdMutex 里（为让 SshSession: Sync）。锁短时持有即可，且不会 panic
    // 持锁，故用 unwrap_or_else 从毒化中恢复、避免单会话毒化拖垮整个连接池。
    entry
        .master
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("设置终端尺寸失败：{e}"))?;
    entry.dimensions = (rows.max(1), cols.max(1));
    Ok(())
}

/// 断开 SSH 会话：杀 ssh 进程 + 从连接池移除。reader 线程随后收到 EOF 自行退出。
#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<(), String> {
    if let Some(mut entry) = state.ssh_sessions.get_mut(&session_id) {
        // 先标记「主动断开」，让 reader 线程在 EOF 时静默（不发 ssh_closed/failed）。
        // 否则 kill 导致进程退出、reader 收 EOF 会误判为「连接失败」弹错误。
        entry
            .disconnected
            .store(true, std::sync::atomic::Ordering::SeqCst);
        entry.output.detach(None);
        // `Child::kill(&mut self)` 要 `&mut`，故用 `get_mut` 拿可变引用。
        let _ = entry.child.kill();
    }
    state.ssh_sessions.remove(&session_id);
    Ok(())
}

// ─────────────────────────── SFTP 文件传输 ───────────────────────────
//
// 走「ssh 跑远程命令 / scp 传文件」+ PTY 凭据自动填充（与交互终端同一套机制），
// 只是把输出捕获成结构化结果而非流式推屏。安全闸同 `ssh_enabled`。

/// 取连接配置（按 id）+ 解析它的跳板机，找不到报错。
/// 改为 async 读，避免在 tokio worker 上阻塞。
///
/// 跳板机缺失时给的是**能照着做的错误**，而不是默默退回直连（那会表现成
/// 一句看不懂的超时），也不是让 ssh 带着一个空主机去报原始错误。
pub(super) async fn fetch_link(
    state: &State<'_, Arc<AppState>>,
    id: &str,
) -> Result<SshLink, String> {
    let (conn, jump) = load_link_parts(state.inner(), id).await?;
    SshLink::new(conn, jump)
}

/// 取连接配置 + 它的跳板机。**与 `fetch_link` 同源**，只是不吃 `State` ——
/// 非命令层（`cc_session`）需要同一份解析，而它没有 `State` 可给。
pub(super) async fn load_link_parts(
    state: &Arc<AppState>,
    id: &str,
) -> Result<(SshConnection, Option<SshConnection>), String> {
    let c = state.config.read().await;
    let conn = c
        .ssh_connections
        .iter()
        .find(|x| x.id == id)
        .cloned()
        .ok_or_else(|| format!("未找到 SSH 连接：{id}"))?;
    let jump = if conn.proxy_jump_id.is_empty() {
        None
    } else {
        Some(
            c.ssh_connections
                .iter()
                .find(|x| x.id == conn.proxy_jump_id)
                .cloned()
                .ok_or_else(|| {
                    format!("连接「{}」的跳板机已不存在，请在编辑里重新指定", conn.name)
                })?,
        )
    };
    Ok((conn, jump))
}

/// 给 `cc_session` 用：按连接 id 拼出喂 `Command` 的 ssh 参数与 destination。
///
/// 与 `fetch_link` 共用解析（跳板机缺失时同样给「能照着做」的错误），
/// 差别只是返回原始参数，而不是给 PTY 用的 `SshLink`。
pub(crate) async fn ssh_link_args(
    state: &Arc<AppState>,
    id: &str,
) -> Result<(Vec<String>, String), String> {
    let (conn, jump) = load_link_parts(state, id).await?;
    let link = SshLink::new(conn, jump)?;
    let destination = format!("{}@{}", link.conn.username, link.conn.host);
    Ok((ssh_base_args(&link, "-p"), destination))
}

/// 列出远程目录内容。
///
/// 🔴 **只走 russh 长连接，不挂任何降级兜底**（2026-11-24，用户实测定位：
/// 「正常情况下很快，遇到没有访问权限的文件夹就会进入兜底很慢，去掉降级兜底」）。
///
/// 曾经这里是三级链：① russh `read_dir` → ② 常驻 helper `ls` → ③ 一次性
/// ssh `ls`。russh 一失败就静默往下掉，而第③级是**完整 TCP+认证握手**
/// （`spawn_capture_off_runtime`，本机 OpenSSH 无连接复用，实测秒级）——
/// 用户点一个没有权限的文件夹，面板就转圈好几秒。而权限不足换 `ls` 再问
/// 同一台服务器还是不足（sftp-server 与 shell 查同一套 Unix 权限），
/// 第②③级对这个场景纯属白付，还要先把 GNU→BSD 的失败重跑走一遍。
///
/// 现在失败即失败，错误由 russh 直接给出（`Permission denied: …` 一路可读），
/// 前端该报错报错、该回退父目录回退——`useSshFileInitialPath` 对 error
/// 分支本就成立（`ssh_sftp_list` 返回 Err 即触发回退），「initialPath 是
/// 文件则进父目录并定位」这条链路不依赖兜底成功。
///
/// helper / 一次性 ssh 本身不删：`remote_exec`（读文件、回传）、scp 的
/// 协议降级、批量命令仍在用。只是列目录这条热路径不再蹭它们。
///
/// ⚠️ 已知代价（「全部去掉」的取舍）：russh 建连失败后的 60s 负缓存期内，
/// 列目录会直接报错（原来这些请求靠 helper 成功）；sftp-server 异常的
/// 主机上列目录完全失效（原来能靠 `ls` 兜底）。要改回来先读上面的现场记录。
#[tauri::command]
pub async fn ssh_sftp_list(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: String,
) -> Result<Vec<SshFileEntry>, String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let link = fetch_link(&state, &connection_id).await?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    // russh 内建 SSH 实现，不依赖系统 OpenSSH——所以原来那句
    // 「未检测到系统 OpenSSH 客户端，无法列目录」的前置检查也去掉了：
    // 没装 OpenSSH 的机器现在反而能列目录（scp/一次性命令仍会检查）。
    super::ssh_russh_file::russh_list_dir(state.inner(), &link, creds, &path).await
}

/// 下载远程文件到本机。`remote` 远程路径，`local` 本机目标路径。
// 保持现有 IPC 字段，旧前端不传 resumable 时沿用原来的传输路径。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_sftp_get(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
    remote: String,
    local: String,
    transfer_id: String,
    overwrite: bool,
    resumable: Option<bool>,
) -> Result<(), String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    // 🔴 覆盖必须显式授权。项目里没有查本机路径存在性的命令，所以这道检查只能落在后端
    // （上传方向则由前端拿 `entries` 判，零额外往返）。返回可识别前缀，
    // 前端据此弹覆盖确认框，而不是靠匹配错误文案去猜。
    if !overwrite && std::path::Path::new(&local).exists() {
        return Err(format!("{ERR_TARGET_EXISTS}: 本机已存在同名文件：{local}"));
    }
    let link = fetch_link(&state, &connection_id).await?;
    if resumable.unwrap_or(false) {
        return run_resumable_transfer(
            &state,
            app,
            &link,
            transfer_id,
            super::ssh_resume_transfer::ResumeRequest {
                local: std::path::Path::new(&local),
                remote: &remote,
                upload: false,
                overwrite,
                comparison: None,
            },
        )
        .await;
    }
    let _ = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;

    // D 方案： russh 长连接优先——小文件不再新起 scp 进程、不再付一次 11 秒握手。
    // 进度/取消钩子与 scp 路径**同一套**（TransferHooks），前端无需区分。
    // 失败（含负缓存期）静默落到下面的 scp 路径。
    {
        let cancel = register_transfer(&state, &transfer_id);
        let hooks = TransferHooks {
            app: Some(app.clone()),
            transfer_id: Some(transfer_id.clone()),
            cancel: Some(cancel),
            setup_input: None,
        };
        let tried = super::ssh_russh_file::russh_download(
            state.inner(),
            &link,
            creds.clone(),
            &remote,
            std::path::Path::new(&local),
            &hooks,
        )
        .await;
        state.ssh_transfers.remove(&transfer_id);
        if tried.is_ok() {
            return Ok(());
        }
        // russh 没成：别把「已取消」误报成失败——用户主动取消时旧路径也不必再跑。
        if let Some(c) = &hooks.cancel {
            if c.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("传输已取消".into());
            }
        }
    }

    // 🔴 先下到临时名，成功再 rename。这样**取消或失败永远不会碰到用户原有的文件**——
    // 否则「确认覆盖后下到一半取消」会把原文件毁成半个，而用户在对话框里确认的是
    // 「要么新文件、要么旧文件」，不是碎文件。
    let part = format!("{local}{PART_SUFFIX}");
    let cancel = register_transfer(&state, &transfer_id);
    let hooks = TransferHooks {
        app: Some(app),
        transfer_id: Some(transfer_id.clone()),
        cancel: Some(cancel),
        setup_input: None,
    };
    let (scp, c, r, p) = (scp_path, link, remote, part.clone());
    // 丢到阻塞线程池：传输最长 600s，占着 tokio worker 不放会让
    // `ssh_sftp_cancel` 自己都排不上队。
    let joined = tokio::task::spawn_blocking(move || {
        let job = ScpJob {
            link: &c,
            remote: &r,
            local: &p,
            upload: false,
        };
        run_scp(&scp, job, creds, hooks)
    })
    .await;
    // 🔴 先注销再 `?`：写成 `.map_err(..)?` 再 remove 的话，任务 panic 时会提前返回，
    // 取消标志就永久留在注册表里了。
    state.ssh_transfers.remove(&transfer_id);
    let res = joined.map_err(|e| format!("传输任务异常终止：{e}"))?;

    match res {
        Ok(()) => std::fs::rename(&part, &local).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("下载完成但改名失败：{e}")
        }),
        Err(e) => {
            // 取消或失败：清掉半个临时文件，不留垃圾，也不碰正式文件。
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// 登记一次传输的取消标志，返回的句柄交给 monitor 线程轮询。
pub(super) fn register_transfer(
    state: &AppState,
    transfer_id: &str,
) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ssh_transfers
        .insert(transfer_id.to_string(), flag.clone());
    flag
}

/// 取消一次进行中的 SFTP 传输。
///
/// 只置位标志，真正的 kill 由 `spawn_capture` 的 monitor 线程在下一次轮询（≤200ms）时做。
/// 找不到 id 也返回 Ok：传输可能刚好自己结束了，那不是错误。
#[tauri::command]
pub async fn ssh_sftp_cancel(
    state: State<'_, Arc<AppState>>,
    transfer_id: String,
) -> Result<(), String> {
    if let Some(f) = state.ssh_transfers.get(&transfer_id) {
        f.store(true, std::sync::atomic::Ordering::SeqCst);
    } else {
        super::ssh_resume_transfer::discard(&state, &transfer_id).await?;
    }
    Ok(())
}

/// 上传本机文件到远程。`local` 本机源路径，`remote` 远程目标路径。
// 保持现有 IPC 字段，续传与覆盖均由新入口按任务显式选择。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_sftp_put(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
    local: String,
    remote: String,
    transfer_id: String,
    resumable: Option<bool>,
    overwrite: Option<bool>,
    comparison: Option<super::ssh_resume_transfer::ComparedUpload>,
) -> Result<(), String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    // 上传方向不在这里查重名：当前目录的 `entries` 前端手里已经有，
    // 在后端再查一次就多一次完整的 ssh 握手（本机 OpenSSH 不支持连接复用）。
    let link = fetch_link(&state, &connection_id).await?;
    if resumable.unwrap_or(false) || comparison.is_some() {
        return run_resumable_transfer(
            &state,
            app,
            &link,
            transfer_id,
            super::ssh_resume_transfer::ResumeRequest {
                local: std::path::Path::new(&local),
                remote: &remote,
                upload: true,
                overwrite: overwrite.unwrap_or(false),
                comparison,
            },
        )
        .await;
    }
    let _ = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;

    // D 方案： russh 长连接优先，理由同 `ssh_sftp_get`。
    {
        let cancel = register_transfer(&state, &transfer_id);
        let hooks = TransferHooks {
            app: Some(app.clone()),
            transfer_id: Some(transfer_id.clone()),
            cancel: Some(cancel),
            setup_input: None,
        };
        let tried = super::ssh_russh_file::russh_upload(
            state.inner(),
            &link,
            creds.clone(),
            std::path::Path::new(&local),
            &remote,
            &hooks,
        )
        .await;
        state.ssh_transfers.remove(&transfer_id);
        if tried.is_ok() {
            return Ok(());
        }
        if let Some(c) = &hooks.cancel {
            if c.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("传输已取消".into());
            }
        }
    }

    let cancel = register_transfer(&state, &transfer_id);
    let hooks = TransferHooks {
        app: Some(app),
        transfer_id: Some(transfer_id.clone()),
        cancel: Some(cancel),
        setup_input: None,
    };
    let (scp, c, r, l) = (scp_path, link, remote, local);
    let joined = tokio::task::spawn_blocking(move || {
        let job = ScpJob {
            link: &c,
            remote: &r,
            local: &l,
            upload: true,
        };
        run_scp(&scp, job, creds, hooks)
    })
    .await;
    // 先注销再 `?`，理由同 `ssh_sftp_get`。
    state.ssh_transfers.remove(&transfer_id);
    let res = joined.map_err(|e| format!("传输任务异常终止：{e}"))?;
    // 取消时**不**自动删除远端残留（设计稿 §3）：若本次是覆盖上传，
    // 那个文件本来就是用户的；改由前端提示路径、交用户处置。
    res
}

async fn run_resumable_transfer(
    state: &AppState,
    app: AppHandle,
    link: &SshLink,
    id: String,
    request: super::ssh_resume_transfer::ResumeRequest<'_>,
) -> Result<(), String> {
    let creds = resolve_link_secrets(link, &state.data_dir)?;
    let flag = register_transfer(state, &id);
    let hooks = TransferHooks {
        app: Some(app),
        transfer_id: Some(id.clone()),
        cancel: Some(flag),
        setup_input: None,
    };
    let result = super::ssh_resume_transfer::transfer(state, link, creds, request, &hooks).await;
    state.ssh_transfers.remove(&id);
    result
}

/// 一个被拖进来的本机路径的基本信息。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathInfo {
    /// 原路径（原样回传，供前端做 key）。
    pub path: String,
    /// 文件名（不含目录）。
    pub name: String,
    /// 是否为目录。
    pub is_dir: bool,
    /// 字节数；目录或取不到时为 0。
    pub size: u64,
    /// 路径是否存在（拿不到元信息就是 false）。
    pub exists: bool,
}

/// 比较目录只允许删除扫描到的普通文件。此入口不能递归删除目录。
#[tauri::command]
pub async fn ssh_sftp_remove_compared_file(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: String,
    size: u64,
    mtime: u32,
) -> Result<(), String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let link = fetch_link(&state, &connection_id).await?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    let session = super::ssh_russh_cmds::get_russh_session(&state, &link, creds).await?;
    let info = session
        .sftp
        .symlink_metadata(path.as_str())
        .await
        .map_err(super::ssh_russh_file::map_sftp_err)?;
    if !info.is_regular() || info.size != Some(size) || info.mtime != Some(mtime) {
        return Err("远端文件已变化，请重新比较".into());
    }
    session
        .sftp
        .remove_file(path.as_str())
        .await
        .map_err(super::ssh_russh_file::map_sftp_err)
}

/// 查本机路径的类型与大小。专为**拖拽上传**服务。
///
/// 为什么需要它：Tauri 的拖放事件只给路径字符串，而前端没装 `plugin-fs`。
/// 没这个就无法在拖入时分辨文件夹——而 `run_scp` 没带 `-r`，直接传目录
/// 只会招一句看不懂的 scp 错误。宁可加这一个命令，也不为了 stat 引入整个 fs 插件
/// （那会把一整块文件系统权限面开给前端，代价远大于收益）。
///
/// **只读元数据，不读内容**，也不注册为 MCP 工具：仅本机面板经 Tauri IPC 调用。
#[tauri::command]
pub async fn local_path_info(paths: Vec<String>) -> Result<Vec<LocalPathInfo>, String> {
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|p| {
                let pb = PathBuf::from(&p);
                let name = pb
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone());
                match std::fs::metadata(&pb) {
                    Ok(m) => LocalPathInfo {
                        path: p,
                        name,
                        is_dir: m.is_dir(),
                        size: m.len(),
                        exists: true,
                    },
                    Err(_) => LocalPathInfo {
                        path: p,
                        name,
                        is_dir: false,
                        size: 0,
                        exists: false,
                    },
                }
            })
            .collect()
    })
    .await
    .map_err(|e| format!("任务调度失败：{e}"))
}

/// 在远程创建目录（含父目录，`mkdir -p`）。
#[tauri::command]
pub async fn ssh_sftp_mkdir(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: String,
) -> Result<(), String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let link = fetch_link(&state, &connection_id).await?;
    let conn = &link.conn;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    let remote_cmd = format!("mkdir -p {}", shell_quote(&path));
    // D 方案：russh 长连接优先（`mkdir -p` 语义已在 russh 侧对齐）。
    if super::ssh_russh_file::russh_mkdir(state.inner(), &link, creds.clone(), &path)
        .await
        .is_ok()
    {
        return Ok(());
    }
    // 快路径：常驻 helper（同 ssh_sftp_list）。
    if let Ok((out, code)) =
        run_via_helper(&state, &link, &ssh_path, creds.clone(), remote_cmd.clone()).await
    {
        return if code == 0 {
            Ok(())
        } else {
            Err(out.trim().to_string())
        };
    }
    let mut args = ssh_base_args(&link, "-p");
    args.push(format!("{}@{}", conn.username, conn.host));
    args.push(remote_cmd);
    // 瞬时操作：不需要进度，也不需要取消。
    spawn_capture_off_runtime(ssh_path, args, creds).await?;
    Ok(())
}

/// 删除远程文件/目录（`rm -rf`，递归）。请在 UI 层二次确认，避免误删。
#[tauri::command]
pub async fn ssh_sftp_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: String,
) -> Result<(), String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let link = fetch_link(&state, &connection_id).await?;
    let conn = &link.conn;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    let remote_cmd = format!("rm -rf {}", shell_quote(&path));
    // D 方案：russh 长连接优先（`rm -rf` 的递归语义已在 russh 侧用显式栈对齐）。
    if super::ssh_russh_file::russh_remove(state.inner(), &link, creds.clone(), &path)
        .await
        .is_ok()
    {
        return Ok(());
    }
    // 快路径：常驻 helper（同 ssh_sftp_list）。
    if let Ok((out, code)) =
        run_via_helper(&state, &link, &ssh_path, creds.clone(), remote_cmd.clone()).await
    {
        return if code == 0 {
            Ok(())
        } else {
            Err(out.trim().to_string())
        };
    }
    let mut args = ssh_base_args(&link, "-p");
    args.push(format!("{}@{}", conn.username, conn.host));
    args.push(remote_cmd);
    // 瞬时操作：不需要进度，也不需要取消。
    spawn_capture_off_runtime(ssh_path, args, creds).await?;
    Ok(())
}

// ── 重命名 / 移动（批次③） ────────────────────────────────────
//
// 两个命令共享同一套三级回退（与 mkdir / remove 同构），差别只在**目标路径
// 怎么算**：rename 只改名称（同目录），move 只换目录（同名）。目标路径一律
// 由后端算，前端传不进任意 `to`——「只能修改名称；要换目录请用移动」这条
// UX 承诺由这里结构性保证，不只靠前端自觉。

/// 校验面板传来的新名称。纯函数，可单测。
///
/// 名称是**单段**（面板语义：重命名不换目录，所以不允许出现 `/`）。
/// 不校验长度（NAME_MAX 由服务端执法，rename 失败的错误信息更准确），
/// 也不禁控制字符（Linux 文件名合法，过度限制会让合法操作失败）。
pub(super) fn validate_new_name(new_name: &str) -> Result<(), String> {
    if new_name.is_empty() {
        return Err("名称不能为空".into());
    }
    if new_name.contains('\0') {
        return Err("名称含有非法字符（NUL）".into());
    }
    if new_name.contains('/') {
        return Err("名称不能包含 /（重命名不换目录，换目录请用移动）".into());
    }
    if new_name == "." || new_name == ".." {
        return Err("名称不能是 . 或 ..".into());
    }
    Ok(())
}

/// 校验移动的目标目录：非空、无 NUL。
///
/// 不校验存在性（那是 `mv` / rename 的活，服务端的错误信息更准确），
/// 也不校验「把目录挪进自己的子树」——服务端两边都会拒绝（SFTP EINVAL /
/// mv 自带检测），让事实裁判，不在客户端重复一套可能不一致的规则。
pub(super) fn validate_dir_path(dir: &str) -> Result<(), String> {
    if dir.is_empty() {
        return Err("目标目录不能为空".into());
    }
    if dir.contains('\0') {
        return Err("目标目录含有非法字符（NUL）".into());
    }
    Ok(())
}

/// 同目录重命名的目标路径：`path` 的父目录 + `new_name`。纯函数，可单测。
pub(super) fn rename_target_path(path: &str, new_name: &str) -> Result<String, String> {
    validate_new_name(new_name)?;
    let (parent, old) = path
        .rsplit_once('/')
        .ok_or_else(|| format!("路径不是绝对路径形态，无法定位父目录：{path}"))?;
    if new_name == old {
        return Err("名称未变化".into());
    }
    // 父目录是根时拼出来是 "//name"：POSIX 下等价但难看，且会让
    // 「目标与来源相同」这类等式判断分心，特判掉。
    Ok(if parent.is_empty() {
        format!("/{new_name}")
    } else {
        format!("{parent}/{new_name}")
    })
}

/// 移动到目标目录：目标路径 = `to_dir` / `from` 的文件名。纯函数，可单测。
pub(super) fn move_target_path(from: &str, to_dir: &str) -> Result<String, String> {
    validate_dir_path(to_dir)?;
    let base = from
        .rsplit_once('/')
        .map(|(_, b)| b)
        .filter(|b| !b.is_empty())
        .ok_or_else(|| format!("路径不是文件形态，无法取文件名：{from}"))?;
    let to = if to_dir == "/" {
        format!("/{base}")
    } else {
        format!("{}/{base}", to_dir.trim_end_matches('/'))
    };
    if to == from {
        return Err("目标与当前位置相同，无需移动".into());
    }
    Ok(to)
}

/// 拼 helper / 一次性 ssh 用的远端 rename 命令。纯函数，可单测。
///
/// 🔴 两个必须防的坑：
/// 1. **不能用 `exit`**：helper 是常驻 `/bin/sh`（`wrap_command` 是
///    `{cmd}; printf END_$?`），`exit` 会把会话本身杀掉，之后每次操作
///    都白付一次完整登录。用 `false` 收尾拿非零退出码。
/// 2. **`mv` 必须带 `-f`**：helper 跑在 PTY 上（交互式），不带 `-f` 的
///    `mv` 遇已存在目标会挂起等 y/n 直到命令超时。
///
/// 🔴 **`mv` 与 SFTP rename 的语义分歧**：目标是**已存在的真目录**时，
/// `mv` 会把源**挪进目录里**（`mv f dir` → `dir/f`）而不是报错——用户点了
/// 「覆盖」却看到条目换个位置静默消失，而 russh 侧对这种组合返回 EISDIR。
/// 所以 overwrite 分支显式拒绝目录目标，对齐 russh。（代价：目录→空目录的
/// 替换在 helper 路径被拒，SFTP 本来允许——罕见组合，选「明确失败」而不是
/// 「静默错位」。）
///
/// overwrite=false 的预检用 `[ -e ] || [ -L ]`：`-e` 跟随软链、`-L` 补断链
/// （断链时 `-e` 为假但条目真实存在，rename 到断链路径会替换掉链接，
/// 必须让用户确认——与 russh 侧 `symlink_metadata` 预检同一判据）。
pub(super) fn rename_remote_cmd(from: &str, to: &str, overwrite: bool) -> String {
    let f = shell_quote(from);
    let t = shell_quote(to);
    if overwrite {
        format!(
            "if [ -d {t} ] && [ ! -L {t} ]; then echo 'TARGET_IS_DIR: 目标已存在且是一个目录，无法覆盖'; false; else mv -f -- {f} {t}; fi"
        )
    } else {
        format!(
            "if [ -e {t} ] || [ -L {t} ]; then echo TARGET_EXISTS; false; else mv -- {f} {t}; fi"
        )
    }
}

/// rename / move 的公共骨架：**三级回退**，与 `ssh_sftp_mkdir` /
/// `ssh_sftp_remove` 完全同构——russh 长连接优先，**失败不 return Err**，
/// 继续往常驻 helper、一次性 ssh 走。`remote_cmd` 由调用方经
/// [`rename_remote_cmd`]（纯函数）给出，helper 与一次性 ssh 跑同一条命令，
/// 两条 shell 路径行为一致。
async fn rename_via_fallback(
    state: &State<'_, Arc<AppState>>,
    connection_id: &str,
    from: &str,
    to: &str,
    overwrite: bool,
) -> Result<(), String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let link = fetch_link(state, connection_id).await?;
    let conn = &link.conn;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    let remote_cmd = rename_remote_cmd(from, to, overwrite);
    // D 方案：russh 长连接优先（条目级 rename；EXDEV 留给下面的 mv）。
    if super::ssh_russh_file::russh_rename(state.inner(), &link, creds.clone(), from, to, overwrite)
        .await
        .is_ok()
    {
        return Ok(());
    }
    // 快路径：常驻 helper（同 mkdir / remove）。
    if let Ok((out, code)) =
        run_via_helper(state, &link, &ssh_path, creds.clone(), remote_cmd.clone()).await
    {
        return if code == 0 {
            Ok(())
        } else {
            Err(out.trim().to_string())
        };
    }
    let mut args = ssh_base_args(&link, "-p");
    args.push(format!("{}@{}", conn.username, conn.host));
    args.push(remote_cmd);
    // 瞬时操作：不需要进度，也不需要取消。
    spawn_capture_off_runtime(ssh_path, args, creds).await?;
    Ok(())
}

/// 重命名远程文件/目录（**只改名称，不换目录**——换目录是 [`ssh_sftp_move`]）。
///
/// `new_name` 是单段名称（不含 `/`），目标路径由后端按「同目录」算出。
/// `overwrite=false` 时目标已存在返回 `TARGET_EXISTS` 标记（前端据此弹
/// 确认对话框），用户点「覆盖」后才带 `overwrite=true` 重调；没有静默
/// 覆盖路径。软链条目重命名改的是**链接本身**（条目级语义，与资源管理器
/// 一致；「编辑软链内容解析到目标」是另一套故意不同的语义）。
#[tauri::command]
pub async fn ssh_sftp_rename(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    path: String,
    new_name: String,
    overwrite: bool,
) -> Result<(), String> {
    let to = rename_target_path(&path, &new_name)?;
    rename_via_fallback(&state, &connection_id, &path, &to, overwrite).await
}

/// 移动远程文件/目录到另一个目录（**只换目录，不改名**）。
///
/// 目标路径 = `to_dir` / 原文件名，同样由后端算。批量移动由前端对每个
/// 条目各调一次（串行执行）；同名冲突的预检在移动前用目标目录的列目录
/// 结果在前端汇总成一个确认，不逐个弹窗。
#[tauri::command]
pub async fn ssh_sftp_move(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    from: String,
    to_dir: String,
    overwrite: bool,
) -> Result<(), String> {
    let to = move_target_path(&from, &to_dir)?;
    rename_via_fallback(&state, &connection_id, &from, &to, overwrite).await
}

#[cfg(test)]
#[path = "ssh_save_tests.rs"]
mod save_tests;

#[cfg(test)]
#[path = "ssh_rename_tests.rs"]
mod rename_tests;

#[cfg(test)]
mod tests {
    use super::*;

    // ── ssh 路径挑选 ────────────────────────────────────────

    /// 🔴 回归（2026-10-29 实机故障）：`System32\OpenSSH\ssh.exe` 存在、签名有效，
    /// 但执行即 exit 255 且零输出。旧实现只判 `exists()` 就把它当成可用程序，
    /// 结果连接全程黑屏、只报「进程过早退出」，用户完全看不出是 ssh 本身坏了。
    ///
    /// 这里钉死行为：存在但不可执行的候选必须被跳过，继续往下找。
    #[test]
    fn pick_runnable_skips_existing_but_broken_candidate() {
        let bad = PathBuf::from("/fake/System32/OpenSSH/ssh.exe");
        let good = PathBuf::from("/fake/Git/usr/bin/ssh.exe");
        let picked = pick_runnable(
            vec![bad.clone(), good.clone()],
            |_| true,                // 两个文件都在
            |p| p == good.as_path(), // 只有 Git 那个能执行
            || false,
        );
        assert_eq!(picked, Some(good));
    }

    /// 不存在的候选不该被探测（PATH 里一堆不存在的目录，探测即浪费一次进程创建）。
    #[test]
    fn pick_runnable_never_probes_missing_files() {
        let probed = std::cell::RefCell::new(Vec::new());
        let picked = pick_runnable(
            vec![PathBuf::from("/nope/a"), PathBuf::from("/here/b")],
            |p| p == Path::new("/here/b"),
            |p| {
                probed.borrow_mut().push(p.to_path_buf());
                true
            },
            || false,
        );
        assert_eq!(picked, Some(PathBuf::from("/here/b")));
        assert_eq!(probed.borrow().len(), 1, "只应探测存在的那一个");
    }

    /// 同一路径重复出现（PATH 里同一目录多次）只探测一次，且顺序即偏好。
    #[test]
    fn pick_runnable_dedups_and_keeps_priority_order() {
        let a = PathBuf::from("/first/ssh");
        let b = PathBuf::from("/second/ssh");
        let count = std::cell::Cell::new(0);
        let picked = pick_runnable(
            vec![a.clone(), a.clone(), b.clone()],
            |_| true,
            |p| {
                count.set(count.get() + 1);
                p == b.as_path()
            },
            || false,
        );
        assert_eq!(picked, Some(b));
        assert_eq!(count.get(), 2, "a 只探测一次（重复项被去重）");
    }

    /// 总预算耗尽后必须立刻收手，不能再往下探测——调用方在 tokio 的工作线程上，
    /// 候选集合又含 PATH 里任意多目录，没有这条就可能把界面卡住十几秒。
    #[test]
    fn pick_runnable_stops_when_budget_exhausted() {
        let calls = std::cell::Cell::new(0);
        let picked = pick_runnable(
            vec![PathBuf::from("/a"), PathBuf::from("/b")],
            |_| true,
            |_| {
                calls.set(calls.get() + 1);
                false
            },
            || calls.get() >= 1, // 探测过一次后即视为超预算
        );
        assert_eq!(picked, None);
        assert_eq!(calls.get(), 1, "超预算后不再探测第二个候选");
    }

    /// 一个都不可执行时返回 None，让上层给出「OpenSSH 不可用」的明确提示，
    /// 而不是拿着坏路径去 spawn 然后黑屏。
    #[test]
    fn pick_runnable_returns_none_when_all_broken() {
        let picked = pick_runnable(
            vec![PathBuf::from("/a"), PathBuf::from("/b")],
            |_| true,
            |_| false,
            || false,
        );
        assert_eq!(picked, None);
    }

    #[test]
    fn stable_setup_allocates_terminal_before_sending_stdin_frames() {
        let link = SshLink::direct(SshConnection {
            host: "fixture.example".into(),
            username: "fixture".into(),
            ..Default::default()
        });
        let command = "python3 -c 'import sys; sys.stdin.readline()'";
        let args = stable_setup_args(&link, command.into());
        let destination = args
            .iter()
            .position(|arg| arg == "fixture@fixture.example")
            .unwrap();
        assert!(
            args[..destination].iter().any(|arg| arg == "-tt"),
            "Windows OpenSSH needs a terminal to forward submitted stdin frames"
        );
        assert_eq!(args.last().unwrap(), command);
        assert!(
            !ssh_base_args(&link, "-p").iter().any(|arg| arg == "-tt"),
            "ordinary SSH/SFTP options must remain unchanged"
        );
    }

    // ── 跳板机：不配时参数必须逐字节不变 ────────────────────────

    // ── 用户名字符集：唯一能把 argv 元素变成 ssh 选项的形态 ──────────

    /// 🔴 机制是实测出来的：`ssh -G "-oProxyCommand=calc @host"` 会把整串当**选项**
    /// 解析（打印 usage 而非用法错误），说明 `-` 开头的 `user@host` 真能变成开关。
    /// 这里钉住两道门（保存 / 连接）都拒，同时钉住正常形态不被顺手加严。
    #[test]
    fn rejects_dash_prefixed_username() {
        let bad = SshConnection {
            host: "10.0.1.50".into(),
            port: 22,
            username: "-oProxyCommand=calc ".into(),
            ..Default::default()
        };
        assert!(
            validate_identity(&bad).is_err(),
            "以 - 开头的用户名必须被拒"
        );
        assert!(SshLink::new(bad, None).is_err(), "连接路径必须同样拒绝");

        let spaced = SshConnection {
            username: "root user".into(),
            ..Default::default()
        };
        assert!(
            validate_identity(&spaced).is_err(),
            "含空白的用户名必须被拒（参数不分词，交出去就是错的 host）"
        );

        // 正常形态与空值必须照旧放行：空值 = 交给 ssh 用默认值（表单未做必填），
        // 非 ASCII 字母也要放行，否则 Windows 中文账户名连不上。
        for ok in ["root", "ops.prod", "deploy-bot", "deploy_bot", "", "域用户"] {
            let c = SshConnection {
                username: ok.into(),
                ..Default::default()
            };
            assert!(validate_identity(&c).is_ok(), "「{ok}」应放行");
        }
    }

    /// 🔴 加跳板机支持改动了所有连接都要走的 `ssh_base_args`。
    /// 本用例钉住「不配跳板 = 参数与以前完全一致」，否则老连接会被连带改坏。
    #[test]
    fn direct_args_unchanged_by_proxy_support() {
        let conn = SshConnection {
            host: "10.0.1.50".into(),
            port: 22,
            username: "root".into(),
            ..Default::default()
        };
        let args = ssh_base_args(&SshLink::direct(conn), "-p");
        assert_eq!(
            args,
            vec![
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-p",
                "22",
            ]
        );
        assert!(!args.iter().any(|a| a.contains("Proxy")));
    }

    /// 配了跳板时，`-o ProxyCommand=` 必须真的出现在参数里。
    /// （它足以发现“忘了把 link 传到某个调用点”这类静默退回直连的缺陷。）
    #[test]
    fn proxy_command_reaches_the_arg_list() {
        let conn = SshConnection {
            host: "10.0.1.50".into(),
            port: 22,
            username: "root".into(),
            ..Default::default()
        };
        let jump = SshConnection {
            host: "bastion.corp.com".into(),
            port: 2222,
            username: "ops".into(),
            ..Default::default()
        };
        let link = SshLink {
            conn,
            jump: Some(jump.clone()),
            proxy: Some(crate::ssh_proxy::proxy_command_value(Path::new("ssh"), &jump).unwrap()),
        };
        // scp 用 `-P`，ssh 用 `-p`；两边都要带上跳板。
        for flag in ["-p", "-P"] {
            let args = ssh_base_args(&link, flag);
            let proxy = args
                .iter()
                .find(|a| a.starts_with("ProxyCommand="))
                .unwrap_or_else(|| panic!("{flag} 的参数里没有 ProxyCommand：{args:?}"));
            assert!(proxy.contains("-W %h:%p"), "{proxy}");
            assert!(proxy.contains("ops@bastion.corp.com"), "{proxy}");
            assert!(proxy.contains("-p 2222"), "{proxy}");
        }
    }

    // ── 凭据提示识别（这组是安全回归护栏，不是辅助测试）────────────────

    /// 🔴 核心回归：**普通远程输出里出现 `password:` 不得被当成密码提示**。
    ///
    /// 原实现是裸的 `lower.contains("password:")`，下面这些全部会误判为真提示，
    /// 把明文密码打进已登录的会话（PTY 会回显，进终端滚动区与远程 shell history）。
    #[test]
    fn ordinary_output_containing_password_is_not_a_prompt() {
        for bad in [
            "config.yaml:password: hunter2\nnext line\n",
            "grep 结果：/etc/app.conf:  password: s3cret\n",
            "日志：2026-08-25 login failed, password: wrong\n",
            // 以冒号结尾但根本不含关键词
            "Are you sure you want to continue:",
        ] {
            assert!(
                !password_prompt_in(bad.as_bytes()),
                "不该识别为密码提示：{bad:?}"
            );
        }
    }

    /// 真正的密码提示仍然要能识别（修误报不能把正常功能一并弄挂）。
    #[test]
    fn real_password_prompts_still_match() {
        for good in [
            "u@10.0.0.1's password: ",
            "Password:",
            "请输入密码：",
            // 前面还挂着别的输出，但提示压在末尾
            "Warning: Permanently added '10.0.0.1'\r\nu@10.0.0.1's password: ",
        ] {
            assert!(
                password_prompt_in(good.as_bytes()),
                "真提示应该识别为密码提示：{good:?}"
            );
        }
    }

    /// 密钥密码短语提示：它**不是**以 `passphrase:` 结尾，而是引号路径加冒号。
    /// 且必须与密码提示互斥，否则会把登录密码填进密码短语输入。
    #[test]
    fn passphrase_prompt_is_recognised_and_not_confused_with_password() {
        let pp = "Enter passphrase for key '/home/u/.ssh/id_rsa': ";
        assert!(passphrase_prompt_in(pp.as_bytes()), "应识别为密码短语提示");
        assert!(
            !password_prompt_in(pp.as_bytes()),
            "密码短语提示不得被当成密码提示"
        );

        // 中文侧是真正的陷阱：「密码短语」字面包含「密码」。
        let zh = "请输入密码短语：";
        assert!(passphrase_prompt_in(zh.as_bytes()));
        assert!(
            !password_prompt_in(zh.as_bytes()),
            "「密码短语」含「密码」，必须先排除才不会填错凭据"
        );
    }

    /// 🔴 改密流程的「设新密码 / 重复输入」绝不能当成登录提示：
    /// 填进去的是**新密码**，我们手上只有旧密码，换行还会把这次提交坐实。
    #[test]
    fn password_change_prompts_are_not_login_prompts() {
        for bad in [
            "New password: ",
            "Retype new password: ",
            "Re-enter new password: ",
            "Repeat password: ",
            "Confirm password: ",
            "Please verify your password: ",
            "Enter new password: ",
            // 中文侧（本地化 passwd 常见写法）
            "新密码：",
            "请再次输入新密码：",
            "确认密码：",
            "重新输入密码：",
            "重复密码：",
        ] {
            assert!(
                !password_prompt_in(bad.as_bytes()),
                "改密提示不得被当成登录密码提示：{bad:?}"
            );
        }
        // 「当前密码」仍属于登录侧语义，要继续自动填（否则用户还得手输两遍）。
        for good in [
            "Current password: ",
            "(current) UNIX password: ",
            "当前密码：",
        ] {
            assert!(
                password_prompt_in(good.as_bytes()),
                "当前密码属于登录侧提示，应继续自动填充：{good:?}"
            );
        }
    }

    /// 非 UTF-8 字节不能 panic——PTY 读出来的就是裸字节，还可能切在码点中间。
    #[test]
    fn tolerates_non_utf8_chunks() {
        assert!(!password_prompt_in(&[0xff, 0xfe, 0x80]));
        assert!(!passphrase_prompt_in(&[0xff, 0xfe, 0x80]));
    }

    /// 事件名只能含字母数字与下划线（uuid 的连字符必须被剔掉），
    /// 且不同会话必须得到不同的名字——否则两个终端会收到彼此的输出。
    /// 前端 `lib/terminalEvents.ts` 里有一条用同一个 uuid 对照的字面量断言。
    #[test]
    fn output_event_name_is_per_session_and_charset_safe() {
        let a = ssh_output_event("3f2b1c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d");
        assert_eq!(a, "ssh_output_3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d");
        assert!(
            a.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
            "事件名出现了不在安全字符集里的字符：{a}"
        );
        assert_ne!(a, ssh_output_event("00000000-0000-0000-0000-000000000001"));
    }

    // ── 列目录不许再挂降级链 ─────────────────────────────────────────

    /// 🔴 回归（体验退化级）：`ssh_sftp_list` **只走 russh**，函数体里不得再出现
    /// helper / 一次性 ssh 两级降级，也不得再生成/解析 `ls` 命令。
    ///
    /// 事故记录（2026-11-24，用户实测定位）：「正常情况下很快，遇到没有访问权限的
    /// 文件夹就会进入兜底很慢」。原实现是 russh → helper `ls` → 一次性 ssh `ls`
    /// 三级链，russh 一失败就静默下掉；第③级是完整 TCP+认证握手（本机 OpenSSH
    /// 无连接复用，秒级），而无权限目录换 `ls` 问同一台服务器还是被拒（sftp-server
    /// 与 shell 查同一套 Unix 权限）——纯白付，还要先走一遍 GNU→BSD 的失败重跑。
    /// `ssh_sftp_list` 的 doc 注释里有完整的取舍说明（含「全部去掉」的已知代价）。
    ///
    /// 为什么用源级断言：这个 bug 的形状是「代码里存在一条降级链」，真机复现要么
    /// 连服务器、要么造一个 sftp-server 异常的主机，CI 里都做不到。所以守**形状**：
    /// 函数体内一个降级调用都不许有。
    ///
    /// 🔴 needle 必须**运行时拼**：`include_str!` 把本测试的代码一起读进来了，
    /// 字面量会自己匹配自己（`no_fallible_stat_after_rename` 第一版就这么翻车的）。
    #[test]
    fn list_dir_has_no_fallback_chain() {
        let src = include_str!("ssh_cmds.rs");
        let start = src
            .find("pub async fn ssh_sftp_list")
            .expect("ssh_sftp_list 应存在");
        // 函数体截到下一个 `#[tauri::command]`（即 ssh_sftp_get 的属性）为止。
        let body = &src[start..];
        let end = body
            .find("\n#[tauri::command]")
            .unwrap_or_else(|| body.find("\npub async fn").unwrap_or(body.len()));
        let body = &body[..end];
        let needle = |frag: &str| frag.to_string();
        for banned in [
            needle("run_via_") + "helper",
            needle("spawn_capture_") + "off_runtime",
            needle("gnu_") + "ls_cmd",
            needle("bsd_") + "ls_cmd",
            needle("parse_") + "ls",
            needle("is_unknown_") + "option_err",
        ] {
            assert!(
                !body.contains(&banned),
                "ssh_sftp_list 函数体里又出现了降级链调用：{banned}"
            );
        }
        // 正向也要钉住：russh 主路径必须还在（别把整个函数删成空壳）。
        assert!(
            body.contains(&(needle("russh_") + "list_dir")),
            "ssh_sftp_list 必须仍走 russh_list_dir"
        );
    }

    // ── 降级判定与引号转义 ───────────────────────────────────────

    /// BSD 的 `ls` 拒绝 `--time-style` 时是**非零码退出**，错误文本里带着远端输出，
    /// 降级判定必须能从那段文本里认出来——否则 macOS 远端列目录直接报错。
    #[test]
    fn unknown_option_is_detected_in_error_text() {
        assert!(is_unknown_option_err(
            "远程命令失败（退出码 1）：\nls: illegal option -- -\nusage: ls [-...]"
        ));
        assert!(is_unknown_option_err("scp: unknown option -- s"));
        assert!(!is_unknown_option_err(
            "远程命令失败（退出码 2）：ls: /nope: No such file or directory"
        ));
    }

    /// 🔴 F1 回归：遗留 SCP 协议下远程路径**必须**带 shell 引号，SFTP 协议下**必须不带**。
    ///
    /// 不引则 `会议纪要 2026.docx` 被远端 shell 拆成两个参数，传输失败——
    /// 而同文件的 ls/mkdir/rm 早就引了，唯独 scp 这两处漏了，于是列表里看得见、就是传不动。
    /// 反方向也必须钉住：SFTP 协议按字面处理路径，引了引号会变成文件名的一部分。
    #[test]
    fn legacy_scp_quotes_remote_path_but_sftp_mode_does_not() {
        let conn = SshConnection {
            username: "ops".into(),
            host: "10.0.3.21".into(),
            ..Default::default()
        };
        let p = "/data/会议纪要 2026.docx";
        assert_eq!(
            scp_endpoint(&conn, p, true),
            "ops@10.0.3.21:'/data/会议纪要 2026.docx'",
            "遗留协议：路径过远端 shell，必须引"
        );
        assert_eq!(
            scp_endpoint(&conn, p, false),
            "ops@10.0.3.21:/data/会议纪要 2026.docx",
            "SFTP 协议：路径按字面处理，绝不能引"
        );
    }

    /// 单引号 / 分号这类字符在遗留协议下也必须被中和。
    #[test]
    fn legacy_scp_neutralises_dangerous_remote_names() {
        let conn = SshConnection {
            username: "u".into(),
            host: "h".into(),
            ..Default::default()
        };
        let ep = scp_endpoint(&conn, "/tmp/a'; touch /tmp/pwned; '", true);
        // 精确断言而不是“不包含某子串”。
        //
        // ⚠ 这里有个容易踩的坑（我第一版就写错了）：结果里**确实含有** `'; touch`
        // 这个子串，但它是转义序列 `'\''` 的尾部接上分号，shell 看到的是字面量。
        // 拿子串包含关系判安全性会把安全结果误判成不安全，只能比完整输出。
        assert_eq!(
            ep, "u@h:'/tmp/a'\\''; touch /tmp/pwned; '\\'''",
            "每个单引号都要被折成 '\\'' ，整个路径仍包在外层单引号里"
        );
        assert_eq!(ep.matches("'\\''").count(), 2, "两个单引号都要被转义：{ep}");
    }

    /// 🔴 F2 回归：用**真实的 usage 文本**判定 `-s` 支持性。
    ///
    /// v81 那段是本机 OpenSSH_for_Windows_8.1p1 的实测输出（`scp -s` → unknown option）。
    /// 判错的代价是每次传输白跑一次完整 TCP + 认证握手。
    #[test]
    fn detects_scp_sftp_flag_from_real_usage_text() {
        let v81 = "usage: scp [-346BCpqrTv] [-c cipher] [-F ssh_config] [-i identity_file]\n\
                   [-J destination] [-l limit] [-o ssh_option] [-P port]\n\
                   [-S program] source ... target";
        let v9 = "usage: scp [-346ABCOpqRrsTv] [-c cipher] [-D sftp_server_path] [-F ssh_config]";
        assert!(!usage_lists_short_flag(v81, 's'), "8.1p1 不支持 -s");
        assert!(usage_lists_short_flag(v9, 's'), "9.x 支持 -s");
        // 只看首个短选项簇，不能被后面 `[-S program]` 的大写 S 或别处字母骗到。
        assert!(!usage_lists_short_flag(v81, 'O'), "8.1p1 也没有 -O");
    }

    /// 从 scp 真实形状的进度行里取百分比，且取**最后一个**（一块里可能堆了多次刷新）。
    #[test]
    fn last_percent_takes_the_newest_refresh() {
        let chunk = b"data.bin   12%  1.0MB   1.2MB/s   00:40\rdata.bin   37%  3.1MB";
        assert_eq!(last_percent_in(chunk), Some(37));
        assert_eq!(last_percent_in(b"file  0%"), Some(0));
        assert_eq!(last_percent_in(b"file 100% done"), Some(100));
    }

    /// 不是进度的 `%` 不能误认；超过 100 的数字也不能当百分比。
    ///
    /// 前者如远端输出里的 `50%` 以外的裸 `%`（shell 提示符、printf 格式串），
    /// 后者如 `120%`——真当成百分比会把进度条画爆。
    #[test]
    fn last_percent_rejects_non_progress() {
        assert_eq!(last_percent_in(b"user@host:~% "), None); // `%` 前面没数字
        assert_eq!(last_percent_in(b"no percent here"), None);
        assert_eq!(last_percent_in(b""), None);
        // 120% 被排除后，应该什么都不剩（而不是退而取个错值）。
        assert_eq!(last_percent_in(b"weird 120%"), None);
        // 非 UTF-8 字节不能 panic。
        assert_eq!(last_percent_in(&[0xff, 0xfe, b'5', b'%']), Some(5));
    }

    /// 进度条刷新必须被折叠，否则大文件传输会把捕获缓冲撑爆。
    #[test]
    fn collapse_progress_keeps_only_latest_refresh() {
        let mut b = String::from("scp 启动\n");
        for i in 0..5000 {
            b.push_str(&format!("\rfile.bin {i}%  1.2MB/s"));
            collapse_progress(&mut b);
        }
        assert!(b.len() < 200, "进度刷新应被折叠，实际长度 {}", b.len());
        assert!(b.starts_with("scp 启动\n"), "已换行的历史不能被动：{b:?}");
        assert!(b.contains("4999%"), "应保留最后一次刷新：{b:?}");
    }

    /// 真实错误信息（以换行结束）必须原样保留，不能被折叠逻辑吃掉——
    /// 去掉 `-q` 就是为了拿回这些信息。
    #[test]
    fn collapse_progress_preserves_real_messages() {
        let mut b = String::new();
        b.push_str("Permission denied (publickey,password).\r\n");
        collapse_progress(&mut b);
        b.push_str("lost connection\n");
        collapse_progress(&mut b);
        assert!(b.contains("Permission denied"), "诊断信息不能丢：{b:?}");
        assert!(b.contains("lost connection"));
    }

    /// 带单引号的文件名不能逃出引号变成远程命令。
    #[test]
    fn shell_quote_neutralises_single_quotes() {
        assert_eq!(shell_quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        // 典型注入尝试：先闭引号再用分号接命令
        assert_eq!(shell_quote("a'; rm -rf /; '"), "'a'\\''; rm -rf /; '\\'''");
    }

    // ── 提示匹配：ConPTY 转义污染 ────────────────────────────────

    /// 🔴 回归：ConPTY 会把控制台标题 / 光标状态的转义序列追加在密码提示后面。
    /// 本机实测 scp（传输路径）的提示 chunk 是：
    /// `\x1b[2J\x1b[m\x1b[Huser@host's password:\x1b[1C\x1b]0;C:\...\scp.exe\x07\x1b[?25h`
    /// 不剥转义的话尾部永远不是冒号 → 自动填密静默失效 → scp 传输永远卡在
    /// 「连接中」（一次性路径没有手输机会）。
    #[test]
    fn conpty_polluted_password_prompt_is_recognized() {
        let chunk = b"\x1b[2J\x1b[m\x1b[Hlizuliang@10.0.19.194's password:\x1b[1C\x1b]0;C:\\Windows\\System32\\OpenSSH\\scp.exe\x07\x1b[?25h";
        assert!(password_prompt_in(chunk), "污染 chunk 必须命中密码提示");
        assert!(
            !passphrase_prompt_in(chunk),
            "密码提示不能被认成密码短语提示"
        );
    }

    /// 密码短语的 ConPTY 形态同理：`Enter passphrase for key '...':` + 尾随转义。
    #[test]
    fn conpty_polluted_passphrase_prompt_is_recognized() {
        let chunk = b"\x1b[2J\x1b[m\x1b[HEnter passphrase for key '/c/Users/me/id_ed25519': \x1b]0;ssh.exe\x07\x1b[?25h";
        assert!(
            passphrase_prompt_in(chunk),
            "污染 chunk 必须命中密码短语提示"
        );
        assert!(
            !password_prompt_in(chunk),
            "passphrase 不能被认成登录密码（避免把登录密码填进密码短语框）"
        );
    }

    /// 干净提示（winpty / Unix PTY 形态）不受剥离逻辑影响，照常命中。
    #[test]
    fn clean_prompts_still_match_after_strip() {
        assert!(password_prompt_in(b"user@host's password: "));
        assert!(password_prompt_in("密码：".as_bytes()));
        assert!(passphrase_prompt_in(
            b"Enter passphrase for key '/c/Users/me/id_ed25519': "
        ));
        // 非提示的输出不能因为剥离而变得误命中。
        assert!(!password_prompt_in(b"grep password: foo\r\nnext line"));
    }

    // ── 面板「显示已保存的密码／密码短语」 ──────────────────

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccb_reveal_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    /// 正常路径：同一个 data_dir 里加密的密文能原样解回明文（含中文与空格）。
    #[test]
    fn reveal_round_trips_saved_credential() {
        let dir = scratch("ok");
        let key = crate::ssh_crypto::load_or_create_key(&dir).expect("key");
        let ct = crate::ssh_crypto::encrypt_password(&key, "p@ss 密码").expect("encrypt");
        assert_eq!(
            decrypt_saved_credential(&ct, &dir).expect("reveal"),
            "p@ss 密码"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 没存过密码：报错必须说「直接输入」，而不是笼统的「解密失败」——
    /// 用户点了眼睛看不到东西，唯一需要知道的就是「这里本来就没存」。
    #[test]
    fn reveal_empty_ciphertext_tells_user_to_type_it_in() {
        let dir = scratch("empty");
        let e = decrypt_saved_credential("", &dir).expect_err("空密文必须报错");
        assert!(e.contains("没有保存密码"), "{e}");
        assert!(e.contains("直接输入"), "错误得给出下一步：{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 🔴 密钥对不上（换机器 / 重装 / 删过 `ssh_key.bin`）：旧密文永远解不开。
    /// 报错必须指向「重新输入一次」，否则用户只会对着「解密失败」反复点眼睛。
    #[test]
    fn reveal_with_foreign_key_tells_user_to_retype() {
        let src = scratch("src");
        let dst = scratch("dst");
        let src_key = crate::ssh_crypto::load_or_create_key(&src).expect("src key");
        let ct = crate::ssh_crypto::encrypt_password(&src_key, "old-secret").expect("encrypt");
        // dst 会生成自己的一把钥匙，与 src 不同。
        let e = decrypt_saved_credential(&ct, &dst).expect_err("换密钥必须解不开");
        assert!(e.contains("重新输入"), "错误得给出下一步：{e}");
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }
    #[test]
    fn connect_credentials_are_single_use_and_do_not_modify_saved_connection() {
        let dir = scratch("once");
        let conn = SshConnection {
            host: "target.example.com".into(),
            username: "user".into(),
            auth_type: "password".into(),
            remember_password: true,
            encrypted_password: "unreadable-old-ciphertext".into(),
            ..Default::default()
        };
        let link = SshLink::direct(conn);
        let mut creds =
            resolve_connect_secrets(&link, &dir, Some("one-time".into()), None).unwrap();
        assert_eq!(
            creds.take_password("user@target.example.com's password:"),
            Some("one-time".into())
        );
        assert_eq!(
            creds.take_password("user@target.example.com's password:"),
            None
        );
        assert!(link.conn.remember_password);
        assert_eq!(link.conn.encrypted_password, "unreadable-old-ciphertext");
        assert!(resolve_connect_secrets(&link, &dir, None, None).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn connect_passphrase_uses_only_the_key_authentication_slot() {
        let dir = scratch("once_key");
        let conn = SshConnection {
            host: "target.example.com".into(),
            auth_type: "key".into(),
            key_path: "id_ed25519".into(),
            remember_passphrase: true,
            encrypted_passphrase: "unreadable-old-ciphertext".into(),
            ..Default::default()
        };
        let link = SshLink::direct(conn);
        let mut creds = resolve_connect_secrets(
            &link,
            &dir,
            Some("ignored".into()),
            Some("one-time-pp".into()),
        )
        .unwrap();
        assert_eq!(
            creds.take_passphrase("Enter passphrase for key 'id_ed25519':"),
            Some("one-time-pp".into())
        );
        assert_eq!(creds.take_password("password:"), None);
        assert_eq!(
            creds.take_passphrase("Enter passphrase for key 'id_ed25519':"),
            None
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn old_connect_payload_still_deserializes_without_credentials() {
        let args: SshConnectArgs =
            serde_json::from_str(r#"{"connectionId":"host","rows":30,"cols":100}"#).unwrap();
        assert!(args.password.is_none());
        assert!(args.passphrase.is_none());
    }

    #[test]
    fn stable_setup_pins_identity_before_saved_connection_changes() {
        let mut config = crate::config::BridgeConfig::default();
        config.ssh_connections.push(SshConnection {
            id: "cloud".into(),
            host: "original.example".into(),
            username: "original-user".into(),
            ..Default::default()
        });
        let pinned = SshLink::from_config(&config, "cloud").unwrap();
        config.ssh_connections[0].host = "replacement.example".into();
        config.ssh_connections[0].username = "replacement-user".into();
        assert_eq!(pinned.conn.host, "original.example");
        assert_eq!(pinned.conn.username, "original-user");
    }
}
