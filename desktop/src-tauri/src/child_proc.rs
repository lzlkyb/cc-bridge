//! 带超时的子进程输出采集。
//!
//! ## 为什么需要
//!
//! `std::process::Command::output()` 会**一直**等到子进程退出，没有上限。而这个应用里
//! 有若干处同步拉起 `powershell` / `netsh` 的调用，其中防火墙能力探测位于 Tauri 的
//! `setup` 回调（主线程、窗口 `show()` 之前）。断网、杀软云查杀、组策略脚本的环境下，
//! 这类进程可能几十秒甚至永远不返回 —— 窗口迟迟不出现，Windows 直接判定「未响应」并
//! 提示结束进程。用户侧看到的就是「断网后软件卡死转圈」。
//!
//! ## 实现取舍
//!
//! 必须**先起读线程、再轮询 `try_wait`**：
//!
//! - 若先 `wait()` 再读管道，子进程输出超过管道缓冲（Windows 约 64KB）时会阻塞在
//!   `write`，父进程阻塞在 `wait` —— 双方互等，死锁。防火墙诊断脚本枚举全量规则时
//!   的输出就有几十 KB，这个风险是真实的。
//! - 若先读完再 `wait()`，正常退出没问题，但超时时读线程会永久挂在 `read` 上，
//!   必须靠 `kill` 关掉管道才能解开 —— 所以 `kill → wait → join` 的顺序不能反。
//!
//! 轮询间隔 10ms：这些调用本来就要几百毫秒到几秒，10ms 的唤醒开销可以忽略，换来的是
//! 超时判定的及时性（不会因为对方卡死而多等一个轮询周期之外的时间）。

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// 轮询 `try_wait` 的间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// 在 `timeout` 内收集子进程的退出状态与全部输出；超时则 kill 并返回
/// [`std::io::ErrorKind::TimedOut`]。
///
/// 调用方负责把 `stdin`/`stdout`/`stderr` 之外的配置（参数、环境变量、
/// `creation_flags`）设好 —— 本函数只覆盖这三个流：`stdin` 置空（不继承父进程的
/// 控制台输入，避免子进程等待输入），`stdout`/`stderr` 置管道。
pub fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> std::io::Result<Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    // 先把两个读线程挂上，见文件头「实现取舍」第一条。
    let stdout = child.stdout.take().map(spawn_reader);
    let stderr = child.stderr.take().map(spawn_reader);

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // 🔴 刻意**不** join 读线程（这条被 `timeout_kills_lingering_child` 抓过）：
            //
            // `kill()` 只终止直接子进程。走 `cmd /c …` 包装时，真正干活的孙进程
            // （ping / netsh）仍持有管道写端，`read_to_end` 会一直等到它自己退出——
            // 实测 `ping -n 6` 让「300ms 超时」变成 5.1s 才返回。超时路径的契约是
            // **立即返回**，所以这里只 detach：读线程阻塞在 read 上等着，孙进程退出、
            // 管道关闭后自然结束，不需要我们回收。
            //
            // 直接 drop JoinHandle = detach（std 的语义）。写成 `let _ =` 是为了显式
            // 表达"故意不管"而不是漏写 join。
            // 直接 drop JoinHandle = detach（std 的语义）。
            drop(stdout);
            drop(stderr);
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("子进程超过 {}ms 未退出，已终止", timeout.as_millis()),
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    Ok(Output {
        status,
        stdout: stdout.and_then(|h| h.join().ok()).unwrap_or_default(),
        stderr: stderr.and_then(|h| h.join().ok()).unwrap_or_default(),
    })
}

fn spawn_reader<R: Read + Send + 'static>(mut r: R) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        // 读失败（含超时 kill 导致的连接中断）按「没有这段输出」处理：
        // 调用方在超时路径上本来就不会看这里的内容。
        let _ = r.read_to_end(&mut buf);
        buf
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缓慢退出的进程必须被按时 kill，而不是把调用方一起拖住。
    #[test]
    fn timeout_kills_lingering_child() {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.args(["/c", "ping -n 6 127.0.0.1"]);
            c
        };
        #[cfg(unix)]
        let mut cmd = {
            let mut c = Command::new("sleep");
            c.arg("5");
            c
        };

        let started = Instant::now();
        let err = output_with_timeout(&mut cmd, Duration::from_millis(300)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "超时后必须尽快返回，实际耗时 {:?}",
            started.elapsed()
        );
    }

    /// 正常退出的进程要拿得到退出码与 stdout，别把路径改废了。
    #[test]
    fn returns_status_and_output() {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.args(["/c", "echo cc-bridge-probe"]);
            c
        };
        #[cfg(unix)]
        let mut cmd = {
            let mut c = Command::new("echo");
            c.arg("cc-bridge-probe");
            c
        };

        let out = output_with_timeout(&mut cmd, Duration::from_secs(10)).expect("应正常完成");
        assert!(out.status.success(), "退出状态应为成功");
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("cc-bridge-probe"),
            "应收回 stdout：{:?}",
            String::from_utf8_lossy(&out.stdout)
        );
    }

    /// 输出量超过管道缓冲（>64KB）时不能死锁 —— 这条专门守住「先读后等」的实现。
    #[test]
    fn large_output_does_not_deadlock() {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.args([
                "/c",
                "for /L %i in (1,1,4000) do @echo 0123456789012345678901234567890123456789",
            ]);
            c
        };
        #[cfg(unix)]
        let mut cmd = {
            let mut c = Command::new("sh");
            c.args([
                "-c",
                "for i in $(seq 1 4000); do echo 0123456789012345678901234567890123456789; done",
            ]);
            c
        };

        let out =
            output_with_timeout(&mut cmd, Duration::from_secs(20)).expect("大输出也应正常完成");
        assert!(
            out.stdout.len() > 64 * 1024,
            "应收回超过 64KB 的输出，实际 {} 字节",
            out.stdout.len()
        );
    }
}
