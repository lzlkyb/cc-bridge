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

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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
    /// 文件名（含软链 ` -> target` 后缀）。
    pub name: String,
    /// 是否为目录。
    pub is_dir: bool,
    /// 字节大小（目录为 0）。
    pub size: u64,
    /// 修改时间（Unix 秒）。
    pub mtime: i64,
    /// 是否为软链接。
    pub is_symlink: bool,
}

/// `ssh_connect` 入参。
#[derive(Debug, serde::Deserialize)]
pub struct SshConnectArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub rows: u16,
    pub cols: u16,
}

/// 探测系统 ssh 路径（不抛错，缺失返回 None）。
///
/// Windows：先 `System32\OpenSSH\ssh.exe`，回退 `SysWOW64\OpenSSH\ssh.exe`
/// （旧 Win10 / Server / 精简镜像可能只在其一）。
/// macOS / Linux：永远自带 `/usr/bin/ssh`。
fn find_ssh() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let p1 = PathBuf::from(&sys)
            .join("System32")
            .join("OpenSSH")
            .join("ssh.exe");
        if p1.exists() {
            return Some(p1);
        }
        let p2 = PathBuf::from(&sys)
            .join("SysWOW64")
            .join("OpenSSH")
            .join("ssh.exe");
        if p2.exists() {
            return Some(p2);
        }
        None
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
fn resolve_link_secrets(
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

/// 一次操作的完整目标：目标连接 + 可选跳板机。
///
/// 把两者绑在一起传，而不是给 `ssh_base_args` / `run_scp` / `spawn_capture` 一路
/// 都加一个 `Option<&SshConnection>` 参数——后者一旦在某个调用点忘了传，表现是
/// **静默地走直连**（连不上，且从报错里看不出为什么）。
struct SshLink {
    conn: SshConnection,
    jump: Option<SshConnection>,
    /// 已拼好的 `-o ProxyCommand=` 的值；None = 直连。
    ///
    /// 建连接时就拼好而不是每次用到再拼：拼接会因为非法字符失败，失败必须
    /// 在一开始就报出来，而不是埋在某一条传输路径里。
    proxy: Option<String>,
}

impl SshLink {
    fn new(conn: SshConnection, jump: Option<SshConnection>) -> Result<Self, String> {
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

/// 拼 ssh/scp 通用连接选项。`port_flag` 区分 ssh 的 `-p` 与 scp 的 `-P`。
/// 密钥认证时追加 `-i <key_path>`（仅当路径非空）。
///
/// 无跳板时（`link.proxy == None`）输出与加跳板机功能之前**逐字节一致**，
/// 老连接零影响（见本文件底部的 `direct_args_unchanged_by_proxy_support` 用例）。
fn ssh_base_args(link: &SshLink, port_flag: &str) -> Vec<String> {
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
fn find_scp() -> Option<PathBuf> {
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
fn is_unknown_option_err(msg: &str) -> bool {
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
fn scp_endpoint(conn: &SshConnection, remote: &str, quote_for_shell: bool) -> String {
    let path = if quote_for_shell {
        shell_quote(remote)
    } else {
        remote.to_string()
    };
    format!("{}@{}:{}", conn.username, conn.host, path)
}

/// 一次 scp 传输的目标描述。把 remote/local/方向收成一体，
/// 免得 `run_scp` 参数表膨胀到 clippy 都看不下去（too_many_arguments）。
struct ScpJob<'a> {
    link: &'a SshLink,
    remote: &'a str,
    local: &'a str,
    /// true = 本机→远端，false = 远端→本机。
    upload: bool,
}

/// 跑一次 scp。
///
/// 优先用 `-s` 强制 SFTP 协议：遗留 SCP 协议上远程路径会被远端 shell 展开
/// （CVE-2020-15778 一类），下载方向还有恶意服务端投放额外文件的历史问题
/// （CVE-2019-6111），而这里的远程路径来自 `parse_ls` 解出的**远端文件名**。
/// 不支持时回退到遗留协议，并**改用 shell 引号**保护路径。
///
/// 不传 `-q`：它会把进度条**和** ssh 的警告/诊断信息一起关掉，失败时错误几乎是空的；
/// 前端 `cleanErr` 本来就是为剔掉进度条噪声写的，噪声交给它处理。
fn run_scp(
    scp: &PathBuf,
    job: ScpJob<'_>,
    creds: PendingCreds,
    hooks: TransferHooks,
) -> Result<(), String> {
    const SCP_TIMEOUT: Duration = Duration::from_secs(600);
    let build = |sftp_mode: bool| -> Vec<String> {
        let mut a: Vec<String> = Vec::new();
        if sftp_mode {
            a.push("-s".into());
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
        match spawn_capture(scp, &build(true), creds.clone(), SCP_TIMEOUT, hooks.clone()) {
            Ok(_) => return Ok(()),
            // 探测说支持却仍报未知选项：探测判错了，退回遗留协议再试一次。
            Err(e) if is_unknown_option_err(&e) => {}
            Err(e) => return Err(e),
        }
    }
    spawn_capture(scp, &build(false), creds, SCP_TIMEOUT, hooks).map(|_| ())
}

/// 列目录命令（GNU coreutils）。
///
/// - `--time-style=+%s`：把 mtime 输出成 epoch 秒，便于排序。macOS/BSD 的 `ls`
///   不支持该选项（报 `illegal option`），调用方命中后退到 `bsd_ls_cmd`。
/// - 🔴 `--quoting-style=literal`：**不能省**。helper 会话用 `-tt` 给了远端一个 tty，
///   而 coreutils 在 isatty(stdout) 时默认用 shell-escape 引用——`my report.txt`
///   会变成 `'my report.txt'`（带单引号），`parse_ls` 拿到的名字就多了一对引号，
///   前端据此拼出的远程路径全部报「No such file」（下载/删除/进目录）。
///   旧的一次性路径不带 `-t`、stdout 是管道，所以不会引用——开了 helper 才露出来，
///   且恰好打掉了“带空格文件名传不了”那个修复。（已在 coreutils 8.32 实测）
fn gnu_ls_cmd(path: &str) -> String {
    format!(
        "ls -la --time-style=+%s --quoting-style=literal {}",
        shell_quote(path)
    )
}

/// 列目录命令（BSD/macOS 降级路径）。
///
/// BSD `ls` 没有 `--quoting-style`（给了会直接报错），也不像 coreutils 那样
/// 在 tty 下自动加引号，所以这边保持裸 `ls -la`。mtime 解析不到（前端显示「未知」）。
fn bsd_ls_cmd(path: &str) -> String {
    format!("ls -la {}", shell_quote(path))
}

/// 把路径包成单引号并转义内部单引号，避免远程命令注入。
fn shell_quote(p: &str) -> String {
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
const CREDENTIAL_FILL_WINDOW: Duration = Duration::from_secs(30);

/// 若这一块输出看着是**进程正阻塞等待输入的提示**，返回它的小写文本。
///
/// 判据是「去掉尾部空白后以冒号结尾」：真提示写完就阻塞等输入，所以它一定压在
/// 这一块的末尾；而 `grep password: foo.conf` 这类输出后面还跟着别的内容与换行，
/// 不会以冒号收尾。单靠 `contains("password:")` 无法区分二者——这正是原实现的漏洞。
fn prompt_tail(chunk: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(chunk);
    let t = s.trim_end();
    if t.ends_with(':') || t.ends_with('：') {
        Some(t.to_lowercase())
    } else {
        None
    }
}

/// 判断输出块是否是**登录密码**提示（`user@host's password: ` / `密码：`）。
fn password_prompt_in(chunk: &[u8]) -> bool {
    let Some(t) = prompt_tail(chunk) else {
        return false;
    };
    // 「密码短语」里含「密码」，必须先排除，否则密钥提示会被当成密码提示，
    // 把登录密码填进密码短语输入。英文侧无此问题（password 不是 passphrase 的子串）。
    if t.contains("passphrase") || t.contains("密码短语") {
        return false;
    }
    t.contains("password") || t.contains("密码")
}

/// 判断输出块是否是**密钥密码短语**提示。
///
/// 真实形式是 `Enter passphrase for key '/path/id_rsa': `——注意它**不是**以
/// `passphrase:` 结尾，而是以引号路径加冒号结尾，所以锁定冒号、关键词用包含判定。
fn passphrase_prompt_in(chunk: &[u8]) -> bool {
    prompt_tail(chunk).is_some_and(|t| t.contains("passphrase") || t.contains("密码短语"))
}

/// 解析 `ls -la` 输出为结构化条目。
/// `gnu=true` 时按 GNU coreutils 语法（`--time-style=+%s`，第6列是 epoch 秒）；
/// `gnu=false` 时按 BSD/macOS 语法（日期占多列，难以可靠转 epoch，mtime 置 0）。
/// 两种都跳过 `total N` 与 `.`/`..`；容忍空格文件名与软链 ` -> target`。
fn parse_ls(out: &str, gnu: bool) -> Result<Vec<SshFileEntry>, String> {
    let mut entries = Vec::new();
    for line in out.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with("total ") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let perms = match parts.next() {
            Some(p) => p,
            None => continue,
        };
        let _links = parts.next();
        let _owner = parts.next();
        let _group = parts.next();
        let size_s = match parts.next() {
            Some(s) => s,
            None => continue,
        };
        // GNU：第6列是 epoch 秒，之后是名字；BSD：第6~8列是日期时间，之后是名字。
        let mtime: i64 = if gnu {
            match parts.next() {
                Some(s) => s.parse::<i64>().unwrap_or(0),
                None => 0,
            }
        } else {
            // BSD 日期占三列（月 日 时间/年），跳过以定位名字。
            let _mon = parts.next();
            let _day = parts.next();
            let _tim = parts.next();
            0
        };
        let raw: String = parts.collect::<Vec<_>>().join(" ");
        let is_dir = perms.starts_with('d');
        let is_symlink = perms.starts_with('l');
        // 软链整行形如 `mylink -> /target`；只取 ` -> ` 前的一段作为 name，
        // 否则前端把它拼进路径会变成 `.../mylink -> /target` 这种非法路径。
        let name = if is_symlink {
            raw.split(" -> ").next().unwrap_or(&raw).to_string()
        } else {
            raw
        };
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let size = size_s.parse::<u64>().unwrap_or(0);
        entries.push(SshFileEntry {
            name,
            is_dir,
            size,
            mtime,
            is_symlink,
        });
    }
    Ok(entries)
}

/// 传输被用户取消的错误前缀。
///
/// 🔴 用**前缀标记**而不是让前端去匹配中文文案：文案会改，前缀不会。
/// 设计稿 §4 要求「取消」「超时」「失败」三者在 UI 上可区分，靠字串包含去猜必然跑偏。
pub const ERR_CANCELLED: &str = "CCB_CANCELLED";
/// 下载目标已存在且未授权覆盖的错误前缀（同上，供前端弹覆盖确认框）。
pub const ERR_TARGET_EXISTS: &str = "CCB_TARGET_EXISTS";

/// 下载用的临时后缀。传完才 rename 到正式名。
const PART_SUFFIX: &str = ".ccbpart";

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
struct TransferHooks {
    app: Option<AppHandle>,
    transfer_id: Option<String>,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
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
const SSH_ONESHOT_TIMEOUT: Duration = Duration::from_secs(30);

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
async fn spawn_capture_off_runtime(
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

/// 在该连接的**常驻 helper 会话**上跑一条命令，返回（输出, 退出码）。
///
/// 这是列目录/建目录/删除的**快路径**：本机 OpenSSH 没有 ControlMaster，
/// 不复用的话每次都是一次完整的 TCP + 认证握手。
///
/// **任何失败都返回 Err，调用方必须退回一次性握手路径**（服务器禁 shell、
/// MaxSessions 满、远端没有 /bin/sh 都会让 helper 起不来）。helper 一旦出错就拆掉重建。
async fn run_via_helper(
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

/// 在 PTY 里跑一次性命令（ssh 远程命令 / scp 传输），捕获全部输出并自动填充
/// 密码/密码短语，等待进程退出（带超时），返回捕获到的输出字符串。
///
/// 与交互终端 `ssh_connect` 共用「PTY + 凭据自动填充」机制，但输出不推屏、而是
/// 收集成字符串返回，便于 SFTP 这类「请求-响应」操作做结构化解析。
///
/// 注意它是**同步阻塞**的：在 `#[command] async fn` 里要走 `spawn_capture_off_runtime`，
/// 不要直接调。
fn spawn_capture(
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
    } = hooks;
    let progress_target = app.zip(transfer_id);
    let pty_system = native_pty_system();
    let pair = pty_system
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

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("获取 PTY 读取端失败：{e}"))?;
    let master = pair.master; // 移入 reader 线程，供 take_writer 自动填凭据
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 {} 失败：{e}", program.display()))?;

    let captured = Arc::new(StdMutex::new(String::new()));
    let cap_for_reader = captured.clone();

    // reader：持续读 → 累积输出；出现密码/密码短语提示则自动写对应凭据。
    let (prompt_tx, prompt_rx) = mpsc::channel::<()>();
    let reader_handle = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut creds = auto_creds;
        let mut last_percent: Option<u8> = None;
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
                        let mut s = cap_for_reader.lock().unwrap();
                        s.push_str(&text);
                        collapse_progress(&mut s);
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
                    if creds.has_any() && !text.is_empty() {
                        let filled = if password_prompt_in(text.as_bytes()) {
                            creds.take_password(&text)
                        } else if passphrase_prompt_in(text.as_bytes()) {
                            creds.take_passphrase(&text)
                        } else {
                            None
                        };
                        if let Some(secret) = filled {
                            if let Ok(mut w) = master.take_writer() {
                                let _ = w.write_all(secret.as_bytes());
                                let _ = w.write_all(b"\n");
                                let _ = w.flush();
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        // EOF 收尾：流结束了，残字节再等不到后续，此时才该落盘。
        let tail = dec.flush();
        if !tail.is_empty() {
            let mut s = cap_for_reader.lock().unwrap();
            s.push_str(&tail);
            collapse_progress(&mut s);
        }
        let _ = prompt_tx.send(());
    });

    // monitor：等 reader 收尾（=进程退出）或超时；超时则强杀。
    let (done_tx, done_rx) = mpsc::channel::<Result<portable_pty::ExitStatus, String>>();
    // 🔴 不能直接 `recv_timeout(timeout)` 等满全程：那样取消请求要等到 600s 超时才生效。
    // 改成短轮询，每轮查一次取消标志。本线程**独占** child，所以 kill 不需要任何锁。
    let deadline = Instant::now() + timeout;
    std::thread::spawn(move || loop {
        match prompt_rx.recv_timeout(Duration::from_millis(200)) {
            // reader 收尾 = 进程已退出（正常结束路径）。
            Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let st = child.wait().map_err(|e| format!("等待进程失败：{e}"));
                let _ = done_tx.send(st);
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
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
                    let _ = done_tx.send(Err("操作超时（网络不通或远程无响应），请重试".into()));
                    return;
                }
            }
        }
    });

    let _ = reader_handle.join();
    let exit = done_rx
        .recv()
        .unwrap_or_else(|_| Err("内部通道异常".into()));
    let output = captured.lock().unwrap().clone();

    match exit {
        Ok(status) if status.success() => Ok(output),
        Ok(status) => Err(format!(
            "远程命令失败（退出码 {}）：\n{}",
            status.exit_code(),
            output
        )),
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
                "未检测到 OpenSSH 客户端。请以管理员身份运行 PowerShell 执行：\n\
                 Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0"
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
    // 写凭据也要过总开关：功能关着时不应该还能往盘上写加密密码，
    // 也不应该因此凭空创建出 `ssh_key.bin`。（删除不拦：清理凭据任何时候都该允许。）
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用，无法保存连接".into());
    }
    let mut conn = args.connection;
    if conn.id.trim().is_empty() {
        conn.id = uuid::Uuid::new_v4().to_string();
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

    let db = state.db.lock().await;
    let mut config = state.config.write().await;
    if let Some(slot) = config.ssh_connections.iter_mut().find(|c| c.id == conn.id) {
        *slot = conn.clone();
    } else {
        config.ssh_connections.push(conn.clone());
    }
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
    Ok(conn)
}

/// 删除一条 SSH 连接。
#[tauri::command]
pub async fn ssh_delete_connection(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
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
    let auto_creds = resolve_link_secrets(&link, &state.data_dir)?;

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
    state.ssh_sessions.insert(
        session_id.clone(),
        crate::state::SshSession {
            master: std::sync::Mutex::new(pair.master),
            child,
            writer: std::sync::Mutex::new(writer),
            dimensions: (args.rows.max(1), args.cols.max(1)),
            disconnected: disconnected.clone(),
        },
    );

    // 7) reader 线程：持续读 PTY 输出 → emit ssh_output；EOF → 按情形 emit
    //    ssh_closed（正常断开）或 ssh_connect_failed（早期失败）+ 移除会话。
    //    若 remember_password，检测密码提示后自动写密码（中英文提示兼容）。
    // 7a) 输出泵：另起一个线程把 reader 送过来的文本按时间窗合批后再 emit。
    //
    // 🔴 为什么不在 reader 里直接攒：reader 阻塞在 `read()` 上，一旦远端安静下来，
    // 攒在手里的最后一批就再也没人发了——命令输出的末尾几十字节会死在缓冲里。
    // 独立线程用 `recv_timeout` 就天然有一个「没新数据也要刷一次」的兵。
    let (out_tx, out_rx) = mpsc::channel::<String>();
    let app_pump = app.clone();
    let ev_pump = ssh_output_event(&session_id);
    let sid_pump = session_id.clone();
    let pump = std::thread::spawn(move || {
        let mut buf = String::new();
        // 没 emit 过之前不讲节流：首屏（ssh banner / 密码提示）必须立刻出来。
        let mut ever_emitted = false;
        let mut last_emit = Instant::now();
        let emit = |data: String| {
            let _ = app_pump.emit(
                &ev_pump,
                SshOutput {
                    session_id: sid_pump.clone(),
                    data,
                },
            );
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
    // 诊断日志（debug 构建）：确认前端 onData → ssh_input 是否真正到达后端。
    // 若敲键时后台出现该日志，说明链路通、问题在下游；若不出现，说明前端 onData 未触发（焦点）。
    //
    // 🔴 只能打长度，不能打内容。这里流过的就是用户敲的每一个字符——包括在
    // 远端密码提示下手动输入的密码。本项目对凭据的基线是「明文绝不外露」，
    // 把它逐字符打进 dev 控制台与这条基线直接冲突。长度足够完成它的诊断职责。
    #[cfg(debug_assertions)]
    eprintln!(
        "[SSH] input session={} bytes={}",
        &session_id[..8.min(session_id.len())],
        data.len()
    );
    let mut w = entry
        .writer
        .lock()
        .map_err(|_| "SSH 写入端锁被毒化".to_string())?;
    // 诊断：写之前已打印 input（见上），这里确认 write+flush 是否真的成功送达 PTY。
    // 若只看到 input 但看不到 input-ok → write_all/flush 失败（写入端问题）；
    // 若看到 input-ok 但屏幕仍无回显 → 写入成功但远端 shell 没收/未回显（下游问题）。
    match w.write_all(data.as_bytes()).and_then(|_| w.flush()) {
        Ok(_) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "[SSH] input-ok session={} bytes={}",
                &session_id[..8.min(session_id.len())],
                data.len()
            );
        }
        Err(e) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "[SSH] input-FAIL session={} err={}",
                &session_id[..8.min(session_id.len())],
                e
            );
            return Err(format!("写入 SSH 输入失败：{e}"));
        }
    }
    Ok(())
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
async fn fetch_link(state: &State<'_, Arc<AppState>>, id: &str) -> Result<SshLink, String> {
    let (conn, jump) = {
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
        (conn, jump)
    };
    SshLink::new(conn, jump)
}

/// 列出远程目录内容。
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
    let conn = &link.conn;
    let ssh_path =
        find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端，无法列目录".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;
    let mut args = ssh_base_args(&link, "-p");
    args.push(format!("{}@{}", conn.username, conn.host));
    let gnu_cmd = gnu_ls_cmd(&path);
    let bsd_cmd = bsd_ls_cmd(&path);
    // 快路径：在常驻 helper 会话上跑，零握手。helper 不可用则落到下面的旧路径。
    //
    // 注意：只要 helper **拿到了响应**（哪怕退出码非 0）就不再走旧路径——
    // 目录不存在这类真实错误重跑一遍只是白垃一次握手，结果一样。
    if let Ok((out, code)) =
        run_via_helper(&state, &link, &ssh_path, creds.clone(), gnu_cmd.clone()).await
    {
        if code == 0 {
            return parse_ls(&out, true);
        }
        if is_unknown_option_err(&out) {
            // BSD/macOS 的 ls 不认 --time-style，降级重跑（仍在同一条 helper 上）。
            if let Ok((out2, code2)) =
                run_via_helper(&state, &link, &ssh_path, creds.clone(), bsd_cmd.clone()).await
            {
                return if code2 == 0 {
                    parse_ls(&out2, false)
                } else {
                    Err(out2.trim().to_string())
                };
            }
        } else {
            return Err(out.trim().to_string());
        }
    }

    let mut args_gnu = args.clone();
    args_gnu.push(gnu_cmd);
    let gnu_res = spawn_capture_off_runtime(ssh_path.clone(), args_gnu, creds.clone()).await;
    // 🔴 失败分支也得看。BSD/macOS 的 `ls` 拒绝 `--time-style` 时是以**非零码退出**，
    // `spawn_capture` 因此返回 Err。原实现写的是 `spawn_capture(..)?` 再去看 Ok 分支的
    // 输出，于是降级路径**永远走不到**——远端是 macOS/BSD 时列目录直接报错。
    // 错误文本里带着远端输出，据此判断。
    let needs_bsd = match &gnu_res {
        Ok(out) => is_unknown_option_err(out),
        Err(e) => is_unknown_option_err(e),
    };
    if !needs_bsd {
        return parse_ls(&gnu_res?, true);
    }
    let mut args_bsd = args;
    args_bsd.push(bsd_cmd);
    let out2 = spawn_capture_off_runtime(ssh_path, args_bsd, creds).await?;
    parse_ls(&out2, false)
}

/// 下载远程文件到本机。`remote` 远程路径，`local` 本机目标路径。
#[tauri::command]
pub async fn ssh_sftp_get(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
    remote: String,
    local: String,
    transfer_id: String,
    overwrite: bool,
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
    let _ = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;

    // 🔴 先下到临时名，成功再 rename。这样**取消或失败永远不会碰到用户原有的文件**——
    // 否则「确认覆盖后下到一半取消」会把原文件毁成半个，而用户在对话框里确认的是
    // 「要么新文件、要么旧文件」，不是碎文件。
    let part = format!("{local}{PART_SUFFIX}");
    let cancel = register_transfer(&state, &transfer_id);
    let hooks = TransferHooks {
        app: Some(app),
        transfer_id: Some(transfer_id.clone()),
        cancel: Some(cancel),
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
fn register_transfer(
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
    }
    Ok(())
}

/// 上传本机文件到远程。`local` 本机源路径，`remote` 远程目标路径。
#[tauri::command]
pub async fn ssh_sftp_put(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    connection_id: String,
    local: String,
    remote: String,
    transfer_id: String,
) -> Result<(), String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    // 上传方向不在这里查重名：当前目录的 `entries` 前端手里已经有，
    // 在后端再查一次就多一次完整的 ssh 握手（本机 OpenSSH 不支持连接复用）。
    let link = fetch_link(&state, &connection_id).await?;
    let _ = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let creds = resolve_link_secrets(&link, &state.data_dir)?;

    let cancel = register_transfer(&state, &transfer_id);
    let hooks = TransferHooks {
        app: Some(app),
        transfer_id: Some(transfer_id.clone()),
        cancel: Some(cancel),
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── 列目录命令：tty 下的引用必须关掉 ─────────────────────

    /// 🔴 回归：helper 会话用 `-tt` 给了远端一个 tty，而 coreutils 在 isatty(stdout)
    /// 时默认用 shell-escape 引用：`my report.txt` 变成 `'my report.txt'`。
    /// `parse_ls` 拿到带引号的名字后，前端拼出的远程路径全部报「No such file」。
    /// 旧的一次性路径（无 `-t`、stdout 是管道）不会引用，所以这个缺陷
    /// 是开了 helper 才出现的，且恰好打掉了“带空格文件名传不了”那个修复。
    #[test]
    fn gnu_ls_disables_tty_quoting() {
        let c = gnu_ls_cmd("/opt/app");
        assert!(c.contains("--quoting-style=literal"), "{c}");
        assert!(c.contains("--time-style=+%s"), "{c}");
        assert!(c.contains("'/opt/app'"), "路径必须带 shell 引号：{c}");
    }

    /// BSD `ls` 没有 `--quoting-style`（给了会直接报错、连降级路径一起废掉）。
    #[test]
    fn bsd_ls_has_no_gnu_only_flags() {
        let c = bsd_ls_cmd("/opt/app");
        assert!(!c.contains("--"), "BSD 降级命令不能带 GNU 长选项：{c}");
        assert!(c.contains("'/opt/app'"), "{c}");
    }

    // ── 跳板机：不配时参数必须逐字节不变 ────────────────────────

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

    // ── ls 解析 ────────────────────────────────────────────────────

    /// GNU 格式：第 6 列是 epoch 秒；名字里的空格不能被截断；软链只取 ` -> ` 前一段。
    #[test]
    fn parse_ls_gnu_handles_spaces_symlinks_and_dot_entries() {
        let out = "total 20\n\
drwxr-xr-x 3 u g 4096 1712345678 .\n\
drwxr-xr-x 5 u g 4096 1712345600 ..\n\
-rw-r--r-- 1 u g 123 1712345690 hello world.txt\n\
lrwxrwxrwx 1 u g 7 1712345695 link -> /tmp/target\n\
drwxr-xr-x 2 u g 4096 1712345700 sub dir\n";
        let e = parse_ls(out, true).expect("解析应成功");
        let names: Vec<&str> = e.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["hello world.txt", "link", "sub dir"],
            "total / . / .. 应跳过，带空格的名字要完整保留"
        );
        assert_eq!(e[0].size, 123);
        assert_eq!(e[0].mtime, 1_712_345_690, "GNU 第 6 列应解成 epoch 秒");
        assert!(!e[0].is_dir && !e[0].is_symlink);
        assert!(e[1].is_symlink, "l 开头应识别为软链");
        assert!(e[2].is_dir, "d 开头应识别为目录");
    }

    /// BSD/macOS 格式：日期占三列，要跳过三列才到名字；mtime 无法可靠得到，置 0。
    #[test]
    fn parse_ls_bsd_skips_three_date_columns() {
        let out = "total 8\n\
drwxr-xr-x  3 u  g   96 Apr  5 10:00 .\n\
-rw-r--r--  1 u  g  123 Apr  5 10:01 hello world.txt\n\
lrwxr-xr-x  1 u  g    7 Apr  5 10:02 link -> /tmp/target\n";
        let e = parse_ls(out, false).expect("解析应成功");
        let names: Vec<&str> = e.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["hello world.txt", "link"]);
        assert_eq!(e[0].size, 123);
        assert_eq!(e[0].mtime, 0, "BSD 日期不可靠转 epoch，约定置 0");
    }

    /// 残缺行不能 panic，也不能产出垃圾条目。
    #[test]
    fn parse_ls_tolerates_truncated_lines() {
        let e = parse_ls("drwxr-xr-x\n-rw-r--r-- 1 u\n\n", true).expect("不应报错");
        assert!(e.is_empty(), "字段不够的行应被跳过，实际：{e:?}");
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
}
