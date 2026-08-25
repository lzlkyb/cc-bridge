//! SSH 终端的 IPC 命令：可用性检测、连接、输入、缩放、断开、列表读取，
//! 以及密钥登录 + SFTP 文件传输（list/get/put/mkdir/remove）。
//!
//! 范围：人在面板手动操作交互终端 + 远程 Linux 登录（密码 / 私钥 + 密码短语），
//! 并支持在面板内做 SFTP 文件传输。后端用系统自带 OpenSSH（Windows/macOS 自带）
//! + `portable_pty` 提供的 PTY（Windows=ConPTY / Unix=pty），输出经
//! `app.emit("ssh_output", ...)` 事件流推前端；SFTP 传输复用同一套「PTY + 凭据自动填充」机制，
//! 只是把输出捕获成结构化结果而非流式推屏。
//!
//! 🔴 安全：SSH 凭据只经 Tauri IPC 写入本机（`save_config` patch），绝不注册为 MCP 工具，
//! 不向远程 Claude Code 暴露（对齐 `external_mcp_servers` 注释，S1）。密码/密码短语以 aes-gcm
//! 密文存配置库，明文仅在「记住」自动填充那一瞬存在于内存。

use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::config::SshConnection;
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

/// 拼 ssh/scp 通用连接选项。`port_flag` 区分 ssh 的 `-p` 与 scp 的 `-P`。
/// 密钥认证时追加 `-i <key_path>`（仅当路径非空）。
fn ssh_base_args(conn: &SshConnection, port_flag: &str) -> Vec<String> {
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

/// 跑一次 scp，优先带 `-s`（强制 SFTP 协议），老版本不认这个选项时回退。
///
/// 🔴 为什么非要 `-s`：不带它时 scp 可能走**遗留 SCP 协议**，那条路径上远程路径
/// 会被远端 shell 展开（CVE-2020-15778 一类），下载方向还存在恶意服务端投放额外
/// 文件的历史问题（CVE-2019-6111）。而这里的远程路径来自 `parse_ls` 解出的
/// **远端文件名**，正是远端可控的输入。
///
/// `-s` 是 OpenSSH 8.6+ 才有的选项，所以必须能回退——同本文件 `ls` 的 GNU/BSD 降级写法。
fn run_scp(
    scp: &PathBuf,
    base: &[String],
    pw: Option<String>,
    pp: Option<String>,
) -> Result<(), String> {
    const SCP_TIMEOUT: Duration = Duration::from_secs(600);
    let mut forced_sftp = vec!["-s".to_string()];
    forced_sftp.extend_from_slice(base);
    match spawn_capture(scp, &forced_sftp, pw.clone(), pp.clone(), SCP_TIMEOUT) {
        Ok(_) => Ok(()),
        Err(e) if is_unknown_option_err(&e) => {
            spawn_capture(scp, base, pw, pp, SCP_TIMEOUT).map(|_| ())
        }
        Err(e) => Err(e),
    }
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

/// 在 PTY 里跑一次性命令（ssh 远程命令 / scp 传输），捕获全部输出并自动填充
/// 密码/密码短语，等待进程退出（带超时），返回捕获到的输出字符串。
///
/// 与交互终端 `ssh_connect` 共用「PTY + 凭据自动填充」机制，但输出不推屏、而是
/// 收集成字符串返回，便于 SFTP 这类「请求-响应」操作做结构化解析。
fn spawn_capture(
    program: &PathBuf,
    args: &[String],
    auto_password: Option<String>,
    auto_passphrase: Option<String>,
    timeout: Duration,
) -> Result<String, String> {
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
        let mut pending_pw = auto_password;
        let mut pending_pp = auto_passphrase;
        // 认证窗口：过期即丢弃待填凭据，不再对任何输出反应（见 CREDENTIAL_FILL_WINDOW）。
        let fill_deadline = Instant::now() + CREDENTIAL_FILL_WINDOW;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    {
                        let mut s = cap_for_reader.lock().unwrap();
                        s.push_str(&String::from_utf8_lossy(chunk));
                    }
                    // 窗口关闭：立即丢弃明文，不让它在内存里挂着，也不再可能被误触。
                    if Instant::now() >= fill_deadline {
                        pending_pw = None;
                        pending_pp = None;
                    }
                    if let Some(pw) = pending_pw.take() {
                        if password_prompt_in(chunk) {
                            if let Ok(mut w) = master.take_writer() {
                                let _ = w.write_all(pw.as_bytes());
                                let _ = w.write_all(b"\n");
                                let _ = w.flush();
                            }
                        } else {
                            // 提示还没来，继续等（受上面的时间窗约束）。
                            pending_pw = Some(pw);
                        }
                    }
                    if let Some(pp) = pending_pp.take() {
                        if passphrase_prompt_in(chunk) {
                            if let Ok(mut w) = master.take_writer() {
                                let _ = w.write_all(pp.as_bytes());
                                let _ = w.write_all(b"\n");
                                let _ = w.flush();
                            }
                        } else {
                            pending_pp = Some(pp);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = prompt_tx.send(());
    });

    // monitor：等 reader 收尾（=进程退出）或超时；超时则强杀。
    let (done_tx, done_rx) = mpsc::channel::<Result<portable_pty::ExitStatus, String>>();
    std::thread::spawn(move || match prompt_rx.recv_timeout(timeout) {
        Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => {
            let st = child.wait().map_err(|e| format!("等待进程失败：{e}"));
            let _ = done_tx.send(st);
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = done_tx.send(Err("操作超时（网络不通或远程无响应），请重试".into()));
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
    Ok(())
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

    // 2) 取连接配置。
    let conn = {
        let config = state.config.read().await;
        config
            .ssh_connections
            .iter()
            .find(|c| c.id == args.connection_id)
            .cloned()
            .ok_or_else(|| format!("未找到 SSH 连接：{}", args.connection_id))?
    };

    // 3) 解析 ssh 路径（理论上前端已用 ssh_check 拦过，这里再守一层）。
    let ssh_path = find_ssh().ok_or_else(|| {
        "未检测到系统 OpenSSH 客户端，无法连接。请在 Windows 可选功能中启用「OpenSSH 客户端」"
            .to_string()
    })?;

    // 4) 凭据解析：密码 / 密码短语（仅此刻在内存出现明文，用过即丢）。
    let (auto_password, auto_passphrase) = resolve_secrets(&conn, &state.data_dir)?;

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
    for a in ssh_base_args(&conn, "-p") {
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
    let app2 = app.clone();
    let app_state = state.inner().clone();
    let sid = session_id.clone();
    let spawn_time = Instant::now();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending_pw = auto_password;
        let mut pending_pp = auto_passphrase;
        // 认证窗口：过期即丢弃待填凭据。密钥认证成功时密码提示永远不会到来，
        // 没有这道线密码就会在已登录的 shell 里继续待命（见 CREDENTIAL_FILL_WINDOW）。
        let fill_deadline = Instant::now() + CREDENTIAL_FILL_WINDOW;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF：ssh 进程结束
                Ok(n) => {
                    let chunk = &buf[..n];
                    let _ = app2.emit(
                        "ssh_output",
                        SshOutput {
                            session_id: sid.clone(),
                            data: String::from_utf8_lossy(chunk).to_string(),
                        },
                    );
                    // 窗口关闭：立即丢弃明文，不让它在内存里挂着，也不再可能被误触。
                    if Instant::now() >= fill_deadline {
                        pending_pw = None;
                        pending_pp = None;
                    }
                    // 密码自动填充：本块是真正的密码提示且还有待填密码，则写密码 + 回车。
                    if let Some(pw) = pending_pw.take() {
                        if password_prompt_in(chunk) {
                            if let Some(entry) = app_state.ssh_sessions.get(&sid) {
                                if let Ok(mut w) = entry.writer.lock() {
                                    let _ = w.write_all(pw.as_bytes());
                                    let _ = w.write_all(b"\n");
                                    let _ = w.flush();
                                }
                            }
                        } else {
                            // 提示还没来，继续等（受上面的时间窗约束）。
                            pending_pw = Some(pw);
                        }
                    }
                    // 密钥密码短语自动填充（key 认证 + 记住密码短语时）。
                    if let Some(pp) = pending_pp.take() {
                        if passphrase_prompt_in(chunk) {
                            if let Some(entry) = app_state.ssh_sessions.get(&sid) {
                                if let Ok(mut w) = entry.writer.lock() {
                                    let _ = w.write_all(pp.as_bytes());
                                    let _ = w.write_all(b"\n");
                                    let _ = w.flush();
                                }
                            }
                        } else {
                            pending_pp = Some(pp);
                        }
                    }
                }
                Err(_) => break,
            }
        }
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
            eprintln!("[SSH] 连接早期失败 session={}（ssh 进程在宽限期内退出）", &sid[..8.min(sid.len())]);
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
    #[cfg(debug_assertions)]
    eprintln!(
        "[SSH] input session={} data={:?}",
        &session_id[..8.min(session_id.len())],
        data
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

/// 取连接配置（按 id），找不到报错。改为 async 读，避免在 tokio worker 上阻塞。
async fn fetch_conn(state: &State<'_, Arc<AppState>>, id: &str) -> Result<SshConnection, String> {
    let c = state.config.read().await;
    c.ssh_connections
        .iter()
        .find(|x| x.id == id)
        .cloned()
        .ok_or_else(|| format!("未找到 SSH 连接：{id}"))
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
    let conn = fetch_conn(&state, &connection_id).await?;
    let ssh_path =
        find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端，无法列目录".to_string())?;
    let (pw, pp) = resolve_secrets(&conn, &state.data_dir)?;
    let mut args = ssh_base_args(&conn, "-p");
    args.push(format!("{}@{}", conn.username, conn.host));
    // GNU coreutils 支持 `--time-style=+%s`（把 mtime 输出成 epoch 秒，便于排序）；
    // macOS/BSD 的 `ls` 不支持该选项（会报 `illegal option`），此时退化为默认
    // `ls -la`，mtime 解析不到（前端显示「未知」）。先试 GNU，命中报错再退化。
    let gnu_cmd = format!("ls -la --time-style=+%s {}", shell_quote(&path));
    let bsd_cmd = format!("ls -la {}", shell_quote(&path));
    let mut args_gnu = args.clone();
    args_gnu.push(gnu_cmd);
    let gnu_res = spawn_capture(
        &ssh_path,
        &args_gnu,
        pw.clone(),
        pp.clone(),
        Duration::from_secs(30),
    );
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
    let out2 = spawn_capture(&ssh_path, &args_bsd, pw, pp, Duration::from_secs(30))?;
    parse_ls(&out2, false)
}

/// 下载远程文件到本机。`remote` 远程路径，`local` 本机目标路径。
#[tauri::command]
pub async fn ssh_sftp_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    remote: String,
    local: String,
) -> Result<(), String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let conn = fetch_conn(&state, &connection_id).await?;
    let _ = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let (pw, pp) = resolve_secrets(&conn, &state.data_dir)?;
    let mut args = vec!["-q".into()];
    args.extend(ssh_base_args(&conn, "-P"));
    args.push(format!("{}@{}:{}", conn.username, conn.host, remote));
    args.push(local.clone());
    run_scp(&scp_path, &args, pw, pp)
}

/// 上传本机文件到远程。`local` 本机源路径，`remote` 远程目标路径。
#[tauri::command]
pub async fn ssh_sftp_put(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    local: String,
    remote: String,
) -> Result<(), String> {
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用".into());
    }
    let conn = fetch_conn(&state, &connection_id).await?;
    let _ = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let scp_path =
        find_scp().ok_or_else(|| "未检测到系统 scp 客户端（OpenSSH 客户端缺失）".to_string())?;
    let (pw, pp) = resolve_secrets(&conn, &state.data_dir)?;
    let mut args = vec!["-q".into()];
    args.extend(ssh_base_args(&conn, "-P"));
    args.push(local.clone());
    args.push(format!("{}@{}:{}", conn.username, conn.host, remote));
    run_scp(&scp_path, &args, pw, pp)
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
    let conn = fetch_conn(&state, &connection_id).await?;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let (pw, pp) = resolve_secrets(&conn, &state.data_dir)?;
    let remote_cmd = format!("mkdir -p {}", shell_quote(&path));
    let mut args = ssh_base_args(&conn, "-p");
    args.push(format!("{}@{}", conn.username, conn.host));
    args.push(remote_cmd);
    spawn_capture(&ssh_path, &args, pw, pp, Duration::from_secs(30))?;
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
    let conn = fetch_conn(&state, &connection_id).await?;
    let ssh_path = find_ssh().ok_or_else(|| "未检测到系统 OpenSSH 客户端".to_string())?;
    let (pw, pp) = resolve_secrets(&conn, &state.data_dir)?;
    let remote_cmd = format!("rm -rf {}", shell_quote(&path));
    let mut args = ssh_base_args(&conn, "-p");
    args.push(format!("{}@{}", conn.username, conn.host));
    args.push(remote_cmd);
    spawn_capture(&ssh_path, &args, pw, pp, Duration::from_secs(30))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// 带单引号的文件名不能逃出引号变成远程命令。
    #[test]
    fn shell_quote_neutralises_single_quotes() {
        assert_eq!(shell_quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        // 典型注入尝试：先闭引号再用分号接命令
        assert_eq!(shell_quote("a'; rm -rf /; '"), "'a'\\''; rm -rf /; '\\'''");
    }
}
