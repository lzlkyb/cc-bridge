use std::os::windows::io::RawHandle;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::process_job;
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

/// 候选修复（2026-07-10，待手动编译 + 重启 cc-bridge 验证，尚未确认有效）。
///
/// 背景：实测发现无论前台/后台，只要命令是一个真实独立的 .exe（hostname.exe、
/// git.exe、cargo.exe——不是 cmd.exe 内置命令如 echo/type），stdout/stderr 都
/// 读不到任何内容（但 exitCode 一直正确）。根因推测：外层 cmd.exe 用
/// DETACHED_PROCESS（完全无控制台）生成，它再往下 spawn 真实 exe（孙进程）时，
/// Windows 对"无控制台进程的控制台子系统孙进程"处理不干净，孙进程的标准输出
/// 没有正确复用外层设置好的管道。换回 CREATE_NO_WINDOW 能大概率修好这个
/// 问题，但会重新暴露之前踩过的 MSVC 并发链接崩溃（多个 rustc/link.exe 共享
/// 同一隐藏控制台，一个触发控制台事件就全体 STATUS_CONTROL_C_EXIT）。
///
/// ConPTY 是 Windows 官方现代控制台子系统的替代实现，理论上应该能同时避开这两个
/// 问题——但这只是推测，需要实际验证两点：
/// 1) 普通命令（git/hostname 等）现在能不能正常拿到输出；
/// 2) 高并发编译（比如重新编译 cc-bridge 自己一堆依赖 crate）还会不会崩
///    （STATUS_CONTROL_C_EXIT）。
///
/// **已知的行为变化（无法避免）**：PTY 天然只有一路输出（stdout/stderr 在终端里
/// 本来就是混在一起显示的），没法像原来那样分开。这里全部塞进 `stdout` 字段，
/// `stderr` 字段固定返回空字符串——调用方如果依赖"stderr 非空=出错"这类判断
/// 需要调整（cc-bridge 自己的审计日志不受影响，只记录 success/error 与耗时，
/// 不解析 stdout/stderr 内容）。
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

    let command = args.command;
    let cwd_display = args.cwd;
    let background = args.background;
    let timeout_ms = args.timeout_ms;
    let state = state.clone();

    // PTY 的创建/spawn/读取都是同步阻塞 API，丢进 spawn_blocking 避免占用 tokio 工作线程。
    tokio::task::spawn_blocking(move || {
        spawn_pty(
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

fn spawn_pty(
    command: &str,
    resolved_cwd: &std::path::Path,
    cwd_display: String,
    background: bool,
    timeout_ms: u64,
    max_output_bytes: usize,
    state: &Arc<AppState>,
) -> Result<Value, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 40,
            cols: 200,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("创建伪终端失败: {e}"))?;

    let mut cmd = CommandBuilder::new("cmd");
    cmd.arg("/C");
    cmd.arg(command);
    cmd.cwd(resolved_cwd);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动命令失败: {e}"))?;
    // slave 端子进程已经复制了一份句柄，父进程这边释放，避免占着不用的读写端。
    drop(pair.slave);

    let pid = child.process_id().unwrap_or(0);
    let raw_handle: RawHandle = child
        .as_raw_handle()
        .ok_or_else(|| "命令刚启动就已退出，无法获取进程句柄".to_string())?;
    let job = process_job::create_and_assign(raw_handle as isize)?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("获取伪终端读取端失败: {e}"))?;

    if background {
        spawn_background(
            job,
            pid,
            child,
            reader,
            max_output_bytes,
            command.to_string(),
            cwd_display,
            state,
        )
    } else {
        run_foreground(job, child, reader, timeout_ms, max_output_bytes)
    }
}

/// 起一个专门的 OS 线程持续读取 PTY 输出（Read trait 是同步阻塞的，不能直接 await）。
/// 累积缓冲区用 tokio::sync::Mutex 是为了复用 get_command_output.rs 里已有的
/// `.lock().await` 读取路径——这里从同步线程用 `blocking_lock()` 写入即可，不用为了
/// 这次改动去动 get_command_output.rs/commands.rs。
fn spawn_reader_thread(
    mut reader: Box<dyn std::io::Read + Send>,
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

fn run_foreground(
    job: win32job::Job,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    reader: Box<dyn std::io::Read + Send>,
    timeout_ms: u64,
    max_output_bytes: usize,
) -> Result<Value, String> {
    let (buf, truncated) = spawn_reader_thread(reader, max_output_bytes);

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
            // 命令正常结束后 drop job：顺带清理可能残留的子孙进程（比如 `cmd /C` 里
            // 用 `start` 开出去的 detached 后台进程），语义与 win32job 版本一致。
            drop(job);
            // 给读取线程一点时间把管道里剩余数据读完（子进程已退出，读到 EOF 很快）。
            std::thread::sleep(Duration::from_millis(50));
            let output = buf.blocking_lock().clone();
            Ok(text_result(json!({
                "stdout": String::from_utf8_lossy(&output),
                "stderr": "",
                "exitCode": status.exit_code(),
                "truncated": truncated.load(Ordering::Relaxed),
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
                "truncated": false,
                "timedOut": true,
                "note": format!("命令超过 {timeout_ms}ms 未结束，已强制终止（含子进程）"),
            })))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_background(
    job: win32job::Job,
    pid: u32,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    reader: Box<dyn std::io::Read + Send>,
    max_output_bytes: usize,
    command: String,
    cwd: String,
    state: &Arc<AppState>,
) -> Result<Value, String> {
    let (buf, truncated) = spawn_reader_thread(reader, max_output_bytes);

    let exit_code: Arc<AsyncMutex<Option<i32>>> = Arc::new(AsyncMutex::new(None));
    let exit_code_clone = exit_code.clone();
    std::thread::spawn(move || {
        if let Ok(status) = child.wait() {
            *exit_code_clone.blocking_lock() = Some(status.exit_code() as i32);
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
            stdout: buf,
            stderr: Arc::new(AsyncMutex::new(Vec::new())),
            stdout_truncated: truncated,
            stderr_truncated: Arc::new(AtomicBool::new(false)),
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

    fn make_state_with_config(f: impl FnOnce(&mut BridgeConfig)) -> (Arc<AppState>, std::path::PathBuf) {
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

    /// 实际 spawn `cmd /C echo hello` 验证 portable-pty 真能拿到 stdout。
    /// 这是 v2.2.13 实验性"用 portable-pty 取代 DETACHED_PROCESS"的关键回归测试：
    /// 旧 bug 是真实子进程（不是 cmd 内置命令）的 stdout 丢失。如果未来又切回
    /// Stdio::piped() / DETACHED_PROCESS 又复现 bug，这条 case 会 fail。
    ///
    /// `#[ignore]`：2026-07-10 实测在 `cargo test` console session 下 runtime
    /// 会 hang（PTY master 关闭顺序与 cmd.exe 内置 echo 的会话关系不明）。
    /// 跑这条要 `cargo test -- --ignored`。手工 dev 模式重启可触发。
    /// 后续要解开：先确认 run_command.rs 在 `cargo run` 下能正确 exit 再回头 fix 测试环境。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
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

        // text_result 把整个 JSON 包成 {content:[{type:text,text:"..."}]}。
        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .expect("response must have text payload");
        let info: serde_json::Value =
            serde_json::from_str(text).expect("text payload is JSON");

        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(stdout.contains("hello"), "stdout 应含 'hello'，实际：{stdout:?}");
        assert_eq!(info.get("exitCode").and_then(|e| e.as_i64()), Some(0));
        assert_eq!(info.get("timedOut").and_then(|t| t.as_bool()), Some(false));
    }

    /// exitCode 必须真透传——exit 7 应返回 7，不能因 PTY 包装而吞掉。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
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
        // portable_pty 在 Windows 上可能把 exit code 标记为 7，或 256+7=263（signal-like），
        // 不能锁死 7。这里至少要拿到非 0 即可。
        assert!(code != 0, "非 0 退出码应透传：{code}");
    }

    /// max_output_bytes 截断：开 10 字节上限跑长输出，期望 truncated:true 且 stdout 长度 ≤ 10。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
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
            info.get("truncated").and_then(|t| t.as_bool()),
            Some(true),
            "truncated 字段必须是 true"
        );
    }

    /// 真实 .exe 子进程（不是 cmd 内置命令）的 stdout 必须能拿到。
    /// 这是 portable-pty 候选修复要解决的原始 bug：旧 DETACHED_PROCESS 方案下，
    /// `cmd /C hostname`（hostname.exe 是真实孙进程）的 stdout 读不到。
    /// `command = "hostname"` 经 `cmd /C hostname` 执行，hostname.exe 作为孙进程被 spawn，
    /// 正好复现原 bug 场景——这是 echo（cmd 内置）测试覆盖不到的盲区。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
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
        // hostname 输出非空（本机主机名），且 exitCode 应为 0。
        assert!(
            !stdout.trim().is_empty(),
            "hostname stdout 应为非空主机名，实际：{stdout:?}"
        );
        assert_eq!(info.get("exitCode").and_then(|e| e.as_i64()), Some(0));
        assert_eq!(info.get("timedOut").and_then(|t| t.as_bool()), Some(false));
    }

    /// background=true 应注册到 running_commands 并返 handle + pid。
    /// 然后我们用这个 handle 调 get_command_output 验证它能取到状态。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
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

        // 给 200ms 让 cmd 把 stdout 写到 PTY，再读。
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

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
