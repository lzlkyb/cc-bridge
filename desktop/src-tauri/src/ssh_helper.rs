//! 每个 SSH 连接一条常驻「helper 会话」，供列目录/建目录/删除这类「请求-响应」操作复用。
//!
//! **为什么需要它**：Windows 自带的 OpenSSH 没有 ControlMaster（不支持连接复用），
//! 所以原先每点进一个目录就是一次完整的 TCP + 认证握手——慢链路上轻松几秒，
//! 超时上限 30 秒。换成往一条已登录的 shell 写一行命令后，只剩网络往返。
//!
//! **此路径失败不影响功能**：调用方在任何错误下都要退回原来的一次性握手路径，
//! 只是慢，不会丢能力（服务器禁 shell、MaxSessions 满都可能让 helper 起不来）。
//!
//! 🔴 安全：明文凭据**仅在登录那一瞬**存在于本模块的局部变量里，不进 `HelperSession`，
//! 不进任何长生命周期结构。

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::ssh_proxy::PendingCreds;

/// 命令输出的开始哨兵前缀。
const START: &str = "__CCB_S_";
/// 命令输出的结束哨兵前缀（后面跟退出码）。
const END: &str = "__CCB_E_";
/// helper 登录就绪的哨兵前缀。
const READY: &str = "__CCB_R_";

/// 单条命令的超时。列目录在已登录的会话上应该是毫秒级，超过这个就当 helper 坏了。
const CMD_TIMEOUT: Duration = Duration::from_secs(15);
/// 登录（含认证）的超时。与一次性握手路径保持一致。
const LOGIN_TIMEOUT: Duration = Duration::from_secs(30);
/// 空闲多久后回收。服务器端 `MaxSessions` 默认只有 10，不能白占着。
pub const HELPER_IDLE_TTL: Duration = Duration::from_secs(300);
/// 输出缓冲上限。防止一条误用的命令（如 `cat 大文件`）把内存吃光。
const MAX_BUF: usize = 4 * 1024 * 1024;
/// 轮询输出缓冲的间隔。太密空转 CPU，太疏拉高延迟。
const POLL: Duration = Duration::from_millis(20);

/// 全局递增计数，用于生成唯一 nonce。
///
/// 不用时间戳：既不需要不可预测性（哨兵不是安全边界，只是分隔符），
/// 只需要「同一进程内不重复」，递增计数是最简单且不会出错的做法。
static NONCE: AtomicU64 = AtomicU64::new(0);

fn next_nonce() -> String {
    format!(
        "{:x}_{:x}",
        std::process::id(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    )
}

/// 拼出发给远端的一行：开始哨兵 + 命令 + 结束哨兵（带退出码）。
///
/// 用 `printf` 而不是 `echo`：`echo` 对反斜杠的处理在各 shell 里不一致。
pub fn wrap_command(nonce: &str, cmd: &str) -> String {
    format!("printf '\\n{START}{nonce}__\\n'; {cmd}; printf '\\n{END}{nonce}_%d__\\n' $?\n")
}

/// 从输出缓冲里抽出一次命令的结果：（输出, 退出码）。还没跑完则返回 None。
///
/// 🔴 判据是「**整行恰好等于裸哨兵**」，这是整个方案能不能立住的关键：
/// PTY 会把我们写进去的命令**回显**出来，缓冲里先出现的是
/// `printf '\n__CCB_S_x__\n'; ls -la …` 这一整行——它包含哨兵字样但**不等于**裸哨兵，
/// 所以用相等而不是 `contains` 就能天然区分。
/// （helper 建立后还会发 `stty -echo` 双保险，但不能只靠它：部分环境里 `stty` 不可用。）
pub fn scan_result(buf: &str, nonce: &str) -> Option<(String, i32)> {
    let start_line = format!("{START}{nonce}__");
    let end_prefix = format!("{END}{nonce}_");
    let mut started = false;
    let mut out: Vec<&str> = Vec::new();
    for raw in buf.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if !started {
            if line == start_line {
                started = true;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix(&end_prefix) {
            let code = rest.strip_suffix("__")?.parse::<i32>().ok()?;
            return Some((out.join("\n"), code));
        }
        out.push(line);
    }
    None
}

/// 登录就绪哨兵是否已出现（同样要求整行相等，理由同上）。
pub fn ready_seen(buf: &str, nonce: &str) -> bool {
    let want = format!("{READY}{nonce}__");
    buf.lines()
        .any(|l| l.strip_suffix('\r').unwrap_or(l) == want)
}

/// 远端命令：先报就绪，再把自己换成一个干净的 `sh`。
///
/// 为什么要 `exec /bin/sh`：用户的登录 shell 可能是 fish（退出码是 `$status` 而非 `$?`）
/// 或带一堆 rc 输出的 zsh。`sh` 几乎一定存在且行为确定。
fn bootstrap_cmd(nonce: &str) -> String {
    format!("printf '\\n{READY}{nonce}__\\n'; exec /bin/sh")
}

/// 一条已登录的常驻会话。
pub struct HelperSession {
    /// 保持 master 存活：drop 它等于关掉 PTY。
    _master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    output: Arc<StdMutex<String>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    last_used: Instant,
}

impl HelperSession {
    /// 建立并登录。**阻塞**，调用方要放在 `spawn_blocking` 里。
    ///
    /// `creds` 里的明文仅在本函数内使用，不会被存进返回的结构体。
    /// 走跳板机时一次连接有**两段登录**，该由哪个槽回答哪个提示交给 `PendingCreds`。
    pub fn open(
        ssh: &Path,
        base_args: &[String],
        target: &str,
        creds: PendingCreds,
        is_password_prompt: fn(&str) -> bool,
        is_passphrase_prompt: fn(&str) -> bool,
    ) -> Result<Self, String> {
        let nonce = next_nonce();
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 40,
                cols: 200,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("打开 PTY 失败：{e}"))?;

        let mut cmd = CommandBuilder::new(ssh);
        for a in base_args {
            cmd.arg(a);
        }
        // -tt 强制分配 PTY：带远端命令时 ssh 默认不分配，而我们需要一个能持续读 stdin 的 shell。
        cmd.arg("-tt");
        cmd.arg(target);
        cmd.arg(bootstrap_cmd(&nonce));

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("获取 PTY 读取端失败：{e}"))?;
        // mut：登录循环里要 `try_wait()` 提前发现子进程已退。
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("启动 ssh 失败：{e}"))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("获取 PTY 写入端失败：{e}"))?;

        let output = Arc::new(StdMutex::new(String::new()));
        let out_for_reader = output.clone();
        // reader 线程：只负责累积输出。凭据填充由下面的登录循环同步做，
        // 不把 writer 分享给线程——否则写命令与写密码会竞争同一个写端。
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut s = out_for_reader.lock().unwrap();
                        if s.len() < MAX_BUF {
                            s.push_str(&String::from_utf8_lossy(&buf[..n]));
                        }
                    }
                }
            }
        });

        // 登录循环：等就绪哨兵，期间看到密码/密码短语提示就填一次。
        let deadline = Instant::now() + LOGIN_TIMEOUT;
        let mut creds = creds;
        let mut scanned = 0usize; // 已判过提示的位置，避免重复填
        loop {
            {
                let s = output.lock().unwrap();
                if ready_seen(&s, &nonce) {
                    break;
                }
                if s.len() > scanned {
                    let fresh = &s[scanned..];
                    if creds.has_any() {
                        let filled = if is_password_prompt(fresh) {
                            creds.take_password(fresh)
                        } else if is_passphrase_prompt(fresh) {
                            creds.take_passphrase(fresh)
                        } else {
                            None
                        };
                        if let Some(secret) = filled {
                            let _ = writer.write_all(secret.as_bytes());
                            let _ = writer.write_all(b"\n");
                            let _ = writer.flush();
                        }
                    }
                    scanned = s.len();
                }
            }
            // 🔴 子进程已退就立即失败，不要空转满 30 秒。
            // 服务器禁 shell / 没有 /bin/sh / 认证失败时 ssh 是**秒退**的，而 reader 线程
            // 读到 EOF 只 `break`、不通知本循环。之前的后果：白等 30 秒 → 退回一次性路径
            // 再 30 秒 → 还可能 BSD 降级再 30 秒，共约 90 秒，而且每次列目录重复一遍。
            if !matches!(child.try_wait(), Ok(None)) {
                let tail = output.lock().unwrap().clone();
                return Err(format!("helper 会话启动失败：{}", tail_of(&tail)));
            }
            if Instant::now() >= deadline {
                let mut c = child;
                let _ = c.kill();
                let tail = output.lock().unwrap().clone();
                return Err(format!("helper 会话登录超时：{}", tail_of(&tail)));
            }
            std::thread::sleep(POLL);
        }

        let mut me = Self {
            _master: pair.master,
            writer,
            output,
            child,
            last_used: Instant::now(),
        };
        // 关回显 + 清提示符：双保险（scan_result 已经能抗回显，但少一堆噪声更好调）。
        // 部分精简镜像里没有 stty，所以失败不能影响结果。
        let _ = me.run("stty -echo 2>/dev/null; PS1=''; PS2=''");
        Ok(me)
    }

    /// 跑一条命令，返回（stdout+stderr 合并的输出, 退出码）。**阻塞**。
    pub fn run(&mut self, cmd: &str) -> Result<(String, i32), String> {
        if !self.alive() {
            return Err("helper 会话已退出".into());
        }
        let nonce = next_nonce();
        // 每条命令前清空缓冲：只关心本次的输出，顺便防止无限增长。
        self.output.lock().unwrap().clear();
        let line = wrap_command(&nonce, cmd);
        self.writer
            .write_all(line.as_bytes())
            .and_then(|_| self.writer.flush())
            .map_err(|e| format!("写 helper 会话失败：{e}"))?;

        let deadline = Instant::now() + CMD_TIMEOUT;
        loop {
            {
                let s = self.output.lock().unwrap();
                if let Some((out, code)) = scan_result(&s, &nonce) {
                    drop(s);
                    self.last_used = Instant::now();
                    return Ok((out, code));
                }
            }
            if Instant::now() >= deadline {
                return Err("helper 会话命令超时".into());
            }
            std::thread::sleep(POLL);
        }
    }

    /// 进程还活着吗。
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn idle_for(&self) -> Duration {
        self.last_used.elapsed()
    }

    pub fn close(&mut self) {
        let _ = self.writer.write_all(b"exit\n");
        let _ = self.writer.flush();
        let _ = self.child.kill();
    }
}

/// 🔴 有了 Drop，丢掉 `HelperSession` 就一定会杀掉 ssh 子进程。
///
/// 为何必需：`AppState::drop_ssh_helper` 用 `try_lock`，拿不到锁（正在跑命令）时
/// 只从 map 里摘除而不调 `close()`。没有 Drop 的话，那条会话就再没人管得着了——
/// 而“关掉 SSH 总开关”这个断路器正是靠 `drop_ssh_helper` 实现的，它宣称
/// “关了就不能还有任何存活的 SSH 连接”。现在摆脱 Arc 后必然收尾，
/// 最晚到正在跑的那条命之后。
impl Drop for HelperSession {
    fn drop(&mut self) {
        self.close();
    }
}

/// 错误提示只带末尾一小段：完整的 ssh 诊断输出可能很长，而有用信息总在最后。
fn tail_of(s: &str) -> String {
    let t = s.trim();
    let start = t.len().saturating_sub(200);
    t[start..].replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: &str = "abc123";

    /// 🔴 核心回归：**PTY 回显行不得被当成哨兵**。
    ///
    /// 回显出来的是整条命令（含 `printf '\n__CCB_S_…`），它 `contains` 哨兵但不等于哨兵。
    /// 若判据写成 contains，输出会从回显行就开始截，拿到一堆垃圾。
    #[test]
    fn echo_line_is_not_mistaken_for_sentinel() {
        let buf = format!(
            "{}\n__CCB_S_{N}__\ntotal 4\ndrwxr-xr-x 2 root root\n__CCB_E_{N}_0__\n",
            wrap_command(N, "ls -la").trim_end()
        );
        let (out, code) = scan_result(&buf, N).expect("应该能解析出结果");
        assert_eq!(code, 0);
        assert_eq!(out, "total 4\ndrwxr-xr-x 2 root root");
        assert!(!out.contains("printf"), "回显行漏进了输出");
    }

    #[test]
    fn returns_none_until_end_sentinel_arrives() {
        let partial = format!("__CCB_S_{N}__\ntotal 4\n");
        assert!(scan_result(&partial, N).is_none());
    }

    #[test]
    fn captures_nonzero_exit_code() {
        let buf = format!("__CCB_S_{N}__\nls: no such file\n__CCB_E_{N}_2__\n");
        let (out, code) = scan_result(&buf, N).unwrap();
        assert_eq!(code, 2);
        assert_eq!(out, "ls: no such file");
    }

    #[test]
    fn empty_output_is_fine() {
        let buf = format!("__CCB_S_{N}__\n__CCB_E_{N}_0__\n");
        assert_eq!(scan_result(&buf, N).unwrap(), (String::new(), 0));
    }

    /// CRLF：PTY 会把 `\n` 变成 `\r\n`，哨兵行末尾带 `\r` 必须仍然能识别。
    #[test]
    fn tolerates_crlf_from_pty() {
        let buf = format!("__CCB_S_{N}__\r\nhello\r\n__CCB_E_{N}_0__\r\n");
        let (out, code) = scan_result(&buf, N).unwrap();
        assert_eq!(code, 0);
        assert_eq!(out, "hello");
    }

    /// 不同 nonce 的残留输出不能被当成本次结果。
    #[test]
    fn other_nonce_is_ignored() {
        let buf = "__CCB_S_other__\nstale\n__CCB_E_other_0__\n";
        assert!(scan_result(buf, N).is_none());
    }

    /// 输出里出现长得像哨兵的文本（但 nonce 不对）不干扰解析。
    #[test]
    fn lookalike_text_in_output_does_not_break_parsing() {
        let buf = format!("__CCB_S_{N}__\n__CCB_E_wrong_0__\nreal output\n__CCB_E_{N}_0__\n");
        let (out, code) = scan_result(&buf, N).unwrap();
        assert_eq!(code, 0);
        assert_eq!(out, "__CCB_E_wrong_0__\nreal output");
    }

    #[test]
    fn ready_requires_exact_line() {
        assert!(ready_seen(&format!("noise\n__CCB_R_{N}__\nmore"), N));
        assert!(ready_seen(&format!("__CCB_R_{N}__\r\n"), N));
        // 启动命令本身被回显时不算就绪
        assert!(!ready_seen(&bootstrap_cmd(N), N));
    }
}
