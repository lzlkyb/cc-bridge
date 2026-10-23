use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::mcp::tools::output_clip::{fit_result, FitOpts, MAX_RETURN_LIMIT};
use crate::mcp::tools::output_filter::OutputFilter;
use crate::mcp::tools::text_result;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct GetCommandOutputArgs {
    pub handle: String,
    #[serde(default, rename = "stdoutOffset")]
    pub stdout_offset: usize,
    #[serde(default, rename = "stderrOffset")]
    pub stderr_offset: usize,
    /// 可选：只保留匹配该正则的行（服务端过滤，被剔除的行只报数量）。
    #[serde(default)]
    pub include: Option<String>,
    /// 可选：剔除匹配该正则的行。
    #[serde(default)]
    pub exclude: Option<String>,
    /// 可选：只返回本次增量里的末尾 N 行（先过滤再截尾）。
    #[serde(default, rename = "tailLines")]
    pub tail_lines: Option<usize>,
}

/// 增量拉取后台命令（run_command background=true）的输出。
/// 已知限制：v1 没有定时回收任务，命令结束后 handle 仍会占位直到被
/// stop_command 显式移除，或后台并发数达上限时拒绝新建。
pub async fn handle(args: GetCommandOutputArgs, state: &Arc<AppState>) -> Result<Value, String> {
    // 正则写错要整次报错——静默当成「不匹配」会让调用方以为过滤生效了。
    let filter = OutputFilter::new(
        args.include.as_deref(),
        args.exclude.as_deref(),
        args.tail_lines,
    )?;

    // 先克隆出需要的 Arc，再释放 DashMap 的 Ref，避免在持有 Ref 期间跨 await。
    let (stdout_arc, stderr_arc, exit_code_arc, pid) = {
        let entry = state
            .running_commands
            .get(&args.handle)
            .ok_or_else(|| format!("未知的 handle: {}（可能从未存在，或已被清理）", args.handle))?;
        (
            entry.stdout.clone(),
            entry.stderr.clone(),
            entry.exit_code.clone(),
            entry.pid,
        )
    };

    let stdout = stdout_arc.lock().await;
    let stderr = stderr_arc.lock().await;
    let exit_code = *exit_code_arc.lock().await;

    // 偏移按**整条输出的真实字节位置**算：落在保存缓冲的缺口里时，`read_from` 会插一行
    // 「中间 N 字节已被省略」的标记再从尾部保留区接着给，`next_offset` 仍是真实位置。
    let out_read = stdout.read_from(args.stdout_offset as u64);
    let err_read = stderr.read_from(args.stderr_offset as u64);

    // tailLines 作用在**本次增量**上（offset 之后的那一段），不是整份缓冲：
    // 调用方要的是「这次多了什么」的最后几行。
    let out = filter.apply(&out_read.text);
    let err = filter.apply(&err_read.text);

    let mut info = Map::new();
    info.insert("stdout".into(), json!(out.text));
    info.insert("stderr".into(), json!(err.text));
    info.insert("stdoutTotalBytes".into(), json!(stdout.total_bytes()));
    info.insert("stderrTotalBytes".into(), json!(stderr.total_bytes()));
    if stdout.dropped_bytes() > 0 {
        info.insert("stdoutDroppedBytes".into(), json!(stdout.dropped_bytes()));
    }
    if stderr.dropped_bytes() > 0 {
        info.insert("stderrDroppedBytes".into(), json!(stderr.dropped_bytes()));
    }
    info.insert("running".into(), json!(exit_code.is_none()));
    info.insert("exitCode".into(), json!(exit_code));
    info.insert("pid".into(), json!(pid));
    if filter.is_active() {
        for (k, v) in filter.stats_fields("stdout", &out) {
            info.insert(k, v);
        }
        for (k, v) in filter.stats_fields("stderr", &err) {
            info.insert(k, v);
        }
    }

    // 这个工具是唯一一处「本来就靠翻页取全量」的入口，所以返回上限给得比 run_command
    // 宽（45KB 顶），并回传 nextOffsets 让调用方接着往下读（方案 §3.3 定稿 ⑤）。
    let info = fit_result(
        info,
        &FitOpts {
            limit: MAX_RETURN_LIMIT,
            extract_key_lines: !filter.is_active(),
            tail_is_final: exit_code.is_some(),
            next_offsets: true,
        },
    );

    Ok(text_result(&Value::Object(info)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::testutil::make_state_default;

    fn args(handle: &str) -> GetCommandOutputArgs {
        GetCommandOutputArgs {
            handle: handle.to_string(),
            stdout_offset: 0,
            stderr_offset: 0,
            include: None,
            exclude: None,
            tail_lines: None,
        }
    }

    #[tokio::test]
    async fn unknown_handle_returns_error() {
        let state = make_state_default();
        let result = handle(args("cmd_missing"), &state).await;
        let err = result.expect_err("unknown handle must Err");
        assert!(
            err.contains("未知") || err.contains("cmd_missing"),
            "错误信息应指明 unknown handle，实际：{err}"
        );
    }

    /// 非法正则要整次报错（不是静默返回未过滤的输出）。校验发生在查 handle 之前。
    #[tokio::test]
    async fn invalid_pattern_is_rejected_before_lookup() {
        let state = make_state_default();
        let mut a = args("cmd_missing");
        a.exclude = Some("([".into());
        let err = handle(a, &state).await.expect_err("非法正则必须报错");
        assert!(err.contains("exclude"), "应指出是哪个参数：{err}");
    }
}
