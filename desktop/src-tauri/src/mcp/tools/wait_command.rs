//! `wait_command`：等到后台命令结束（或输出命中某模式）再返回。
//!
//! WHY: NC 的 ecj 编译要 3~4 分钟，模型只能 `run_command(background:true)` 之后反复
//! 调 `get_command_output` 轮询——查早了拿不到结果，每查一次一轮网络往返。等在这里由
//! **服务端**轮询，一轮就能拿到结果；顺带把输出过滤（`include`/`exclude`/`tailLines`）
//! 也放在服务端做。
//!
//! 🔴 超时**不杀进程**：与 `run_command` 前台超时（`start_kill()` 杀整棵树）刻意相反。
//! 这里的语义是「我这个请求没等到」，不是「这条命令该结束」——构建可能还想让它继续跑。

use std::sync::Arc;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::mcp::tools::output_clip::{fit_result, FitOpts, DEFAULT_RETURN_LIMIT};
use crate::mcp::tools::output_filter::OutputFilter;
use crate::mcp::tools::text_result;
use crate::state::AppState;

/// 默认等待上限（秒）。与 `run_command` 前台默认 120s 对齐——超过这个量级本就该
/// 用后台 + 通知，而不是把一次 HTTP 请求挂十分钟。
fn default_timeout_sec() -> u64 {
    120
}

/// 返回值里默认只留最后 40 行：编译日志的真正结论在尾部，头部几千行只是过程。
fn default_tail_lines() -> usize {
    40
}

/// 上限 600s（10 分钟）。HTTP 客户端普遍在 5 分钟前后就放弃，再长只是白占连接。
const MAX_TIMEOUT_SEC: u64 = 600;

/// 轮询间隔。100ms 对「等构建」这种量级完全够用，又不会把 CPU 叫醒太勤。
const POLL_INTERVAL_MS: u64 = 100;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct WaitCommandArgs {
    /// `run_command(background:true)` 返回的句柄。
    pub handle: String,
    /// 最长等待秒数，默认 120，上限 600。传 0 表示「只看一眼、不等待」。
    #[serde(default = "default_timeout_sec", rename = "timeoutSec")]
    pub timeout_sec: u64,
    /// 可选：stdout/stderr 中出现匹配该正则的行就立即返回（如 `EXIT=\\d+`）。
    /// 命中时命令可能仍在运行——返回值里的 `running` 会说明。
    #[serde(default, rename = "untilPattern")]
    pub until_pattern: Option<String>,
    /// 返回最后 N 行（先过滤再截尾），默认 40。
    #[serde(default = "default_tail_lines", rename = "tailLines")]
    pub tail_lines: usize,
    /// 可选：只保留匹配该正则的行。
    #[serde(default)]
    pub include: Option<String>,
    /// 可选：剔除匹配该正则的行。
    #[serde(default)]
    pub exclude: Option<String>,
}

pub async fn handle(args: WaitCommandArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let filter = OutputFilter::new(
        args.include.as_deref(),
        args.exclude.as_deref(),
        Some(args.tail_lines),
    )?;
    let until = match args.until_pattern.as_deref() {
        Some(p) if !p.trim().is_empty() => {
            Some(Regex::new(p).map_err(|e| format!("untilPattern 正则无效（{p}）：{e}"))?)
        }
        _ => None,
    };
    let timeout_sec = args.timeout_sec.min(MAX_TIMEOUT_SEC);

    // 与 get_command_output 同做法：先克隆出需要的 Arc 再释放 DashMap 的 Ref，
    // 避免持有 Ref 期间跨 await。
    let (stdout_arc, stderr_arc, exit_code_arc, finished_elapsed, started_at) = {
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
        )
    };

    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_sec);
    let mut matched = false;
    loop {
        if exit_code_arc.lock().await.is_some() {
            break;
        }
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
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }

    let stdout_buf = stdout_arc.lock().await;
    let stderr_buf = stderr_arc.lock().await;
    let exit_code = *exit_code_arc.lock().await;
    let elapsed = match *finished_elapsed.lock().await {
        Some(secs) => secs,
        None => started_at.elapsed().as_secs(),
    };

    let out = filter.apply(&stdout_buf.text());
    let err = filter.apply(&stderr_buf.text());

    let mut info = Map::new();
    info.insert("handle".into(), json!(args.handle));
    info.insert("timeoutSec".into(), json!(timeout_sec));
    info.insert("finished".into(), json!(exit_code.is_some()));
    info.insert("running".into(), json!(exit_code.is_none()));
    info.insert("exitCode".into(), json!(exit_code));
    // 超时 = 没等到结束。`untilPattern` 命中属于「等到了想等的东西」，不算超时。
    info.insert("timedOut".into(), json!(exit_code.is_none() && !matched));
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
    if exit_code.is_none() && !matched {
        info.insert(
            "note".into(),
            json!(format!(
                "等待 {timeout_sec}s 未结束，命令仍在后台运行（未被终止）。可再调一次 wait_command 继续等，\
                 或用 get_command_output 看增量、stop_command 结束它。"
            )),
        );
    }

    // tailLines 默认 40 时基本不会超限，但 `tailLines:0` 或 `include` 命中大量行时就没有
    // 上限了——所以同样过一遍裁剪（方案 §3.3 定稿 ③）。
    let info = fit_result(
        info,
        &FitOpts {
            limit: DEFAULT_RETURN_LIMIT,
            extract_key_lines: !filter.is_active(),
            tail_is_final: exit_code.is_some(),
            next_offsets: false,
        },
    );

    Ok(text_result(&Value::Object(info)))
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
            tail_lines: 40,
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
    fn slow_marker_command() -> &'static str {
        if cfg!(windows) {
            "echo DONE_MARKER && ping -n 4 127.0.0.1 >NUL"
        } else {
            "echo DONE_MARKER && sleep 3"
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
        a.timeout_sec = 60;
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
