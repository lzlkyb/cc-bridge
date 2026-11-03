//! `wait_command`：等到后台命令结束（或输出命中某模式）再返回。
//!
//! WHY: NC 的 ecj 编译要 3~4 分钟，模型只能 `run_command(background:true)` 之后反复
//! 调 `get_command_output` 轮询——查早了拿不到结果，每查一次一轮网络往返。等在这里由
//! **服务端**轮询，一轮就能拿到结果；顺带把输出过滤（`include`/`exclude`/`tailLines`）
//! 也放在服务端做。
//!
//! 🔴 超时**不杀进程**：与 `run_command` 前台超时（`start_kill()` 杀整棵树）刻意相反。
//! 这里的语义是「我这个请求没等到」，不是「这条命令该结束」——构建可能还想让它继续跑。

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::mcp::tools::output_clip::{fit_result, FitOpts, DEFAULT_RETURN_LIMIT};
use crate::mcp::tools::output_filter::OutputFilter;
use crate::mcp::tools::{text_result, CLIENT_SAFE_WAIT_SECS};
use crate::state::AppState;

/// 默认等待上限（秒）。取客户端安全线（见 [`CLIENT_SAFE_WAIT_SECS`]）：原默认 120s
/// 一定会被客户端在约 60s 时断开，整次结果作废。等不完就返回 `running:true`，再调一次接着等。
fn default_timeout_sec() -> u64 {
    CLIENT_SAFE_WAIT_SECS
}

/// 返回值里默认只留最后 40 行：编译日志的真正结论在尾部，头部几千行只是过程。
const DEFAULT_TAIL_LINES: usize = 40;

/// 等到超时、命令仍在跑时的默认尾行数：只为看一眼进度。
/// 长构建会连续等很多轮，每轮都带 40 行过程日志是纯浪费；显式传 `tailLines` 时以调用方为准。
const RUNNING_TAIL_LINES: usize = 5;

/// 上限：客户端约 60s 就断开（见 [`CLIENT_SAFE_WAIT_SECS`]），再长的等待没有意义——
/// 旧上限 600s 实测必然失败。超出时压到上限，并在返回里写明。
const MAX_TIMEOUT_SEC: u64 = CLIENT_SAFE_WAIT_SECS + 5;

/// 轮询间隔。100ms 对「等构建」这种量级完全够用，又不会把 CPU 叫醒太勤。
const POLL_INTERVAL_MS: u64 = 100;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct WaitCommandArgs {
    /// `run_command(background:true)` 返回的句柄。
    pub handle: String,
    /// 最长等待秒数，默认 50，上限 55。传 0 表示「只看一眼、不等待」。
    #[schema(
        desc = "Default 50, max 55 (the client drops a request at ~60s; call again to keep waiting). 0 = peek."
    )]
    #[serde(default = "default_timeout_sec", rename = "timeoutSec")]
    pub timeout_sec: u64,
    /// 可选：stdout/stderr 中出现匹配该正则的行就立即返回（如 `EXIT=\\d+`）。
    /// 命中时命令可能仍在运行——返回值里的 `running` 会说明。
    #[schema(desc = "Regex; return as soon as a matching output line appears.")]
    #[serde(default, rename = "untilPattern")]
    pub until_pattern: Option<String>,
    /// 返回最后 N 行（先过滤再截尾），默认 40。
    /// 省略时：命令已结束或命中 untilPattern 给 40 行，仍在跑给 5 行。
    #[schema(desc = "Default 40 once finished or matched, 5 while still running.")]
    #[serde(default, rename = "tailLines")]
    pub tail_lines: Option<usize>,
    /// 可选：`"raw"` = stdout / stderr 各自作为独立文本块原样返回。
    #[schema(
        desc = "raw = status JSON block, then stdout and stderr as unescaped text blocks.",
        values = "raw"
    )]
    #[serde(default)]
    pub format: Option<String>,
    /// 可选：只保留匹配该正则的行。
    #[serde(default)]
    pub include: Option<String>,
    /// 可选：剔除匹配该正则的行。
    #[serde(default)]
    pub exclude: Option<String>,
}

pub async fn handle(args: WaitCommandArgs, state: &Arc<AppState>) -> Result<Value, String> {
    // 先校验正则（无效就立刻报错，不白等）；真正用的 filter 等知道「结束没有」后再建，
    // 因为默认尾行数取决于它。
    OutputFilter::new(args.include.as_deref(), args.exclude.as_deref(), None)?;
    let until = match args.until_pattern.as_deref() {
        Some(p) if !p.trim().is_empty() => {
            Some(Regex::new(p).map_err(|e| format!("untilPattern 正则无效（{p}）：{e}"))?)
        }
        _ => None,
    };
    let timeout_clamped = (args.timeout_sec > MAX_TIMEOUT_SEC).then_some(args.timeout_sec);
    let timeout_sec = args.timeout_sec.min(MAX_TIMEOUT_SEC);
    // 在 batch 里不能等过整次 batch 剩余的时间（见 batch::remaining_budget）。
    // 被压短时记下来，返回里说明：否则模型只看到「等了 3s 未结束」，会误判命令卡住。
    let batch_cap = super::batch::remaining_budget()
        .map(|r| r.as_secs())
        .filter(|r| *r < timeout_sec);
    let timeout_sec = batch_cap.unwrap_or(timeout_sec);

    // 与 get_command_output 同做法：先克隆出需要的 Arc 再释放 DashMap 的 Ref，
    // 避免持有 Ref 期间跨 await。
    let (
        stdout_arc,
        stderr_arc,
        exit_code_arc,
        finished_elapsed,
        started_at,
        out_done,
        err_done,
        stop_requested,
        result_read,
    ) = {
        let entry = state
            .running_commands
            .get(&args.handle)
            .ok_or_else(|| format!("未知的 handle: {}（可能从未存在，或已被清理）", args.handle))?;
        (
            entry.stdout.clone(),
            entry.stderr.clone(),
            entry.exit_code.clone(),
            entry.finished_elapsed_secs.clone(),
            entry.started_at,
            entry.stdout_done.clone(),
            entry.stderr_done.clone(),
            entry.stop_requested.clone(),
            entry.result_read.clone(),
        )
    };

    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_sec);
    let mut matched = false;
    loop {
        // 🔴 等到「退出 **且** 两路管道都读到 EOF」才算真结束。只看 exit_code 会在
        // 管道残余没读完时提前返回半截输出（exit ≠ close）。这条必须与 stop 的
        // 保留语义配套：被杀进程同样走这条判定，才不会读到缺尾巴的内容。
        //
        // 已被请求终止的条目也算「不会再等下去」——否则在 stop 之后调 wait 会白等满
        // 整个 timeout（kill 未生效的顽固进程根本不会写 exit_code）。
        let exited = exit_code_arc.lock().await.is_some() || stop_requested.load(Ordering::Relaxed);
        let exited_and_drained =
            exited && out_done.load(Ordering::Relaxed) && err_done.load(Ordering::Relaxed);
        // 🔴 先匹配、再判结束。顺序反过来有个真实的漏判：命令可能在**第一次轮询之前**
        // 就跑完（快命令，或高并发下 `run_command` 的启动确认排队几秒、等 wait 拿到
        // handle 时进程早已退出），那时 `exited_and_drained` 直接 break，`until_pattern`
        // 一次都没扫过 —— 输出里明明有标记，返回的却是 `matchedPattern: false`，
        // 调用方据此以为「等的东西没出现」。命令已结束时 `running` 仍按实际为 false，
        // `timedOut` 由 `exit_code.is_some()` 压住，都不会被这次匹配带偏。
        if let Some(re) = &until {
            // 每次轮询都对**保存缓冲**重扫一遍（头 1/8 + 尾 7/8，约 1MB），100ms 一次完全
            // 可接受；换成「增量扫描」要为跨越缓冲边界的匹配单独设计，不值得为这点收益引入
            // 一类新 bug。已知边界：两次轮询之间新产出超过约 900KB 时，中段的完成标记可能被
            // 挤掉（实际几乎碰不到，方案 §3.3 定稿 ② 已写明不修）。
            let hit = {
                let out = stdout_arc.lock().await;
                re.is_match(&out.text())
            } || {
                let err = stderr_arc.lock().await;
                re.is_match(&err.text())
            };
            if hit {
                matched = true;
                break;
            }
        }
        if exited_and_drained {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }

    let stdout_buf = stdout_arc.lock().await;
    let stderr_buf = stderr_arc.lock().await;
    let exit_code = *exit_code_arc.lock().await;
    let terminated = stop_requested.load(Ordering::Relaxed);
    // 拿到了结束状态 = 结果已被取走，清理时不再为它多留（见 RunningCommand::result_read）。
    if exit_code.is_some() || terminated {
        result_read.store(true, Ordering::Relaxed);
    }
    // exit ≠ close：进程退出后管道可能还有残余字节，只有两路 EOF 才算输出完整。
    let output_complete =
        exit_code.is_some() && out_done.load(Ordering::Relaxed) && err_done.load(Ordering::Relaxed);
    let elapsed = match *finished_elapsed.lock().await {
        Some(secs) => secs,
        None => started_at.elapsed().as_secs(),
    };

    // 仍在跑、且没命中等待标记 = 中间返回，只给几行进度；调用方显式传了 tailLines 则以它为准。
    let still_running = exit_code.is_none() && !terminated && !matched;
    let tail = args.tail_lines.unwrap_or(if still_running {
        RUNNING_TAIL_LINES
    } else {
        DEFAULT_TAIL_LINES
    });
    let filter = OutputFilter::new(args.include.as_deref(), args.exclude.as_deref(), Some(tail))?;
    let out = filter.apply(&stdout_buf.text());
    let err = filter.apply(&stderr_buf.text());

    let mut info = Map::new();
    info.insert("handle".into(), json!(args.handle));
    info.insert("timeoutSec".into(), json!(timeout_sec));
    info.insert("finished".into(), json!(exit_code.is_some()));
    info.insert("terminated".into(), json!(terminated));
    // 已被终止的条目不算「运行中」：即便还没取到退出码，它也不再是有效进程。
    info.insert("running".into(), json!(exit_code.is_none() && !terminated));
    info.insert("exitCode".into(), json!(exit_code));
    info.insert("outputComplete".into(), json!(output_complete));
    // 超时 = 没等到结束。`untilPattern` 命中属于「等到了想等的东西」，不算超时；
    // 已被终止的命令是「等不到退出码」而不是「等到超时」，同样不算。
    info.insert(
        "timedOut".into(),
        json!(exit_code.is_none() && !matched && !terminated),
    );
    info.insert("matchedPattern".into(), json!(matched));
    info.insert("elapsedSecs".into(), json!(elapsed));
    info.insert("stdout".into(), json!(out.text));
    info.insert("stderr".into(), json!(err.text));
    info.insert("stdoutTotalBytes".into(), json!(stdout_buf.total_bytes()));
    info.insert("stderrTotalBytes".into(), json!(stderr_buf.total_bytes()));
    if stdout_buf.dropped_bytes() > 0 {
        info.insert(
            "stdoutDroppedBytes".into(),
            json!(stdout_buf.dropped_bytes()),
        );
    }
    if stderr_buf.dropped_bytes() > 0 {
        info.insert(
            "stderrDroppedBytes".into(),
            json!(stderr_buf.dropped_bytes()),
        );
    }
    info.insert("stdoutDroppedLines".into(), json!(out.dropped));
    info.insert("stdoutOmittedLines".into(), json!(out.omitted));
    info.insert("stderrDroppedLines".into(), json!(err.dropped));
    info.insert("stderrOmittedLines".into(), json!(err.omitted));
    // terminated 必须放最前：否则「已被终止但没拿到退出码」会落进「仍在后台运行（未被终止）」
    // 那个分支，把状态说反。
    if terminated {
        let note = if exit_code.is_none() {
            "该命令已被终止（pid 已不在运行），但还没拿到退出状态。可稍后再调一次 \
             get_command_output 取回被杀之前的输出。"
                .to_string()
        } else if !output_complete {
            "该命令已被终止，输出仍在收尾（管道未完全关闭）。稍等片刻再调一次可拿到完整尾部。"
                .to_string()
        } else {
            format!(
                "该命令已被终止（stop_command 主动结束，或转后台后跑满 timeoutMs 被自动终止）；以上是它被杀之前产出的输出（退出码 {}）。",
                exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "无".into())
            )
        };
        info.insert("note".into(), json!(note));
    } else if exit_code.is_none() && !matched {
        info.insert(
            "note".into(),
            json!(format!(
                "等待 {timeout_sec}s 未结束，命令仍在后台运行（未被终止）。可再调一次 wait_command 继续等，\
                 或用 get_command_output 看增量、stop_command 结束它。"
            )),
        );
    } else if exit_code.is_some() && !output_complete {
        info.insert(
            "note".into(),
            json!("进程已结束，但输出仍在收尾（管道未完全关闭）。稍等片刻再调一次可拿到完整尾部。"),
        );
    }

    // tailLines 默认 40 时基本不会超限，但 `tailLines:0` 或 `include` 命中大量行时就没有
    // 上限了——所以同样过一遍裁剪（方案 §3.3 定稿 ③）。
    let info = fit_result(
        info,
        &FitOpts {
            limit: DEFAULT_RETURN_LIMIT,
            extract_key_lines: !filter.is_active(),
            // 尾部只有读到 EOF 之后才是最终结果，否则还会继续长。
            tail_is_final: output_complete,
            next_offsets: false,
        },
    );
    // 去掉值为默认的计数/截断字段（见 prune_default_output_fields）。
    let mut info = info;
    if let Some(want) = timeout_clamped {
        // 不静默改变语义：说清楚为什么只等了这么久。
        info.insert(
            "timeoutNote".into(),
            json!(format!(
                "timeoutSec 已从 {want} 压到 {MAX_TIMEOUT_SEC}：客户端约 60s 就会断开请求、整次结果作废。未结束就再调一次接着等。"
            )),
        );
    }
    if let (Some(secs), true) = (batch_cap, still_running) {
        info.insert(
            "timeoutNote".into(),
            json!(format!(
                "在 batch 里只等了 {secs}s（整次 batch 剩余时间不足），命令仍在运行、不是卡住了；可单独再调 wait_command 继续等。"
            )),
        );
    }
    crate::mcp::tools::prune_default_output_fields(&mut info);

    let out = text_result(&Value::Object(info));
    Ok(if args.format.as_deref() == Some("raw") {
        crate::mcp::tools::split_output_blocks(out)
    } else {
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::run_command::{self, RunCommandArgs};
    use crate::mcp::tools::stop_command::{self, StopCommandArgs};
    use crate::mcp::tools::testutil::make_state;

    fn info_of(out: &Value) -> Value {
        serde_json::from_str(out["content"][0]["text"].as_str().expect("text")).expect("json")
    }

    /// 起一条后台命令，返回 (state, handleId)。
    async fn spawn_background(command: &str) -> (Arc<AppState>, String) {
        let (state, dir) = make_state(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let out = run_command::handle(
            RunCommandArgs {
                command: command.into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: true,
                timeout_ms: 120_000,
                max_output_bytes: 1024 * 1024,
                include: None,
                exclude: None,
                tail_lines: None,
                format: None,
                env: None,
                description: None,
            },
            &state,
        )
        .await
        .expect("后台命令应能启动");
        let info = info_of(&out);
        (state, info["handle"].as_str().expect("handle").to_string())
    }

    fn base_args(handle: &str) -> WaitCommandArgs {
        WaitCommandArgs {
            handle: handle.to_string(),
            timeout_sec: 30,
            until_pattern: None,
            tail_lines: None,
            format: None,
            include: None,
            exclude: None,
        }
    }

    /// 调一次 wait_command，成功后顺手把后台进程收掉（测试不该留孤儿进程）。
    async fn wait_and_cleanup(state: &Arc<AppState>, a: WaitCommandArgs) -> Result<Value, String> {
        let handle = a.handle.clone();
        let out = super::handle(a, state).await;
        if out.is_ok() {
            let _ = stop_command::handle(StopCommandArgs { handle }, state).await;
        }
        out
    }

    /// 先打标记再慢跑：用来验证「命中即返回」时命令确实还在跑。
    ///
    /// 🔴 必须**明显慢于任何启动延迟**。曾用 `ping -n 4`（约 3 秒），全量并行跑
    /// 800+ 测试时 `run_command(background)` 的启动确认会被排队几秒，等 wait 拿到
    /// handle 时这条命令已经自己跑完 —— `running: true` 的前提直接不成立，两条用到
    /// 它的测试随机变红（单跑必绿）。命令拉长到十几秒，排队再久也仍在跑；两条测试
    /// 都是命中或超时即返回，不会因此变慢，只有真的失败时才会等满。
    fn slow_marker_command() -> &'static str {
        if cfg!(windows) {
            "echo DONE_MARKER && ping -n 15 127.0.0.1 >NUL"
        } else {
            "echo DONE_MARKER && sleep 12"
        }
    }

    /// 命令先于超时结束：立即返回，退出码与输出都在。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn returns_when_command_finishes() {
        let (state, handle) = spawn_background("echo wait_payload_ok").await;
        let info = info_of(
            &wait_and_cleanup(&state, base_args(&handle))
                .await
                .expect("wait"),
        );
        assert_eq!(info["finished"], json!(true), "{info}");
        assert_eq!(info["exitCode"], json!(0), "{info}");
        assert_eq!(info["timedOut"], json!(false), "{info}");
        // 🔴 必须等到「退出 + 两路管道 EOF」才返回：只看 exit_code 会漏掉管道尾部，
        // 那个坑在 stop 之后取被杀进程输出时最明显（尾部整段丢）。
        assert_eq!(info["outputComplete"], json!(true), "{info}");
        assert!(
            info["stdout"]
                .as_str()
                .unwrap_or_default()
                .contains("wait_payload_ok"),
            "应拿到 stdout：{info}"
        );
    }

    /// `untilPattern` 命中即返回，且此时命令**仍在运行**——这才证明是「提前返回」
    /// 而不是「等它跑完再比一次」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn until_pattern_returns_before_command_ends() {
        let (state, handle) = spawn_background(slow_marker_command()).await;
        let mut a = base_args(&handle);
        a.timeout_sec = MAX_TIMEOUT_SEC;
        a.until_pattern = Some("DONE_MARKER".into());
        let info = info_of(&wait_and_cleanup(&state, a).await.expect("wait"));
        assert_eq!(info["matchedPattern"], json!(true), "{info}");
        assert_eq!(
            info["running"],
            json!(true),
            "标记行刚打印、后面的慢命令还没跑完，应仍 running：{info}"
        );
    }

    /// 超时**不杀进程**：`timedOut:true`、`running:true`，handle 仍可用。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timeout_reports_but_does_not_kill() {
        let (state, handle) = spawn_background(slow_marker_command()).await;
        let mut a = base_args(&handle);
        a.timeout_sec = 0;
        let info = info_of(&wait_and_cleanup(&state, a).await.expect("wait"));
        assert_eq!(info["timedOut"], json!(true), "{info}");
        assert_eq!(info["running"], json!(true), "超时不该杀进程：{info}");
        assert!(
            info["note"]
                .as_str()
                .is_some_and(|n| n.contains("未被终止")),
            "应明确告知进程还在跑：{info}"
        );
    }

    /// `exclude` 生效并报告剔除行数。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exclude_filters_output_and_reports_dropped_lines() {
        let (state, handle) = spawn_background("echo keep_me && echo drop_me").await;
        let mut a = base_args(&handle);
        a.exclude = Some("drop_me".into());
        let info = info_of(&wait_and_cleanup(&state, a).await.expect("wait"));
        let stdout = info["stdout"].as_str().unwrap_or_default();
        assert!(stdout.contains("keep_me"), "{info}");
        assert!(!stdout.contains("drop_me"), "exclude 应剔除该行：{info}");
        assert_eq!(info["stdoutDroppedLines"], json!(1), "{info}");
    }

    /// 超过客户端安全线的 timeoutSec 被压到上限，并在返回里写明（不静默改语义）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn oversized_timeout_is_clamped_with_note() {
        let (state, handle) = spawn_background("echo clamp_ok").await;
        let mut a = base_args(&handle);
        a.timeout_sec = 600;
        let info = info_of(&wait_and_cleanup(&state, a).await.expect("wait"));
        assert_eq!(info["timeoutSec"], json!(MAX_TIMEOUT_SEC), "{info}");
        assert!(
            info["timeoutNote"]
                .as_str()
                .is_some_and(|n| n.contains("600")),
            "应说明被压了：{info}"
        );
        // 上限必须低于客户端约 60s 的断开线（编译期检查）。
        const { assert!(MAX_TIMEOUT_SEC < 60) };
    }

    /// 在 batch 里等待被压到剩余时间：要说明原因，免得模型以为命令卡住。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_capped_by_batch_budget_explains_why() {
        let cmd = if cfg!(windows) {
            "ping -n 15 127.0.0.1 >NUL"
        } else {
            "sleep 12"
        };
        let (state, handle) = spawn_background(cmd).await;
        let a = base_args(&handle);
        let started = std::time::Instant::now();
        let deadline = started + std::time::Duration::from_secs(2);
        let info = info_of(
            &crate::mcp::tools::batch::with_batch_deadline(deadline, wait_and_cleanup(&state, a))
                .await
                .expect("wait"),
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(6),
            "{info}"
        );
        assert_eq!(info["running"], json!(true), "前提：命令应仍在跑：{info}");
        assert!(
            info["timeoutNote"]
                .as_str()
                .is_some_and(|n| n.contains("batch")),
            "应说明是 batch 剩余时间不足：{info}"
        );
    }

    /// 等到超时仍在跑：未显式传 tailLines 时只给最后几行进度，不再每轮带 40 行。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn running_return_keeps_only_a_few_tail_lines() {
        let cmd = if cfg!(windows) {
            "(for /L %i in (1,1,20) do @echo line%i) && ping -n 15 127.0.0.1 >NUL"
        } else {
            "for i in $(seq 1 20); do echo line$i; done; sleep 12"
        };
        let (state, handle) = spawn_background(cmd).await;
        let mut a = base_args(&handle);
        a.timeout_sec = 6;
        let info = info_of(&wait_and_cleanup(&state, a).await.expect("wait"));
        assert_eq!(info["running"], json!(true), "前提：命令应仍在跑：{info}");
        let lines = info["stdout"].as_str().unwrap_or_default().lines().count();
        assert!(
            lines <= RUNNING_TAIL_LINES,
            "仍在跑时最多 {RUNNING_TAIL_LINES} 行，实得 {lines}：{info}"
        );
        assert!(
            info["stdoutOmittedLines"].as_u64().unwrap_or(0) > 0,
            "20 行里应有被省略的：{info}"
        );
    }

    #[tokio::test]
    async fn unknown_handle_is_rejected() {
        let (state, _dir) = make_state(|c| c.shell_enabled = true);
        let err = super::handle(base_args("cmd_nope"), &state)
            .await
            .expect_err("未知 handle 必须报错");
        assert!(err.contains("cmd_nope"), "{err}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn invalid_until_pattern_is_rejected() {
        let (state, handle) = spawn_background("echo x").await;
        let mut a = base_args(&handle);
        a.until_pattern = Some("([".into());
        let err = wait_and_cleanup(&state, a)
            .await
            .expect_err("非法正则必须报错");
        assert!(err.contains("untilPattern"), "{err}");
    }
}
