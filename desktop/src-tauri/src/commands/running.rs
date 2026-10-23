//! 后台命令面板的 IPC 命令：列举正在跑的命令、终止、增量取输出。
//!
//! D19 方案 C 第 4 批。这些是 `run_command(background=true)` 在面板侧的对应操作，
//! 与 MCP 工具 `get_command_output` / `stop_command` 共用同一份 `running_commands` 注册表
//! （见 `crate::state::AppState`）。
//!
//! 本文件是**纯搬动**：函数体逐字节未改。

// 不在这里引 `Ordering`：`get_command_output` 函数体内部自己就有一份局部 `use`
// （只那一处用得到）。搬动时我按“扫到 Ordering 就引一下”加到了顶部，结果重复，
// 被 `clippy -D warnings` 报 unused import 抓出来。
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct RunningCommandInfo {
    pub handle: String,
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    pub running: bool,
    /// 是否被主动终止过（`stop_command` / 面板「终止」）。条目会保留到宽容期结束，
    /// 让面板仍能展开看被杀前的输出。
    pub stopped: bool,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    #[serde(rename = "elapsedSeconds")]
    pub elapsed_seconds: u64,
}

/// 供本机面板展示 run_command(background=true) 启动的后台命令，与远程 MCP 的
/// get_command_output 读的是同一份 `AppState.running_commands` 注册表。
#[tauri::command]
pub async fn list_running_commands(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<RunningCommandInfo>, String> {
    // 先克隆出快照再逐个 await 锁，避免持有 DashMap 的 Ref 跨 await。
    let snapshot: Vec<_> = state
        .running_commands
        .iter()
        .map(|entry| {
            let cmd = entry.value();
            (
                entry.key().clone(),
                cmd.pid,
                cmd.command.clone(),
                cmd.cwd.clone(),
                cmd.exit_code.clone(),
                cmd.finished_elapsed_secs.clone(),
                cmd.started_at.elapsed().as_secs(),
                cmd.stop_requested.clone(),
            )
        })
        .collect();

    let mut result = Vec::with_capacity(snapshot.len());
    for (
        handle,
        pid,
        command,
        cwd,
        exit_code_arc,
        finished_elapsed_arc,
        live_elapsed_seconds,
        stop_requested,
    ) in snapshot
    {
        let exit_code = *exit_code_arc.lock().await;
        // 修复：进程已结束时优先用 wait 线程写入的定格值，不再用 started_at.elapsed() 实时计算，
        // 避免面板里“已运行”在命令早已结束后还一直增长。
        let elapsed_seconds = match *finished_elapsed_arc.lock().await {
            Some(frozen) => frozen,
            None => live_elapsed_seconds,
        };
        result.push(RunningCommandInfo {
            handle,
            pid,
            command,
            cwd,
            running: exit_code.is_none(),
            // stop 之后条目仍在注册表里（保留输出），带出标记让面板区分「自己跑完」与「被终止」。
            stopped: stop_requested.load(std::sync::atomic::Ordering::Relaxed),
            exit_code,
            elapsed_seconds,
        });
    }
    Ok(result)
}

// G5: cleanup_finished_commands / evict_finished_commands moved to state.rs (AppState methods).

/// 本机面板的「终止」按钮：整树终止并**保留条目**（输出仍可在面板里展开查看）。
///
/// 与 MCP 的 `stop_command` 共用 `stop_command::terminate` 同一份实现——两条入口各写一遍
/// 逻辑的话，语义迟早漂移（之前就出现过面板删除、MCP 保留这类不一致）。
#[tauri::command]
pub async fn stop_running_command(
    state: State<'_, Arc<AppState>>,
    handle: String,
) -> Result<(), String> {
    crate::mcp::tools::stop_command::terminate(state.inner(), &handle)
        .await
        .map(|_| ())
}

/// 本机面板实时拉取后台命令（run_command background=true）的输出，与远程 MCP 的
/// get_command_output 读的是同一份 `AppState.running_commands` 注册表。
/// 返回干净结构体（stdout/stderr 文本 + 长度 + 截断标记 + 运行态），供前端增量轮询。
/// 安全不削弱：只暴露已捕获的输出，不新增任何执行 / 控制能力。
#[tauri::command]
pub async fn get_command_output(
    state: State<'_, Arc<AppState>>,
    handle: String,
    stdout_offset: Option<usize>,
    stderr_offset: Option<usize>,
) -> Result<CommandOutput, String> {
    let stdout_offset = stdout_offset.unwrap_or(0);
    let stderr_offset = stderr_offset.unwrap_or(0);
    // 先克隆出需要的 Arc，再释放 DashMap 的 Ref，避免在持有 Ref 期间跨 await。
    let (stdout_arc, stderr_arc, exit_code_arc, pid) = {
        let entry = state
            .running_commands
            .get(&handle)
            .ok_or_else(|| format!("未知的 handle: {handle}（可能已被清理）"))?;
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

    // 与 MCP 侧 get_command_output 同一条读取路径：偏移按整条输出的真实字节位置算，
    // 落在保存缓冲的缺口里时文本里会带一行「中间 N 字节已被省略」的标记。
    let out = stdout.read_from(stdout_offset as u64);
    let err = stderr.read_from(stderr_offset as u64);

    Ok(CommandOutput {
        stdout: out.text,
        stderr: err.text,
        stdout_total_bytes: stdout.total_bytes() as usize,
        stderr_total_bytes: stderr.total_bytes() as usize,
        stdout_truncated: stdout.dropped_bytes() > 0,
        stderr_truncated: stderr.dropped_bytes() > 0,
        running: exit_code.is_none(),
        exit_code,
        pid,
    })
}

#[derive(Debug, Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    #[serde(rename = "stdoutTotalBytes")]
    pub stdout_total_bytes: usize,
    #[serde(rename = "stderrTotalBytes")]
    pub stderr_total_bytes: usize,
    #[serde(rename = "stdoutTruncated")]
    pub stdout_truncated: bool,
    #[serde(rename = "stderrTruncated")]
    pub stderr_truncated: bool,
    pub running: bool,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    pub pid: u32,
}
