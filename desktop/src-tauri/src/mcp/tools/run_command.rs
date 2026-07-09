use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// DETACHED_PROCESS（而非 CREATE_NO_WINDOW）：完全不分配控制台（CREATE_NO_WINDOW 其实还是会分配一个
/// 隐藏控制台，只是不显示窗口，实测这个隐藏控制台会被 cargo 自己开的大量并发
/// rustc/link.exe 子进程共享，一旦有一个触发控制台事件就会广播给全部共享该控制台的子进程，
/// 导致多个链接/编译子进程同时以 STATUS_CONTROL_C_EXIT 异常退出（可能与 MSVC 的
/// mspdbsrv.exe 共享 PDB 序列化服务在隐藏控制台下不稳定有关，是 Windows 非交互会话下
/// 并发 MSVC 链接的已知雷区）。DETACHED_PROCESS 让子进程完全无控制台（而不是隐藏的控制台），
/// 不存在可广播信号的共享控制台对象。
/// CREATE_NEW_PROCESS_GROUP：另外避免不同次 run_command 调用之间（比如 stop_command 的
/// taskkill）互相信号串串。
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const SPAWN_FLAGS: u32 = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;

use crate::security;
use crate::state::{AppState, RunningCommand};

fn default_timeout_ms() -> u64 {
    30_000
}

fn default_max_output_bytes() -> usize {
    1024 * 1024
}

#[derive(Debug, Deserialize)]
pub struct RunCommandArgs {
    pub command: String,
    pub cwd: String,
    #[serde(default)]
    pub background: bool,
    #[serde(default = "default_timeout_ms", rename = "timeoutMs")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_output_bytes", rename = "maxOutputBytes")]
    pub max_output_bytes: usize,
}

const MAX_CONCURRENT_BACKGROUND: usize = 5;

/// 执行任意 Shell 命令（`cmd /C`）。等同于授予远程调用方任意代码执行权限，
/// 仅在 `shell_enabled` 开关开启且非只读模式时可用。cwd 必传且必须在白名单内，
/// 不支持跨调用持久化 `cd`（无状态设计，避免并发调用互相污染 cwd）。
pub async fn handle(args: RunCommandArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    if !config.shell_enabled {
        return Err(
            "命令执行未开启。请在 cc-bridge 面板『安全』页开启「命令执行」开关——\
            该功能等同于授予远程调用方任意代码执行权限，请确认风险后再开启。"
                .to_string(),
        );
    }
    let resolved_cwd = security::path::resolve_safe_path(
        &args.cwd,
        &config.allowed_roots,
        config.whitelist_enabled,
    )?;
    if !resolved_cwd.is_dir() {
        return Err(format!("cwd 不是一个目录: {}", resolved_cwd.display()));
    }
    let max_output_bytes = args.max_output_bytes.max(1);
    drop(config);

    if args.background && state.running_commands.len() >= MAX_CONCURRENT_BACKGROUND {
        return Err(format!(
            "后台命令数已达上限（{MAX_CONCURRENT_BACKGROUND}），请先用 stop_command 结束一些再试。"
        ));
    }

    let mut child = Command::new("cmd")
        .arg("/C")
        .arg(&args.command)
        .current_dir(&resolved_cwd)
        .creation_flags(SPAWN_FLAGS) // 无控制台，不是隐藏控制台
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动命令失败: {e}"))?;

    let pid = child.id().unwrap_or(0);

    if args.background {
        spawn_background(pid, child, max_output_bytes, args.command, args.cwd, state).await
    } else {
        run_foreground(pid, &mut child, args.timeout_ms, max_output_bytes).await
    }
}

async fn read_capped(mut stream: impl AsyncReadExt + Unpin, cap: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() >= cap {
                    truncated = true;
                    continue; // 持续读空丢弃，避免子进程写满管道后阻塞
                }
                let take = (cap - buf.len()).min(n);
                buf.extend_from_slice(&chunk[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (buf, truncated)
}

fn kill_process_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(SPAWN_FLAGS)
        .output();
}

async fn run_foreground(
    pid: u32,
    child: &mut Child,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> Result<Value, String> {
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let stdout_task = tokio::spawn(read_capped(stdout, max_output_bytes));
    let stderr_task = tokio::spawn(read_capped(stderr, max_output_bytes));

    let wait_result = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()).await;

    match wait_result {
        Ok(Ok(status)) => {
            let (stdout_buf, stdout_truncated) = stdout_task.await.unwrap_or((vec![], false));
            let (stderr_buf, stderr_truncated) = stderr_task.await.unwrap_or((vec![], false));
            Ok(text_result(json!({
                "stdout": String::from_utf8_lossy(&stdout_buf),
                "stderr": String::from_utf8_lossy(&stderr_buf),
                "exitCode": status.code(),
                "truncated": stdout_truncated || stderr_truncated,
                "timedOut": false,
            })))
        }
        Ok(Err(e)) => Err(format!("等待命令退出失败: {e}")),
        Err(_) => {
            // 超时：整树强杀。已知限制（v1 简化）：超时前已产生的输出不会随结果返回，
            // 因为直接 abort 了读取任务。若需要保留超时前输出，后续可改为先 abort 前尝试
            // 非阻塞取当前已缓存内容。
            stdout_task.abort();
            stderr_task.abort();
            kill_process_tree(pid);
            Ok(text_result(json!({
                "stdout": "",
                "stderr": "",
                "exitCode": Value::Null,
                "truncated": false,
                "timedOut": true,
                "note": format!("命令超过 {timeout_ms}ms 未结束，已强制终止（含子进程）"),
            })))
        }
    }
}

async fn spawn_background(
    pid: u32,
    mut child: Child,
    max_output_bytes: usize,
    command: String,
    cwd: String,
    state: &Arc<AppState>,
) -> Result<Value, String> {
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let stdout_buf = Arc::new(AsyncMutex::new(Vec::<u8>::new()));
    let stderr_buf = Arc::new(AsyncMutex::new(Vec::<u8>::new()));
    let stdout_truncated = Arc::new(AtomicBool::new(false));
    let stderr_truncated = Arc::new(AtomicBool::new(false));
    let exit_code: Arc<AsyncMutex<Option<i32>>> = Arc::new(AsyncMutex::new(None));

    spawn_reader(
        stdout,
        stdout_buf.clone(),
        stdout_truncated.clone(),
        max_output_bytes,
    );
    spawn_reader(
        stderr,
        stderr_buf.clone(),
        stderr_truncated.clone(),
        max_output_bytes,
    );

    let exit_code_clone = exit_code.clone();
    tokio::spawn(async move {
        if let Ok(status) = child.wait().await {
            *exit_code_clone.lock().await = Some(status.code().unwrap_or(-1));
        }
    });

    let handle_id = format!("cmd_{:016x}", rand::random::<u64>());
    state.running_commands.insert(
        handle_id.clone(),
        RunningCommand {
            pid,
            command,
            cwd,
            stdout: stdout_buf,
            stderr: stderr_buf,
            stdout_truncated,
            stderr_truncated,
            exit_code,
            started_at: Instant::now(),
        },
    );

    Ok(text_result(json!({ "handle": handle_id, "pid": pid })))
}

fn spawn_reader(
    mut stream: impl AsyncReadExt + Unpin + Send + 'static,
    buf: Arc<AsyncMutex<Vec<u8>>>,
    truncated: Arc<AtomicBool>,
    cap: usize,
) {
    tokio::spawn(async move {
        let mut chunk = [0u8; 8192];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    let mut b = buf.lock().await;
                    if b.len() >= cap {
                        truncated.store(true, Ordering::Relaxed);
                        continue;
                    }
                    let take = (cap - b.len()).min(n);
                    b.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated.store(true, Ordering::Relaxed);
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn text_result(info: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&info).unwrap() }]
    })
}
