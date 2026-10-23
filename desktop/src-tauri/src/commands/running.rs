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
            )
        })
        .collect();

    let mut result = Vec::with_capacity(snapshot.len());
    for (handle, pid, command, cwd, exit_code_arc, finished_elapsed_arc, live_elapsed_seconds) in
        snapshot
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
            exit_code,
            elapsed_seconds,
        });
    }
    Ok(result)
}

// G5: cleanup_finished_commands / evict_finished_commands moved to state.rs (AppState methods).

/// 本机面板的「终止」按钮：移除注册表条目并显式整树终止，逻辑与 MCP 的 stop_command 工具一致。
#[tauri::command]
pub async fn stop_running_command(
    state: State<'_, Arc<AppState>>,
    handle: String,
) -> Result<(), String> {
    // 🔴 与 MCP 的 `stop_command` 同一套顺序（审查 P2）：先取句柄 → 杀 → 成功才摘注册表。
    // 原来是「先 remove 再 `let _ = start_kill()`」，杀失败时进程变孤儿，而面板已经
    // 把它从列表里抹掉了——用户再无手段看见/处理这个进程。
    let (pid, child, exit_code) = {
        let entry = state
            .running_commands
            .get(&handle)
            .ok_or_else(|| format!("未知的 handle: {handle}"))?;
        (entry.pid, entry.child.clone(), entry.exit_code.clone())
    };

    // 已结束的命令不必 kill（对已退出的进程调 start_kill 可能报错，用户只想清掉列表项）。
    let already_done = exit_code.lock().await.is_some();
    if !already_done {
        // 必须显式 start_kill：process-wrap 的 JobObject 默认不 kill-on-close，drop 不会杀进程
        // （见 Cargo.toml:95 注释）。仅 drop 会让后台命令成孤儿进程、输出读取线程泄漏。
        // `child` 为 None 的只有「前台输出被裁后留下的只读快照」，它们的 exit_code 必然已是
        // Some（进程早结束），所以走到这里一定拿得到句柄。
        let child =
            child.ok_or_else(|| format!("进程 {pid} 的句柄已释放，可能已经结束，请刷新列表"))?;
        let mut guard = child
            .lock()
            .map_err(|_| format!("终止进程 {pid} 失败：无法获取进程句柄锁"))?;
        if let Err(e) = guard.start_kill() {
            return Err(format!(
                "终止进程 {pid} 失败：{e}。该命令仍在运行列表中，可稍后重试。"
            ));
        }
    }
    state.running_commands.remove(&handle);
    Ok(())
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
