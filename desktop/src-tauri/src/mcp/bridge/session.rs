//! 把“进程”与“协议”拼起来：一个活着的外挂 server 会话。
//!
//! `spawn` 只管拉起进程，`client` 只管说协议，两者互不相识——合体在这里。

use std::collections::VecDeque;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use process_wrap::std::StdChildWrapper;

use super::client::Client;
use super::config::ExternalMcpServer;
use super::spawn;

/// stderr 最多留多少行给诊断用。
const STDERR_KEEP_LINES: usize = 30;

/// 关闭时等它自己退的宽限。实测 codegraph 在此期间两个 node 都干净退了。
pub const GRACE: Duration = Duration::from_secs(3);

/// 关闭方式。测试靠它断定“到底是它自己走的还是被杀的”。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ShutdownHow {
    /// 读到 stdin 的 EOF 后自己退了——MCP stdio 的约定路径。
    Graceful,
    /// 不响应 EOF，走了 JobObject / 进程组兜底。
    Forced,
}

pub struct Session {
    child: Box<dyn StdChildWrapper>,
    /// 用 `Option` 是为了关闭时能 `take()` 掉它——**drop client 就是关 stdin**，
    /// 而那正是优雅退出的触发条件。
    client: Option<Client>,
    stderr_tail: StderrTail,
}

/// server 写到 stderr 的最后几行。启动失败时真正的原因往往只在这里。
pub type StderrTail = Arc<Mutex<VecDeque<String>>>;

/// 手写：`Box<dyn StdChildWrapper>` 没有 Debug，而 `Result<Session, _>::expect_err`
/// 要求 `T: Debug`，没它连测试都写不了。**不得打印报文与 env**。
impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("alive", &self.client.is_some())
            .finish()
    }
}

impl Session {
    pub fn client(&mut self) -> Result<&mut Client, String> {
        self.client.as_mut().ok_or_else(|| "会话已关闭".to_string())
    }

    /// server 写到 stderr 的最后几行。启动失败时真正的原因往往只在这里。
    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail
            .lock()
            .map(|q| q.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 关闭：**先关 stdin，JobObject 兜底**。
    ///
    /// 🔴 顺序不能反。实测（2026-08-07）：直接 `child.kill()` 只能杀掉第二层（cmd.exe），
    /// 留下两个孤儿 node；而关掉 stdin 后它们会自己干净退出。
    /// 第三步的强杀不是为 codegraph 准备的，是为“将来某个不响应 EOF 的 server”准备的。
    pub fn shutdown(&mut self, grace: Duration) -> ShutdownHow {
        drop(self.client.take()); // ① 关 stdin

        let deadline = Instant::now() + grace; // ② 给它一个自己走的窗口
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return ShutdownHow::Graceful,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }

        let _ = self.child.start_kill(); // ③ 杀整树（Windows: TerminateJobObject）
        let _ = self.child.wait();
        ShutdownHow::Forced
    }
}

/// 启动并握手。失败时尽量把 stderr 尾巴带进错误里——那里才有真正的原因。
pub fn connect(
    spec: &ExternalMcpServer,
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<Session, String> {
    if !spec.is_stdio() {
        return Err(format!(
            "第一步只支持 stdio 型 MCP server，`{}` 的类型是 `{}`。",
            spec.name, spec.transport
        ));
    }

    let program = spawn::resolve_program(&spec.command)?;

    // 🔴 S8 的第二道卡（第一道在导入时）。用户可能绕过导入手加，
    // 而自己桥自己是无限套娃：远程 → cc-bridge → mcp_proxy → cc-bridge → …
    // 判断靠路径不靠名字（名字是用户随便取的）。
    if spawn::is_self_executable(&program) {
        return Err(format!(
            "`{}` 指向的就是 cc-bridge 自己，不能把自己作为外挂 server 桥接。\
             远程本来就直连着 cc-bridge，内置工具已在工具列表里。",
            spec.name
        ));
    }

    // cwd 由调用方给：连接池已经把「远程覆盖值 or 配置值」合并好了。
    // 不在这里再读 `spec.cwd`——两处都能决定工作目录的话，总会有一处忘了同步。
    let mut child = spawn::spawn_stdio_server(&program, &spec.args, &spec.env, cwd)?;

    // 🔴 进程已经跑起来了。从这行开始，任何失败都必须**亲手杀掉它**。
    //
    // 不能靠 drop：我们的 JobObject 是 `kill_on_drop = false` 建的（没置
    // `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），Unix 侧也没有 Drop 杀。而握手超时
    // 是真会发生的（默认 60s）：漏一次就残留一棵进程树，而 30s 退避后
    // 每次调用再拉起一个，孤儿会累积。
    match handshake_on(&mut child, timeout) {
        Ok((client, stderr_tail)) => Ok(Session {
            child,
            client: Some(client),
            stderr_tail,
        }),
        Err(e) => {
            let _ = child.start_kill();
            let _ = child.wait();
            Err(e)
        }
    }
}

/// 接管三根管道并握手。拆出来只为一件事：让调用方能在**单一出口**上收尾进程。
/// 内联写的话有四个 `?` 分支，每个都得记得杀一次——总会漏。
fn handshake_on(
    child: &mut Box<dyn StdChildWrapper>,
    timeout: Duration,
) -> Result<(Client, StderrTail), String> {
    let stdin = child.stdin().take().ok_or("拿不到子进程 stdin")?;
    let stdout = child.stdout().take().ok_or("拿不到子进程 stdout")?;
    let stderr = child.stderr().take().ok_or("拿不到子进程 stderr")?;

    // 🔴 stderr **必须**排空。不读的话，一个唠叨的 server 会把管道缓冲区写满，
    // 然后**阻塞在 write 上**——表现是它什么都不干了，而我们在等 stdout 直到超时。
    let stderr_tail = drain_stderr(stderr);

    let client = Client::handshake(stdout, stdin, timeout).map_err(|e| {
        let tail = stderr_tail
            .lock()
            .map(|q| q.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        if tail.is_empty() {
            e
        } else {
            format!("{e}\nserver 的 stderr：\n{}", tail.join("\n"))
        }
    })?;

    Ok((client, stderr_tail))
}

/// 排空 stderr，只留最后几行。
///
/// 对照 CLAUDE.md §8.1：阻塞读为让出点；读到 EOF / 出错都**显式退出线程**；
/// 无轮询无定时器；行数有上限（VecDeque 定长），不会无限增长。
fn drain_stderr<R: Read + Send + 'static>(r: R) -> Arc<Mutex<VecDeque<String>>> {
    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_KEEP_LINES)));
    let sink = Arc::clone(&tail);
    std::thread::spawn(move || {
        let mut buf = std::io::BufReader::new(r);
        let mut line = Vec::new();
        loop {
            line.clear();
            // 按字节读：stderr 上的 GBK 日志很常见，不能因为不是 UTF-8 就停下来。
            match std::io::BufRead::read_until(&mut buf, b'\n', &mut line) {
                Ok(0) => return,  // EOF
                Err(_) => return, // 管道出错，收工
                Ok(_) => {}
            }
            let s = String::from_utf8_lossy(&line).trim_end().to_string();
            if s.is_empty() {
                continue;
            }
            let Ok(mut q) = sink.lock() else { return };
            if q.len() == STDERR_KEEP_LINES {
                q.pop_front();
            }
            q.push_back(s);
        }
    });
    tail
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个**不理会 stdin**、会活很久的真实进程。
    /// Windows 用 ping（顺带造出 cmd → ping 的两层进程树），Unix 用 sleep。
    fn long_running() -> (&'static str, Vec<String>) {
        #[cfg(windows)]
        {
            (
                "cmd",
                vec![
                    "/c".into(),
                    "ping".into(),
                    "-n".into(),
                    "30".into(),
                    "127.0.0.1".into(),
                ],
            )
        }
        #[cfg(not(windows))]
        {
            ("sh", vec!["-c".into(), "sleep 30".into()])
        }
    }

    /// B8：server 不响应 EOF → 宽限过后走 JobObject / 进程组兜底杀掉，不能挂在那里。
    ///
    /// 这是整个 bridge 里**唯一需要真进程**的用例（其余都走内存管道）。
    /// 树式击杀本身由 process-wrap 保证，并已用探针实测过；这里守的是
    /// “宽限到了就必须强杀”这条控制流。
    #[test]
    fn unresponsive_server_is_force_killed_after_grace() {
        let (cmd, args) = long_running();
        let program = spawn::resolve_program(cmd).expect("系统自带的命令应能解析到");
        let mut child = spawn::spawn_stdio_server(&program, &args, &[], None).expect("启动");

        // 把 stdin 拿出来再丢掉 = 给它送 EOF。ping / sleep 根本不看 stdin，
        // 所以它们会继续跑——正是我们要模拟的“不响应 EOF”。
        drop(child.stdin().take());

        let mut s = Session {
            child,
            client: None,
            stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
        };

        let t0 = Instant::now();
        let how = s.shutdown(Duration::from_millis(300));
        assert_eq!(how, ShutdownHow::Forced, "不响应 EOF 就必须被强杀");
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "强杀不能挂在那里，实际耗时 {:?}",
            t0.elapsed()
        );
        assert!(
            matches!(s.child.try_wait(), Ok(Some(_))),
            "shutdown 返回后进程必须已退出"
        );
    }

    /// 非 stdio 类型直接拒，不要启进程再发现不对。
    #[test]
    fn non_stdio_transport_is_rejected_before_spawning() {
        let spec = ExternalMcpServer {
            name: "remote".into(),
            transport: "http".into(),
            command: "whatever".into(),
            args: vec![],
            env: vec![],
            cwd: None,
            enabled: true,
            allow_remote_cwd: false,
        };
        let err = connect(&spec, None, Duration::from_secs(1)).expect_err("应拒绝");
        assert!(err.contains("stdio"), "实际：{err}");
    }

    /// 🔴 S8：command 指向 cc-bridge 自己 → 拒绝（第二道卡）。
    #[test]
    fn self_reference_is_rejected() {
        let me = std::env::current_exe().expect("current_exe");
        let spec = ExternalMcpServer {
            // 故意取一个不相干的名字：判定必须靠路径，不能靠名字。
            name: "totally-unrelated".into(),
            transport: "stdio".into(),
            command: me.to_string_lossy().into_owned(),
            args: vec![],
            env: vec![],
            cwd: None,
            enabled: true,
            allow_remote_cwd: false,
        };
        let err = connect(&spec, None, Duration::from_secs(1)).expect_err("应拒绝");
        assert!(err.contains("cc-bridge 自己"), "实际：{err}");
    }
}
