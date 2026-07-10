use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::RawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::process_job;
use crate::security;
use crate::state::{AppState, RunningCommand};

/// 子进程创建标志。
/// - `CREATE_NO_WINDOW (0x08000000)`：不创建可见控制台窗口，输出走管道（Stdio::piped）。
///   相比 `DETACHED_PROCESS`，真实 .exe 子进程（git/cargo/npm）的 stdout/stderr 能被正确
///   捕获（DETACHED_PROCESS 下孙进程控制台输出会丢失）；相比 ConPTY（portable-pty），
///   不需要终端模拟器回应控制序列握手，cmd.exe 不会卡在 DSR 查询。
/// - `CREATE_NEW_PROCESS_GROUP (0x00000200)`：把 cmd 及其子孙放进独立进程组，隔离控制台
///   事件广播，缓解 MSVC 并发链接时偶发的 STATUS_CONTROL_C_EXIT 崩溃
///   （仅当远程用本工具自构建 cc-bridge 本体时可能触发，构建用户自己的项目无此问题）。
const CREATE_NO_WINDOW: u32 = 0x08000000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

fn default_timeout_ms() -> u64 {
    30_000
}

fn default_max_output_bytes() -> usize {
    1024 * 1024
}

/// 危险命令黑名单（对齐 rustterm-mcp 安全模型）。
/// 采用子串匹配（to_lowercase 后 contains），是低成本的第一道闸——
/// 拦掉最典型的毁灭性命令，避免开了 shell 开关后一条 `rm -rf /` 抹掉整机。
const DANGEROUS_COMMAND_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "rm -fr /",
    "mkfs",
    "format c:",
    ":(){:|:&};:", // fork bomb
];

/// 命中任一危险模式即返回 true。
///
/// 注意：这是启发式黑名单，误伤 / 漏拦并存——`echo "rm -rf /"` 会被误拦，
/// `rm -rf /home` 不会被拦。它只是最低成本的兜底闸，不能替代真正的沙箱。
/// 二期应升级为命令白名单或 shell 令牌化解析（见 功能优化清单 D4）。
fn is_dangerous_command(command: &str) -> bool {
    let normalized = command.to_lowercase();
    DANGEROUS_COMMAND_PATTERNS
        .iter()
        .any(|d| normalized.contains(*d))
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

/// 用 `cmd /C <command>` 在白名单 cwd 内执行命令，stdout/stderr 分别经管道捕获。
///
/// 无状态：不跨调用保留 shell 会话，`cd` / 环境变量不会带到下一次调用——每次必须显式传
/// 绝对 `cwd`（见 http.rs 工具描述）。stdout 与 stderr 分开返回（不像 ConPTY 那样合并），
/// 调用方可直接依赖 "stderr 非空 = 出错" 判断。
pub async fn handle(args: RunCommandArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    if !config.shell_enabled {
        return Err(
            "命令执行未开启。请在 cc-bridge 面板『安全』页开启「命令执行」开关——\
            该功能等同于授予远程调用方任意代码执行权限，请确认风险后再开启。"
                .to_string(),
        );
    }
    // 危险命令拦截：在解析 cwd / spawn 之前先挡掉毁灭性命令（rm -rf /、mkfs、fork bomb 等）。
    // 这是启发式黑名单兜底闸，不进入白名单解析、不注册到运行表。
    if is_dangerous_command(&args.command) {
        return Err(
            "命令被安全策略拦截：命中危险模式（如 rm -rf /、mkfs、fork bomb）。\
            如确有必要，请改用更精确、限定作用范围的写法后重试。"
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

    let command = args.command;
    let cwd_display = args.cwd;
    let background = args.background;
    let timeout_ms = args.timeout_ms;
    let state = state.clone();

    // spawn + wait 是同步阻塞 API，丢进 spawn_blocking 避免占用 tokio 工作线程。
    tokio::task::spawn_blocking(move || {
        spawn_shell(
            &command,
            &resolved_cwd,
            cwd_display,
            background,
            timeout_ms,
            max_output_bytes,
            &state,
        )
    })
    .await
    .map_err(|e| format!("run_command 任务 panic: {e}"))?
}

fn spawn_shell(
    command: &str,
    resolved_cwd: &std::path::Path,
    cwd_display: String,
    background: bool,
    timeout_ms: u64,
    max_output_bytes: usize,
    state: &Arc<AppState>,
) -> Result<Value, String> {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", command]);
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.current_dir(resolved_cwd);

    let child = cmd.spawn().map_err(|e| format!("启动命令失败: {e}"))?;

    // 把子进程挂入 Job Object（kill-on-job-close）：前台超时/结束时 drop job 顺带整树
    // 终止（含 cmd 的孙进程 git/cargo 等）；stop_command 也靠 drop job 清理孤儿进程。
    let raw_handle: RawHandle = child.as_raw_handle();
    if raw_handle.is_null() {
        return Err("命令刚启动就已退出，无法获取进程句柄".to_string());
    }
    let job = process_job::create_and_assign(raw_handle as isize)?;

    if background {
        spawn_background(
            job,
            child,
            max_output_bytes,
            command.to_string(),
            cwd_display,
            state,
        )
    } else {
        run_foreground(job, child, timeout_ms, max_output_bytes)
    }
}

/// 起一个专门的 OS 线程持续读取管道输出（Read trait 是同步阻塞的，不能直接 await）。
/// 累积缓冲区用 tokio::sync::Mutex 以便复用 get_command_output.rs 的 `.lock().await` 路径。
fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    max_output_bytes: usize,
) -> (Arc<AsyncMutex<Vec<u8>>>, Arc<AtomicBool>) {
    let buf = Arc::new(AsyncMutex::new(Vec::<u8>::new()));
    let truncated = Arc::new(AtomicBool::new(false));
    let buf_clone = buf.clone();
    let truncated_clone = truncated.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let mut b = buf_clone.blocking_lock();
                    if b.len() >= max_output_bytes {
                        truncated_clone.store(true, Ordering::Relaxed);
                        continue;
                    }
                    let take = (max_output_bytes - b.len()).min(n);
                    b.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated_clone.store(true, Ordering::Relaxed);
                    }
                }
                Err(_) => break,
            }
        }
    });
    (buf, truncated)
}

fn take_reader(
    pipe: Option<impl Read + Send + 'static>,
    max_output_bytes: usize,
) -> (Arc<AsyncMutex<Vec<u8>>>, Arc<AtomicBool>) {
    match pipe {
        Some(s) => spawn_reader_thread(Box::new(s), max_output_bytes),
        None => (
            Arc::new(AsyncMutex::new(Vec::new())),
            Arc::new(AtomicBool::new(false)),
        ),
    }
}

fn run_foreground(
    job: win32job::Job,
    mut child: Child,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> Result<Value, String> {
    let (stdout_buf, stdout_trunc) = take_reader(child.stdout.take(), max_output_bytes);
    let (stderr_buf, stderr_trunc) = take_reader(child.stderr.take(), max_output_bytes);

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    break None;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            Err(_) => break None,
        }
    };

    match status {
        Some(status) => {
            // 命令正常结束后 drop job；给读取线程一点时间把管道剩余数据读完。
            drop(job);
            std::thread::sleep(Duration::from_millis(50));
            let stdout = stdout_buf.blocking_lock().clone();
            let stderr = stderr_buf.blocking_lock().clone();
            Ok(text_result(json!({
                "stdout": String::from_utf8_lossy(&stdout),
                "stderr": String::from_utf8_lossy(&stderr),
                "exitCode": status.code(),
                "stdoutTruncated": stdout_trunc.load(Ordering::Relaxed),
                "stderrTruncated": stderr_trunc.load(Ordering::Relaxed),
                "timedOut": false,
            })))
        }
        None => {
            let _ = child.kill();
            drop(job);
            Ok(text_result(json!({
                "stdout": "",
                "stderr": "",
                "exitCode": Value::Null,
                "stdoutTruncated": false,
                "stderrTruncated": false,
                "timedOut": true,
                "note": format!("命令超过 {timeout_ms}ms 未结束，已强制终止（含子进程）"),
            })))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_background(
    job: win32job::Job,
    mut child: Child,
    max_output_bytes: usize,
    command: String,
    cwd: String,
    state: &Arc<AppState>,
) -> Result<Value, String> {
    let (stdout_buf, stdout_trunc) = take_reader(child.stdout.take(), max_output_bytes);
    let (stderr_buf, stderr_trunc) = take_reader(child.stderr.take(), max_output_bytes);

    let pid = child.id();
    let exit_code: Arc<AsyncMutex<Option<i32>>> = Arc::new(AsyncMutex::new(None));
    let exit_code_clone = exit_code.clone();
    std::thread::spawn(move || {
        if let Ok(status) = child.wait() {
            *exit_code_clone.blocking_lock() = status.code();
        }
    });

    let handle_id = format!("cmd_{:016x}", rand::random::<u64>());
    state.running_commands.insert(
        handle_id.clone(),
        RunningCommand {
            pid,
            command,
            cwd,
            job,
            stdout: stdout_buf,
            stderr: stderr_buf,
            stdout_truncated: stdout_trunc,
            stderr_truncated: stderr_trunc,
            exit_code,
            started_at: Instant::now(),
        },
    );

    Ok(text_result(json!({ "handle": handle_id, "pid": pid })))
}

fn text_result(info: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&info).unwrap() }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BridgeConfig;
    use crate::db;
    use crate::state::AppState;
    use std::path::Path;
    use std::sync::atomic::AtomicU64;

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn unique_subdir(label: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cc-bridge-mcp-test-{label}-{}-{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tempdir create");
        dir
    }

    fn make_state_with_config(
        f: impl FnOnce(&mut BridgeConfig),
    ) -> (Arc<AppState>, std::path::PathBuf) {
        let dir = unique_subdir("run_cmd");
        let conn = db::init_database(Path::new(&dir)).expect("init db");
        let mut cfg = BridgeConfig {
            allowed_roots: vec![dir.to_string_lossy().into_owned()],
            ..BridgeConfig::default()
        };
        f(&mut cfg);
        let state = Arc::new(AppState::new(conn, cfg, dir.clone()));
        (state, dir)
    }

    /// 关 shell_enabled 时 run_command 必须立刻拒绝、与 cwd 白名单无关。
    /// 这是默认状态——所有"命令执行"调用方默认全拒，等用户在面板显式开开关。
    /// 如果这条 case 失败，意味着默认状态行为改变 = 安全回归。
    #[tokio::test]
    async fn shell_disabled_returns_error_without_spawning() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = false;
            // 白名单开着，但 shell 开关关——验证是 shell 开关先拒、不是路径先拒。
            c.whitelist_enabled = true;
        });

        let result = handle(
            RunCommandArgs {
                command: "echo should_not_run".into(),
                cwd: dir.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
            },
            &state,
        )
        .await;

        let err = result.expect_err("shell_enabled=false 必须 Err");
        assert!(
            err.contains("命令执行未开启") || err.contains("shell_enabled"),
            "错误信息应提示开关未开，实际：{err}"
        );
        // 关键断言：注册表必须保持空——开关拒时不能让占位 entry 泄露。
        assert!(state.running_commands.is_empty());
    }

    /// 危险命令必须在 spawn 前被拦截，且不进入 cwd 白名单解析、不注册到运行表。
    /// 覆盖 D4 安全债：开了 shell 开关后，rm -rf / 这类毁灭性命令仍应被兜底闸挡下。
    #[tokio::test]
    async fn dangerous_command_blocked_before_spawn() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let result = handle(
            RunCommandArgs {
                command: "rm -rf /".into(),
                cwd: dir.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
            },
            &state,
        )
        .await;
        let err = result.expect_err("危险命令必须被拦截");
        assert!(
            err.contains("安全策略"),
            "应提示被安全策略拦截，实际：{err}"
        );
        // 关键断言：被拦时不能注册到运行表。
        assert!(state.running_commands.is_empty());
    }

    /// 大小写不敏感：MKFS / Rm -Rf / 变体也应命中。
    #[tokio::test]
    async fn dangerous_command_case_insensitive() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let result = handle(
            RunCommandArgs {
                command: "MKFS.ext4 /dev/sda".into(),
                cwd: dir.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
            },
            &state,
        )
        .await;
        assert!(result.is_err(), "大写危险命令也应被拦截");
        assert!(state.running_commands.is_empty());
    }

    /// 正常命令（含单词 rm 但非危险模式）不应被误拦——is_dangerous_command 只匹配整段模式。
    #[tokio::test]
    async fn benign_command_not_blocked_by_dangerous_filter() {
        // 直接单元测试判定函数，避免真实 spawn 的平台依赖。
        assert!(!is_dangerous_command("cargo build --release"));
        assert!(!is_dangerous_command("git status"));
        assert!(!is_dangerous_command("rm -rf ./build")); // 相对路径，不命中 "rm -rf /"
        assert!(is_dangerous_command("rm -rf /"));
        assert!(is_dangerous_command("sudo MKFS /dev/sdb"));
    }

    /// cwd 不在白名单 = security::path::resolve_safe_path 报"白名单不含..."。
    /// 这条路径与 shell_enabled 无关——即使壳层开着，路径不对一样拒。
    #[tokio::test]
    async fn cwd_outside_whitelist_rejected() {
        let (state, _allowed_dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            // 注意 allowed_roots = [_allowed_dir]，下面传入一个完全不同的路径。
        });

        // 用 windows temp（肯定不在白名单里）。
        let forbidden = std::env::temp_dir()
            .parent()
            .unwrap_or(&std::env::temp_dir())
            .join("definitely_not_whitelisted_subdir_xyz");

        let result = handle(
            RunCommandArgs {
                command: "echo nothing".into(),
                cwd: forbidden.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
            },
            &state,
        )
        .await;

        let err = result.expect_err("whitelist 外路径必须 Err");
        // 不强制固定文案（白名单模块改文案不应破坏测试），只确认拒绝方向正确：
        assert!(!err.is_empty(), "应返回非空错误");
        assert!(state.running_commands.is_empty());
    }

    /// cwd 必须存在且是目录，不能是文件。如果用户传 /foo.txt 必须立刻报，不是启动子进程后才察觉。
    #[tokio::test]
    async fn cwd_is_file_rejected() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        // 在 allowed_root 下造一个真实文件。
        let file_path = dir.join("not_a_directory.txt");
        std::fs::write(&file_path, "hello").expect("create file");

        let result = handle(
            RunCommandArgs {
                command: "echo nothing".into(),
                cwd: file_path.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
            },
            &state,
        )
        .await;

        let err = result.expect_err("文件做 cwd 必须 Err");
        // run_command.rs 抛 "cwd 不是一个目录"。
        assert!(
            err.contains("cwd") && err.contains("目录"),
            "错误应明确指出 cwd 不是目录，实际：{err}"
        );
        assert!(state.running_commands.is_empty());
    }

    /// 实际 spawn `cmd /C echo hello` 验证 stdout 能拿到。
    /// 这是 run_command 的核心回归：用 CREATE_NO_WINDOW + Stdio::piped() 取代 portable-pty
    /// （ConPTY 下 cmd.exe 会卡在 DSR 控制序列握手，输出全空）后，输出必须正常捕获。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn foreground_echo_returns_stdout() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let v = handle(
            RunCommandArgs {
                command: "echo hello".into(),
                cwd: dir.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
            },
            &state,
        )
        .await
        .expect("foreground echo should succeed");

        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .expect("response must have text payload");
        let info: serde_json::Value = serde_json::from_str(text).expect("text payload is JSON");

        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(
            stdout.contains("hello"),
            "stdout 应含 'hello'，实际：{stdout:?}"
        );
        assert_eq!(info.get("exitCode").and_then(|e| e.as_i64()), Some(0));
        assert_eq!(info.get("timedOut").and_then(|t| t.as_bool()), Some(false));
    }

    /// 真实 .exe 子进程（不是 cmd 内置命令）的 stdout 必须能拿到。
    /// `command = "hostname"` 经 `cmd /C hostname` 执行，hostname.exe 作为孙进程被 spawn，
    /// 正好复现原 DETACHED_PROCESS 方案的 bug 场景（真实 .exe 输出丢失）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn foreground_real_exe_returns_stdout() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let v = handle(
            RunCommandArgs {
                command: "hostname".into(),
                cwd: dir.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
            },
            &state,
        )
        .await
        .expect("foreground hostname should succeed");

        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .expect("response must have text payload");
        let info: serde_json::Value = serde_json::from_str(text).expect("text payload is JSON");

        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(
            !stdout.trim().is_empty(),
            "hostname stdout 应为非空主机名，实际：{stdout:?}"
        );
        assert_eq!(info.get("exitCode").and_then(|e| e.as_i64()), Some(0));
        assert_eq!(info.get("timedOut").and_then(|t| t.as_bool()), Some(false));
    }

    /// exitCode 必须真透传——exit 7 应返回 7，不能因包装而吞掉。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn foreground_exit_code_propagates() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let v = handle(
            RunCommandArgs {
                command: "exit 7".into(),
                cwd: dir.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
            },
            &state,
        )
        .await
        .expect("foreground exit code should succeed");
        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .unwrap();
        let info: serde_json::Value = serde_json::from_str(text).unwrap();
        let code = info
            .get("exitCode")
            .and_then(|e| e.as_i64())
            .expect("exitCode must be a number");
        assert!(code != 0, "非 0 退出码应透传：{code}");
    }

    /// max_output_bytes 截断：开 10 字节上限跑长输出，期望 stdoutTruncated:true 且 stdout 长度 ≤ 10。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn foreground_max_output_bytes_truncates() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let v = handle(
            RunCommandArgs {
                command: "echo a_long_string_to_ensure_truncation".into(),
                cwd: dir.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 10,
            },
            &state,
        )
        .await
        .expect("truncation test should succeed");
        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .unwrap();
        let info: serde_json::Value = serde_json::from_str(text).unwrap();
        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(
            stdout.len() <= 10,
            "stdout 应 ≤ 10 字节，实际 {} 字节：{stdout:?}",
            stdout.len()
        );
        assert_eq!(
            info.get("stdoutTruncated").and_then(|t| t.as_bool()),
            Some(true),
            "stdoutTruncated 字段必须是 true"
        );
    }

    /// stderr 必须正确分离——往 stderr 写的东西不应混进 stdout。
    /// `echo ... 1>&2` 把内容重定向到 stderr，验证 stdout 为空、stderr 含内容。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn foreground_stderr_separated() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let v = handle(
            RunCommandArgs {
                command: "echo err_payload 1>&2".into(),
                cwd: dir.to_string_lossy().into_owned(),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
            },
            &state,
        )
        .await
        .expect("stderr separation test should succeed");
        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .unwrap();
        let info: serde_json::Value = serde_json::from_str(text).unwrap();
        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        let stderr = info.get("stderr").and_then(|s| s.as_str()).unwrap_or("");
        assert!(stdout.trim().is_empty(), "stdout 应为空，实际：{stdout:?}");
        assert!(
            stderr.contains("err_payload"),
            "stderr 应含 'err_payload'，实际：{stderr:?}"
        );
    }

    /// background=true 应注册到 running_commands 并返 handle + pid。
    /// 然后我们用这个 handle 调 get_command_output 验证它能取到状态。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn background_registers_with_handle() {
        use crate::mcp::tools::get_command_output;
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let v = handle(
            RunCommandArgs {
                command: "echo background_test_payload".into(),
                cwd: dir.to_string_lossy().into_owned(),
                background: true,
                timeout_ms: 5000,
                max_output_bytes: 4096,
            },
            &state,
        )
        .await
        .expect("background should succeed and return handle");
        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .unwrap();
        let info: serde_json::Value = serde_json::from_str(text).unwrap();
        let handle = info
            .get("handle")
            .and_then(|h| h.as_str())
            .expect("background response missing handle")
            .to_string();
        let pid = info
            .get("pid")
            .and_then(|p| p.as_u64())
            .expect("background response missing pid");
        assert!(pid > 0, "pid must be non-zero, got {pid}");

        // 关键断言：注册表里现在有这条。
        assert!(
            state.running_commands.contains_key(&handle),
            "注册表应含 handle={handle}"
        );

        // 给足时间让 cmd 把 stdout 写到管道并被读取线程捕获，再读。
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;

        let out = get_command_output::handle(
            get_command_output::GetCommandOutputArgs {
                handle: handle.clone(),
                stdout_offset: 0,
                stderr_offset: 0,
            },
            &state,
        )
        .await
        .expect("get_command_output should succeed");
        let text = out
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .unwrap();
        let info: serde_json::Value = serde_json::from_str(text).unwrap();
        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(
            stdout.contains("background_test_payload"),
            "get_command_output 的 stdout 应含 payload，实际：{stdout:?}"
        );
    }
}
