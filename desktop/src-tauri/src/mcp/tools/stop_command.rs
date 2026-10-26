use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::state::AppState;

/// kill 之后等管道排空的上限。
///
/// 进程退出（exit）与 stdio 关闭（close）是两件事：`TerminateJobObject` 关掉写端后，
/// reader 线程还要先把管道缓冲区里剩下的字节读走才见 EOF。实测这段通常 <50ms，
/// 给到 3s 足够覆盖调度抖动；真等不到也不阻塞调用方——条目已保留，稍后再取即可。
const DRAIN_WAIT_MS: u64 = 3_000;
const DRAIN_POLL_MS: u64 = 50;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct StopCommandArgs {
    pub handle: String,
}

/// 一次终止的结果。`stop_command`（MCP）与面板的 `stop_running_command` 共用
/// [`terminate`] 这一份实现，避免两条路径的语义慢慢漂移。
#[derive(Debug)]
pub(crate) struct Terminated {
    pub pid: u32,
    pub already_finished: bool,
    pub exit_code: Option<i32>,
    /// 进程已退出 **且** 两路管道都已读到 EOF（输出完整）。
    pub output_complete: bool,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}

/// 终止一个后台命令的整个进程树，**并把条目留在注册表里**。
/// 故意不受 shell_enabled/readonly_mode 限制——即使事后关闭了命令执行开关，
/// 仍应能终止一个已在跑的失控后台进程。
///
/// 整树终止不再依赖 taskkill，也不依赖 JobObject 的 kill-on-close（process-wrap 的 std
/// JobObject 默认不 kill-on-close，drop 不会杀进程）：这里显式调用 child.start_kill()。
/// 它的底层实现按平台分（见 Cargo.toml 的分 target feature）：
/// - Windows：TerminateJobObject，终止曾挂靠在 Job 下的所有进程；
/// - Unix / macOS：子进程 spawn 时已 setpgid 成为组长，信号发给整个进程组。
///
/// 两者都能连子孙进程一起杀（不管嵌套几层）。
///
/// 🔴 **为什么不再 `remove`**：输出没有随进程消失（reader 线程独立于进程持有管道读端，
/// 缓冲区在 `Arc<Mutex<Capture>>` 里），但注册表记录一删，谁都拿不到它——模型永远看不到
/// 「被杀之前它停在哪」。GitHub 上同类实现（mcp-shell / run-command-mcp / host-shell-mcp）
/// 一致做法是 kill 只改状态、清理交给独立动作，这里对齐。条目由
/// `cleanup_finished_commands` 按 `command_cleanup_secs` 宽容期回收。
pub(crate) async fn terminate(state: &Arc<AppState>, handle: &str) -> Result<Terminated, String> {
    // 先取出需要的 Arc 后立刻释放 DashMap 的 Ref，不在持有 Ref 期间 await。
    let (pid, child, exit_code, stop_requested, stop_at, out_done, err_done, stdout, stderr) = {
        let entry = state
            .running_commands
            .get(handle)
            .ok_or_else(|| format!("未知的 handle: {handle}"))?;
        (
            entry.pid,
            entry.child.clone(),
            entry.exit_code.clone(),
            entry.stop_requested.clone(),
            entry.stop_requested_at.clone(),
            entry.stdout_done.clone(),
            entry.stderr_done.clone(),
            entry.stdout.clone(),
            entry.stderr.clone(),
        )
    };

    // 🔴 **先杀、杀成功才置标记**（审查 P2）。原来是「先 remove 再 `let _ = start_kill()`」：
    // 杀失败时进程变成孤儿，而模型与面板都拿到 `killed: true`、注册表里也查不到它了——
    // 之后谁都没有手段再管这个进程。
    // 已经跑完的命令不需要 kill（对已退出的进程调 start_kill 在部分平台会报错，
    // 而用户此时只想把它从列表里清掉），所以先看 exit_code。
    let mut already_finished = exit_code.lock().await.is_some();
    if !already_finished {
        // 只有前台命令留给「翻页取回」的快照条目没有 child，而它们的 exit_code 必然已是
        // Some（进程早结束），所以走到这里的条目一定拿得到句柄。
        let child = child.ok_or_else(|| {
            format!("进程 {pid} 的句柄已释放，无法终止；它可能已经结束，请刷新运行列表。")
        })?;
        let mut guard = child.lock().map_err(|_| {
            format!("终止进程 {pid} 失败：无法获取进程句柄锁。该命令仍在运行列表中。")
        })?;
        let already_stopped = stop_requested.load(Ordering::Relaxed);
        if let Err(e) = guard.start_kill() {
            // 🔴 报错不等于没杀掉：Unix 上目标若已退出，`kill` 返回 ESRCH
            //    （"No such process"）。两种情形都不该把错误抛给用户：
            //    ① 复查发现进程确实已退出；
            //    ② 这次「终止」是我们**此前已经请求过**的（用户重复点了停止）。
            //    不能只看 ①：ESRCH 说明内核里已经没有这个进程，但 `try_wait()`
            //    要等子进程被 reap 才返回 `Some`，那个中间窗口里 ① 是假的。
            //    不兜这一层的话，同一个按钮在 Windows 上静默成功、在 macOS 上报错
            //    （`TerminateJobObject` 对已结束的作业不报错）。
            if matches!(guard.try_wait(), Ok(None)) && !already_stopped {
                return Err(format!(
                    "终止进程 {pid} 失败：{e}。该命令仍在运行列表中，可稍后重试或手动结束。"
                ));
            }
            // 如实报 `already_finished`，否则返回里会出现 `killed:true` 与
            // `alreadyFinished:false` 这种自相矛盾的组合。
            already_finished = true;
        }
        drop(guard); // 不在等排空期间占着进程句柄锁
    }

    // 标记（幂等）：重复 stop 不再报「未知的 handle」，也便于面板/翻页接口说明这是主动终止。
    stop_requested.store(true, Ordering::Relaxed);
    {
        let mut at = stop_at.lock().await;
        if at.is_none() {
            *at = Some(Instant::now());
        }
    }

    // 等管道排空：exit_code 只说明进程退出，残余字节可能还躺在管道里。
    let deadline = Instant::now() + Duration::from_millis(DRAIN_WAIT_MS);
    loop {
        let exited = exit_code.lock().await.is_some();
        if exited && out_done.load(Ordering::Relaxed) && err_done.load(Ordering::Relaxed) {
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(DRAIN_POLL_MS)).await;
    }

    let code = *exit_code.lock().await;
    let output_complete =
        code.is_some() && out_done.load(Ordering::Relaxed) && err_done.load(Ordering::Relaxed);
    let stdout_bytes = stdout.lock().await.total_bytes() as u64;
    let stderr_bytes = stderr.lock().await.total_bytes() as u64;

    Ok(Terminated {
        pid,
        already_finished,
        exit_code: code,
        output_complete,
        stdout_bytes,
        stderr_bytes,
    })
}

pub async fn handle(args: StopCommandArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let r = terminate(state, &args.handle).await?;
    let retained_secs = state.config.read().await.command_cleanup_secs;

    let mut info = Map::new();
    info.insert("handle".into(), json!(args.handle));
    info.insert("pid".into(), json!(r.pid));
    info.insert("killed".into(), json!(true));
    info.insert("alreadyFinished".into(), json!(r.already_finished));
    info.insert("exitCode".into(), json!(r.exit_code));
    info.insert("outputComplete".into(), json!(r.output_complete));
    info.insert("stdoutBytes".into(), json!(r.stdout_bytes));
    info.insert("stderrBytes".into(), json!(r.stderr_bytes));
    info.insert("outputRetainedSecs".into(), json!(retained_secs));

    let note = if !r.output_complete {
        format!(
            "已终止进程树（pid {}），但输出仍在收尾（管道尚未完全关闭）。稍等片刻再调 \
             get_command_output(handle=\"{}\") 取回最后一段。",
            r.pid, args.handle
        )
    } else if r.already_finished {
        format!(
            "该命令此前已自行结束（退出码 {}），无需终止；输出已保留，可用 \
             get_command_output(handle=\"{}\") 查看（约 {retained_secs} 秒内有效）。",
            r.exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "无".into()),
            args.handle
        )
    } else {
        format!(
            "已终止进程树（pid {}）。**输出已保留**：用 get_command_output(handle=\"{}\") 取回被杀前\
             的最后一段（约 {retained_secs} 秒内有效）。",
            r.pid, args.handle
        )
    };
    info.insert("note".into(), json!(note));

    Ok(crate::mcp::tools::text_result(&Value::Object(info)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::run_command::{self, RunCommandArgs};
    use crate::mcp::tools::testutil::make_state;

    #[tokio::test]
    async fn unknown_handle_returns_error() {
        // stop_command 一定不能对未知 handle 静默成功——若返回 ok 但注册表没动，
        // 客户端会以为"已停止"再去 get_command_output 仍拿到旧输出，状态机错乱。
        let (state, _dir) = make_state(|c| c.shell_enabled = true);
        let err = terminate(&state, "cmd_does_not_exist")
            .await
            .expect_err("unknown handle must Err");
        assert!(
            err.contains("未知") || err.contains("cmd_does_not_exist"),
            "错误信息应指明 unknown handle，实际：{err}"
        );

        // 注册表应保持空（不能因为 stop 失败把别的清掉）。
        assert!(state.running_commands.is_empty());
    }

    /// 🔴 回归核心：终止之后条目**必须还在**，且能凭同一个 handle 取回被杀前的输出。
    /// 之前是「杀完即 remove」，模型随后调 get_command_output 只会拿到「未知的 handle」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_keeps_handle_and_output_readable() {
        let (state, dir) = make_state(|c| c.shell_enabled = true);
        let cmd = if cfg!(windows) {
            "echo BEFORE_KILL_MARKER && ping -n 30 127.0.0.1 >NUL"
        } else {
            "echo BEFORE_KILL_MARKER && sleep 30"
        };
        let started = run_command::handle(
            RunCommandArgs {
                command: cmd.into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: true,
                timeout_ms: 120_000,
                max_output_bytes: 1024 * 1024,
                include: None,
                exclude: None,
                tail_lines: None,
                env: None,
                description: None,
            },
            &state,
        )
        .await
        .expect("后台命令应能启动");
        let info: Value =
            serde_json::from_str(started["content"][0]["text"].as_str().unwrap()).unwrap();
        let handle = info["handle"].as_str().unwrap().to_string();

        // 等标记行真的落到缓冲里（reader 线程与 stop 之间有竞争）。
        let mut waited = 0;
        loop {
            // 不持 DashMap Ref 跨 await：先 clone 出 Arc 再锁。
            let buf = {
                let entry = state.running_commands.get(&handle).expect("条目应在");
                entry.stdout.clone()
            };
            let has = buf.lock().await.text().contains("BEFORE_KILL_MARKER");
            if has || waited > 100 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
            waited += 1;
        }

        let r = terminate(&state, &handle).await.expect("终止应成功");
        assert!(!r.already_finished, "命令当时还在跑");
        // ⚠️ 不断言 `output_complete`：它要求「进程已退出 **且** 两路管道都读到 EOF」。
        //    Windows 的 `TerminateJobObject` 是硬杀，当场见 EOF；Unix 上信号发给进程组，
        //    组里其它成员可能还短暂握着管道读端，`DRAIN_WAIT_MS` 内不保证排空。
        //    这条测的是「终止后条目与输出仍然可达」，所以断言**输出确实读到了东西**；
        //    排空与否是时序余量（条目已保留，稍后再取也能取到）。
        assert!(
            r.output_complete || r.stdout_bytes > 0,
            "kill 后输出应仍可读：{r:?}"
        );

        // 条目仍在（这一步是本次修复的关键）
        assert!(
            state.running_commands.get(&handle).is_some(),
            "终止后条目必须保留，否则输出不可达"
        );

        let out = crate::mcp::tools::get_command_output::handle(
            crate::mcp::tools::get_command_output::GetCommandOutputArgs {
                handle: handle.clone(),
                stdout_offset: 0,
                stderr_offset: 0,
                include: None,
                exclude: None,
                tail_lines: None,
            },
            &state,
        )
        .await
        .expect("终止后仍应能取输出");
        let txt = out["content"][0]["text"].as_str().unwrap();
        assert!(
            txt.contains("BEFORE_KILL_MARKER"),
            "被杀前的输出必须取得到：{txt}"
        );
        let v: Value = serde_json::from_str(txt).unwrap();
        assert_eq!(v["terminated"], json!(true), "应标明是被终止的：{v}");
        // `outputComplete` 同理不硬断言：Unix 上管道收尾（进程组里还有成员握着读端）
        // 可能还没完成，此时产品会带上「稍等片刻再取」的 note —— 那也是正确行为。
        // 所以要求的是「要么已排空，要么明确告诉调用方还能再取」，而不是「一定已排空」。
        if v["outputComplete"] != json!(true) {
            assert!(
                v["note"].as_str().unwrap_or("").contains("收尾"),
                "未排空时必须说明还能再取：{v}"
            );
        }
        assert!(!v["running"].as_bool().unwrap_or(true), "已不再运行：{v}");
    }

    /// 重复终止必须幂等：第二次返回 `alreadyFinished: true`，而不是「未知的 handle」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn second_stop_is_idempotent() {
        let (state, dir) = make_state(|c| c.shell_enabled = true);
        let cmd = if cfg!(windows) {
            "ping -n 30 127.0.0.1 >NUL"
        } else {
            "sleep 30"
        };
        let started = run_command::handle(
            RunCommandArgs {
                command: cmd.into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: true,
                timeout_ms: 120_000,
                max_output_bytes: 1024 * 1024,
                include: None,
                exclude: None,
                tail_lines: None,
                env: None,
                description: None,
            },
            &state,
        )
        .await
        .expect("后台命令应能启动");
        let info: Value =
            serde_json::from_str(started["content"][0]["text"].as_str().unwrap()).unwrap();
        let handle = info["handle"].as_str().unwrap().to_string();

        terminate(&state, &handle).await.expect("首次终止");
        let second = terminate(&state, &handle).await.expect("重复终止应幂等");
        assert!(second.already_finished, "{second:?}");
    }
}
