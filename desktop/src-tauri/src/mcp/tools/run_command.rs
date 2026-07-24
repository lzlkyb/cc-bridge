use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use crate::mcp::tools::command_policy::validate_command_policy;
use crate::mcp::tools::shell::{
    build_invocation, normalize_cwd_from_shell, parse_shell_type, ShellType,
};

use process_wrap::std::{CreationFlags, JobObject, StdChildWrapper, StdCommandWrap};
use windows::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, PROCESS_CREATION_FLAGS,
};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::security;
use crate::state::{AppState, CwdSession, RunningCommand};

/// 子进程创建标志。
/// - `CREATE_NO_WINDOW (0x08000000)`：不创建可见控制台窗口，输出走管道（Stdio::piped）。
///   相比 `DETACHED_PROCESS`，真实 .exe 子进程（git/cargo/npm）的 stdout/stderr 能被正确
///   捕获（DETACHED_PROCESS 下孙进程控制台输出会丢失）；相比 ConPTY（portable-pty），
///   不需要终端模拟器回应控制序列握手，cmd.exe 不会卡在 DSR 查询。
/// - `CREATE_NEW_PROCESS_GROUP (0x00000200)`：把 cmd 及其子孙放进独立进程组，隔离控制台
///   事件广播，缓解 MSVC 并发链接时偶发的 STATUS_CONTROL_C_EXIT 崩溃
///   （仅当远程用本工具自构建 cc-bridge 本体时可能触发，构建用户自己的项目无此问题）。
fn default_timeout_ms() -> u64 {
    30_000
}

fn default_max_output_bytes() -> usize {
    1024 * 1024
}

/// 会话级环境变量条目（key=value），用于 run_command 的 `env` 参数。
/// 跨调用持久化到会话（与 cwd 同生命周期），解决 source venv / export PATH 每调用丢失。
#[derive(Debug, Clone, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct EnvEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct RunCommandArgs {
    pub command: String,
    /// 工作目录（绝对路径，须在白名单内）。会话持久化开启且提供有效 `session_id` 时可省略，
    /// 由 session 绑定的 cwd 取代；否则必传。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 会话级 cwd 持久化的 opaque handle。首次带 `cwd` 调用会返回新 `session_id`（见响应
    /// 的 `sessionId` 字段）；后续调用只传 `session_id` 即可沿用工作目录，免去每次传 cwd。
    /// 仅在 `session_cwd_enabled` 开启时生效；关闭或缺失时忽略（行为同旧版）。
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub background: bool,
    #[serde(default = "default_timeout_ms", rename = "timeoutMs")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_output_bytes", rename = "maxOutputBytes")]
    pub max_output_bytes: usize,
    /// 会话级持久环境变量（key=value 映射）。仅当 session_cwd_enabled 开启且提供有效
    /// session_id（或新建会话）时生效：首次随 cwd 设立会话时作为初始 env，后续调用与既有
    /// env_overrides 合并（后写覆盖）。跨调用保留，解决 source venv / export PATH 每调用
    /// 丢失的问题。注意：无法自动捕获 shell 内 `source` 激活的虚拟环境（每次起重壳激活即
    /// 丢失），请用 env 显式持久化 VIRTUAL_ENV / PATH 等。
    #[serde(default, rename = "env")]
    pub env: Option<Vec<EnvEntry>>,
    /// 人类可读描述，用于权限 UX / 审计日志（对标 native Claude Code 的 description 字段）。
    /// 不参与执行逻辑，仅作记录；缺省为 None。
    #[serde(default)]
    pub description: Option<String>,
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
    // 命令安全策略校验（④P0-1）：在解析 cwd / spawn 之前先按 shell 语法分词、切子命令、
    // 逐子命令做破坏性操作检测（Layer 1，常开）。语法感知——引号内的危险串不误拦、
    // 链式命令任一子命令危险即拦。被拦时不进入白名单解析、不注册到运行表。
    // Layer 2（可执行白名单）已接入：command_allowlist_enabled 开启即传入白名单（含空列表）。
    let policy_shell = parse_shell_type(&config.shell_type);
    // Layer 2（opt-in 可执行白名单）：开关开启即传 Some（fail-closed——空列表=全部拒绝）；
    // 关闭时传 None（仅 Layer 1，不削弱）。注意 config 仍持有读锁，allowlist 借用与 validate 同生命周期。
    let allowlist = if config.command_allowlist_enabled {
        Some(config.command_allowlist.as_slice())
    } else {
        None
    };
    validate_command_policy(&args.command, policy_shell, allowlist)?;
    // 捕获白名单根（cwd 消失恢复用），随后 config 会 drop。
    let allowed_roots = config.allowed_roots.clone();
    let notify_command_complete = config.notify_command_complete;
    // 会话级 cwd 持久化解析（默认关，见 BridgeConfig::session_cwd_enabled）：
    // - 开关关：忽略 session_id，cwd 必传，行为与旧版完全一致。
    // - 开关开 + 给定有效 session_id：复用其绑定 cwd（每次仍重校验白名单，规则7 不削弱）。
    // - 开关开 + 无/无效 session_id：cwd 必传，解析后新建 session 并返回新 id。
    let (resolved_cwd, cwd_display, effective_session_id) = if config.session_cwd_enabled {
        if let Some(sid) = &args.session_id {
            match state.cwd_sessions.get(sid) {
                Some(s) => {
                    let resolved = security::path::resolve_safe_path_cached(
                        &s.cwd.to_string_lossy(),
                        &state.cached_roots(),
                        config.whitelist_enabled,
                    )
                    .map_err(|e| format!("session 绑定的 cwd 已不在白名单：{e}"))?;
                    (resolved, s.cwd.to_string_lossy().into_owned(), Some(sid.clone()))
                }
                None => {
                    return Err(
                        "session_id 不存在或已过期。请重新提供 cwd 以创建新会话，或由工具描述引导重新获取 session_id。"
                            .to_string(),
                    )
                }
            }
        } else {
            let cwd = args.cwd.as_ref().ok_or_else(|| {
                "开启会话持久化时，必须提供 cwd（创建新会话）或有效 session_id（沿用）".to_string()
            })?;
            let resolved = security::path::resolve_safe_path_cached(
                cwd,
                &state.cached_roots(),
                config.whitelist_enabled,
            )?;
            let new_id = format!("cwd_{:032x}", rand::random::<u128>());
            state.cwd_sessions.insert(
                new_id.clone(),
                CwdSession {
                    cwd: resolved.clone(),
                    env_overrides: args
                        .env
                        .clone()
                        .map(|v| v.into_iter().map(|e| (e.key, e.value)).collect())
                        .unwrap_or_default(),
                    last_active: Instant::now(),
                },
            );
            (resolved, cwd.clone(), Some(new_id))
        }
    } else {
        let cwd = args
            .cwd
            .as_ref()
            .ok_or_else(|| "cwd 必传（会话持久化未开启时）".to_string())?;
        let resolved = security::path::resolve_safe_path_cached(
            cwd,
            &state.cached_roots(),
            config.whitelist_enabled,
        )?;
        (resolved, cwd.clone(), None)
    };

    // cwd 消失恢复：白名单校验通过后，若 cwd 已不在磁盘（如上一命令 rm -rf 了它），
    // 回退到第一个存在的 allowed_root 再继续（对齐 Claude Code 的 cwd 恢复），避免每次硬报错。
    // 回退目标仍在白名单内，不削弱安全围栏。
    let resolved_cwd = if !resolved_cwd.exists() {
        allowed_roots
            .iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.exists())
            .unwrap_or(resolved_cwd)
    } else {
        resolved_cwd
    };

    if !resolved_cwd.is_dir() {
        return Err(format!("cwd 不是一个目录: {}", resolved_cwd.display()));
    }
    let max_output_bytes = args.max_output_bytes.max(1);
    // 壳层类型（cmd/bash）与是否追踪命令结束后的有效 cwd（= 会话内）。
    // track_cwd 仅当存在有效 session_id 时为 true——所有新行为都藏在会话后，
    // 默认关 / 无会话时命令原样透传，现有测试零回归。
    let shell = parse_shell_type(&config.shell_type);
    let track_cwd = effective_session_id.is_some();
    drop(config);

    if args.background && state.running_commands.len() >= MAX_CONCURRENT_BACKGROUND {
        // 修复：先尝试把已结束的命令腾出去（不用等 5 分钟宽限期，这里优先保新命令能启动），
        // 真正 5 个都还在跑时才拒绝。
        state.evict_finished_commands().await;
    }
    if args.background && state.running_commands.len() >= MAX_CONCURRENT_BACKGROUND {
        return Err(format!(
            "后台命令数已达上限（{MAX_CONCURRENT_BACKGROUND}），请先用 stop_command 结束一些再试。"
        ));
    }

    let command = args.command;
    let background = args.background;
    let timeout_ms = args.timeout_ms;
    let description = args.description;
    if let Some(desc) = &description {
        log::info!(target: "mcp::run_command", "run_command(description={}): {}", desc, command);
    }
    let state = state.clone();

    // 会话级环境变量持久化：收集 session 既有 env_overrides，并合并本次传入的 env 写回 session。
    // 注入子进程时不绕过白名单（仅环境变量，与路径无关）；cwd 仍每次重校验（规则 7 不削弱）。
    let mut session_env: Vec<(String, String)> = Vec::new();
    if let Some(sid) = &effective_session_id {
        if let Some(s) = state.cwd_sessions.get(sid) {
            for (k, v) in &s.env_overrides {
                session_env.push((k.clone(), v.clone()));
            }
        }
        if let Some(env) = &args.env {
            if let Some(mut s) = state.cwd_sessions.get_mut(sid) {
                for e in env {
                    s.env_overrides.insert(e.key.clone(), e.value.clone());
                }
            }
            for e in env {
                session_env.push((e.key.clone(), e.value.clone()));
            }
        }
    }

    // spawn + wait 是同步阻塞 API，丢进 spawn_blocking 避免占用 tokio 工作线程。
    // resolved_cwd 需同时给 spawn_shell（移动进闭包）与 inject_session_info（回显 cwd），
    // 故先 clone 一份供闭包使用，原值留给末尾回显。
    let resolved_cwd_spawn = resolved_cwd.clone();
    let state_for_blocking = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        spawn_shell(
            &command,
            &resolved_cwd_spawn,
            cwd_display,
            background,
            timeout_ms,
            max_output_bytes,
            description,
            &state_for_blocking,
            shell,
            track_cwd,
            session_env,
            notify_command_complete,
        )
    })
    .await
    .map_err(|e| format!("run_command 任务 panic: {e}"))?;
    // result: Result<(Value, Option<PathBuf>), String> —— 第二个元素是命令结束后的有效 cwd（仅 track_cwd 时 Some）。
    let (mut value, effective_new_cwd) = result?;

    // 会话内 cwd 持久化：把命令结束后的有效 cwd 回写 session。
    // 关键：回写前用 resolve_safe_path 重校验白名单（规则 7 不削弱）——
    // 命令内 `cd` 到白名单外也不会污染 session。
    if track_cwd {
        if let (Some(sid), Some(new_cwd)) = (&effective_session_id, effective_new_cwd) {
            let cfg = state.config.read().await;
            if let Some(new_cwd_str) = new_cwd.to_str() {
                if let Ok(resolved) = security::path::resolve_safe_path(
                    new_cwd_str,
                    &cfg.allowed_roots,
                    cfg.whitelist_enabled,
                ) {
                    if let Some(mut s) = state.cwd_sessions.get_mut(sid) {
                        s.cwd = resolved;
                        s.last_active = Instant::now();
                    }
                }
            }
        }
    }

    // 回声当前壳层，使已连会话无需重连即能从工具返回中获知当前 shell_type，
    // 自动将后续命令语法从 cmd 纠正为 bash（或反之）。
    if let Some(obj) = value.as_object_mut() {
        obj.insert("shell".into(), json!(shell.as_str()));
    }

    inject_session_info(Ok(value), effective_session_id, &resolved_cwd)
}

#[allow(clippy::too_many_arguments)]
fn spawn_shell(
    command: &str,
    resolved_cwd: &std::path::Path,
    cwd_display: String,
    background: bool,
    timeout_ms: u64,
    max_output_bytes: usize,
    description: Option<String>,
    state: &Arc<AppState>,
    shell: ShellType,
    track_cwd: bool,
    extra_env: Vec<(String, String)>,
    notify_command_complete: bool,
) -> Result<(Value, Option<PathBuf>), String> {
    // 用 process-wrap 的 StdCommandWrap 组合包装（Windows 实测结论，见复现测试）：
    // - 关键陷阱：JobObject 的 pre_spawn 会重设 creation_flags 为 CREATE_SUSPENDED（且不合并
    //   CreationFlags）。因此必须【先 wrap(JobObject) 再 wrap(CreationFlags)】，让 CreationFlags
    //   最后写入、压住 JobObject 的重设；否则 CREATE_NO_WINDOW 被冲掉 → 弹黑窗口。
    // - 注意：CreationFlags 里【不要】带 CREATE_SUSPENDED。JobObject 的 wrap_child 会检测
    //   CreationFlags 是否含 SUSPENDED，若含则跳过 resume_threads，导致子进程永久挂起、无输出
    //   （即 background_registers_with_handle 测试失败）。不含 SUSPENDED 时 JobObject 正常
    //   resume，整树 kill（start_kill → terminate_job）依旧有效，仅丢失 spawn→assign job 的
    //   极小竞态窗口（可接受，claude-code 等亦不依赖此保护）。
    // 壳层（cmd/bash）由 build_invocation 决定；进程管道封装（flags / JobObject / stdin null /
    // piped / current_dir）shell 无关，一行不动。
    let inv =
        match build_invocation(shell, command, resolved_cwd, track_cwd) {
            Some(inv) => inv,
            None => return Err(
                "bash 不可用：未检测到 Git for Windows 的 bash.exe。请将配置 shell_type 改回 cmd，\
                 或在本地安装 Git for Windows 后重试。"
                    .to_string(),
            ),
        };
    let mut cmd = StdCommandWrap::with_new(inv.program.as_str(), |c| {
        c.args(&inv.args);
        // 修复：显式给 stdin 一个空句柄。cc-bridge 本身是 GUI 子系统程序，没有控制台、
        // 也就没有可继承的有效 stdin 句柄。若不显式设置（默认继承父进程句柄），
        // 子进程拿到无效句柄后会尝试自己申请一个控制台兼底，这会瞬时击穿
        // CREATE_NO_WINDOW 的抑制效果，表现为一闪而过的空白黑窗。
        c.stdin(Stdio::null());
        c.stdout(Stdio::piped());
        c.stderr(Stdio::piped());
        c.current_dir(resolved_cwd);
        for (k, v) in &inv.env_extra {
            c.env(k, v);
        }
        for (k, v) in &extra_env {
            c.env(k, v);
        }
    });
    // 顺序敏感：先 JobObject 再 CreationFlags，确保 CREATE_NO_WINDOW 不被 JobObject 覆盖。
    cmd.wrap(JobObject);
    cmd.wrap(CreationFlags(PROCESS_CREATION_FLAGS(
        CREATE_NO_WINDOW.0 | CREATE_NEW_PROCESS_GROUP.0,
    )));

    let child = cmd.spawn().map_err(|e| format!("启动命令失败: {e}"))?;

    if background {
        spawn_background(
            child,
            max_output_bytes,
            command.to_string(),
            cwd_display,
            description,
            state,
            notify_command_complete,
        )
        .map(|v| (v, None))
    } else {
        run_foreground(
            child,
            timeout_ms,
            max_output_bytes,
            track_cwd,
            inv.cwd_capture_file.as_deref(),
        )
    }
}

/// 起一个专门的 OS 线程持续读取管道输出（Read trait 是同步阻塞的，不能直接 await）。
/// 累积缓冲区用 tokio::sync::Mutex 以便复用 get_command_output.rs 的 `.lock().await` 路径。
fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    max_output_bytes: usize,
) -> (Arc<AsyncMutex<Vec<u8>>>, Arc<AtomicBool>, Arc<AtomicBool>) {
    let buf = Arc::new(AsyncMutex::new(Vec::<u8>::new()));
    let truncated = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let buf_clone = buf.clone();
    let truncated_clone = truncated.clone();
    let done_clone = done.clone();
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
        done_clone.store(true, Ordering::Relaxed);
    });
    (buf, truncated, done)
}

fn take_reader(
    pipe: Option<impl Read + Send + 'static>,
    max_output_bytes: usize,
) -> (Arc<AsyncMutex<Vec<u8>>>, Arc<AtomicBool>, Arc<AtomicBool>) {
    match pipe {
        Some(s) => spawn_reader_thread(Box::new(s), max_output_bytes),
        None => (
            Arc::new(AsyncMutex::new(Vec::new())),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        ),
    }
}

/// 读取 cwd 捕获文件，规整为 Rust/Windows 可用的 PathBuf。
/// 文件不存在（命令提前失败未写）或读失败时返回 None —— 调用方据此不更新 session cwd。
fn read_cwd_file(cwd_file: Option<&std::path::Path>) -> Option<PathBuf> {
    let f = cwd_file?;
    let result = match std::fs::read_to_string(f) {
        Ok(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(normalize_cwd_from_shell(trimmed))
            }
        }
        Err(_) => None,
    };
    // 读完即删除临时 cwd 捕获文件（best-effort），避免会话 cwd 捕获文件在 temp 目录长期累积泄漏。
    let _ = std::fs::remove_file(f);
    result
}

fn run_foreground(
    mut child: Box<dyn StdChildWrapper>,
    timeout_ms: u64,
    max_output_bytes: usize,
    track_cwd: bool,
    cwd_file: Option<&std::path::Path>,
) -> Result<(Value, Option<PathBuf>), String> {
    let (stdout_buf, stdout_trunc, stdout_done) =
        take_reader(child.stdout().take(), max_output_bytes);
    let (stderr_buf, stderr_trunc, stderr_done) =
        take_reader(child.stderr().take(), max_output_bytes);

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
            // 命令已正常结束，drop child 顺带关闭 Job 句柄（无害）。
            // 等待读取线程把管道剩余数据读完（子进程退出 → write 端关闭 → reader 读到 EOF
            // 才置 done）。取代原硬编码 50ms 睡眠：高负载并行测试下 50ms 不足以让 reader
            // 线程被调度，会丢输出（description_field 测试偶发 stdout 空的根因）。
            drop(child);
            let mut spins = 0;
            while (!stdout_done.load(Ordering::Relaxed) || !stderr_done.load(Ordering::Relaxed))
                && spins < 500
            {
                std::thread::sleep(Duration::from_millis(2));
                spins += 1;
            }
            let stdout = stdout_buf.blocking_lock().clone();
            let stderr = stderr_buf.blocking_lock().clone();
            // 会话内：读回命令结束后的有效 cwd（bash 经 `pwd -W` 写 Windows 风格路径，规整回
            // 原生 PathBuf；cmd 经 `cd` 写原生路径）。文件不存在说明命令提前失败，None（不更新）。
            let effective_cwd = if track_cwd {
                read_cwd_file(cwd_file)
            } else {
                None
            };
            Ok((
                text_result(json!({
                    "stdout": String::from_utf8_lossy(&stdout),
                    "stderr": String::from_utf8_lossy(&stderr),
                    "exitCode": status.code(),
                    "stdoutTruncated": stdout_trunc.load(Ordering::Relaxed),
                    "stderrTruncated": stderr_trunc.load(Ordering::Relaxed),
                    "timedOut": false,
                })),
                effective_cwd,
            ))
        }
        None => {
            // 超时：必须用 start_kill()（TerminateJobObject）杀整树，
            // 不能只 kill() cmd 本体——否则 git/cargo 等孙进程会变孤儿进程。
            let _ = child.start_kill();
            Ok((
                text_result(json!({
                    "stdout": "",
                    "stderr": "",
                    "exitCode": Value::Null,
                    "stdoutTruncated": false,
                    "stderrTruncated": false,
                    "timedOut": true,
                    "note": format!("命令超过 {timeout_ms}ms 未结束，已强制终止（含子进程）"),
                })),
                None,
            ))
        }
    }
}

#[allow(clippy::too_many_arguments)]
#[cfg_attr(test, allow(unused_variables))]
fn spawn_background(
    mut child: Box<dyn StdChildWrapper>,
    max_output_bytes: usize,
    command: String,
    cwd: String,
    description: Option<String>,
    state: &Arc<AppState>,
    notify_command_complete: bool,
) -> Result<Value, String> {
    let (stdout_buf, stdout_trunc, _stdout_done) =
        take_reader(child.stdout().take(), max_output_bytes);
    let (stderr_buf, stderr_trunc, _stderr_done) =
        take_reader(child.stderr().take(), max_output_bytes);

    let pid = child.id();
    let started_at = Instant::now();
    // 后台任务的 wait 线程与 stop_command 共享同一份 child（Arc<Mutex>）：
    // wait 线程持有它调 wait() 更新 exit_code；stop_command 持有它调 start_kill() 杀整树。
    let child = Arc::new(StdMutex::new(child));
    let child_for_wait = child.clone();
    let exit_code: Arc<AsyncMutex<Option<i32>>> = Arc::new(AsyncMutex::new(None));
    let exit_code_clone = exit_code.clone();
    // 修复：进程结束时同步定格“已运行秒数”，避免面板在进程早已退出后还用 started_at.elapsed() 实时计算，导致时长一直增长。
    let finished_elapsed: Arc<AsyncMutex<Option<u64>>> = Arc::new(AsyncMutex::new(None));
    let finished_elapsed_clone = finished_elapsed.clone();
    // 后台命令完成通知：在 spawn 线程前提取 AppHandle（StdMutex，同步安全）。
    // 开关标志 notify_command_complete 由调用方（handle）在 async 上下文读出后传入。
    // test profile 下 app_handle 字段不存在（state.rs 用 #[cfg(not(test))] 剔除），
    // 对应变量也不编译。
    #[cfg(not(test))]
    let app_handle = state.app_handle.lock().unwrap().clone();
    #[cfg(not(test))]
    let notify_cmd = command.clone();

    // H4 修复：改用 try_wait 轮询，wait 线程不在整个进程生命周期内持锁。
    // 旧实现 c.wait() 期间独占 child 锁，导致 stop_command 的 start_kill 抢不到锁、
    // 永远杀不掉运行中的后台进程。现每次只在 try_wait 瞬间短暂持锁，其余时间释放，
    // 让 stop_command 能在进程运行期拿到锁执行 start_kill。
    std::thread::spawn(move || loop {
        let status = {
            let mut c = child_for_wait.lock().unwrap();
            match c.try_wait() {
                Ok(Some(s)) => Some(s),
                Ok(None) => None,
                Err(_) => break,
            }
        };
        match status {
            Some(s) => {
                let elapsed_secs = started_at.elapsed().as_secs();
                let code = s.code();
                *exit_code_clone.blocking_lock() = code;
                *finished_elapsed_clone.blocking_lock() = Some(elapsed_secs);
                // 后台命令完成通知（test profile 下不链接 notification 插件，避免 0xc0000139）
                #[cfg(not(test))]
                if notify_command_complete {
                    if let Some(ref h) = app_handle {
                        use tauri_plugin_notification::NotificationExt;
                        let body = match code {
                            Some(0) => format!("{} 已完成（退出码 0）", notify_cmd),
                            Some(c) => format!("{} 已结束（退出码 {}）", notify_cmd, c),
                            None => format!("{} 已结束（无退出码）", notify_cmd),
                        };
                        let _ = h
                            .notification()
                            .builder()
                            .title("后台命令完成")
                            .body(&body)
                            .show();
                    }
                }
                break;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    });

    let handle_id = format!("cmd_{:016x}", rand::random::<u64>());
    state.running_commands.insert(
        handle_id.clone(),
        RunningCommand {
            pid,
            command,
            cwd,
            description,
            child,
            stdout: stdout_buf,
            stderr: stderr_buf,
            stdout_truncated: stdout_trunc,
            stderr_truncated: stderr_trunc,
            exit_code,
            started_at,
            finished_elapsed_secs: finished_elapsed,
        },
    );

    Ok(text_result(json!({ "handle": handle_id, "pid": pid })))
}

fn text_result(info: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&info).unwrap() }]
    })
}

/// 把会话 id 与本次生效 cwd 注入 run_command 返回的 JSON 文本
/// （`content[0].text` 是一段 JSON 字符串）。仅成功路径调用——错误响应结构不同，不注入。
fn inject_session_info(
    result: Result<Value, String>,
    session_id: Option<String>,
    resolved_cwd: &std::path::Path,
) -> Result<Value, String> {
    let mut v = result?;
    if let Some(obj) = v.as_object_mut() {
        if let Some(arr) = obj.get_mut("content").and_then(|c| c.as_array_mut()) {
            if let Some(first) = arr.first_mut() {
                if let Some(text) = first.get_mut("text").and_then(|t| t.as_str()) {
                    if let Ok(mut info) = serde_json::from_str::<serde_json::Value>(text) {
                        // 仅当确有 session 时才注入 sessionId / cwd 回显字段。
                        // 默认关（session_id = None）时不做任何注入，响应与原版完全一致，
                        // 满足「零行为变化」要求（不在 JSON 里留下 null 占位）。
                        if let Some(sid) = session_id {
                            info["sessionId"] = json!(sid);
                            info["cwd"] = json!(resolved_cwd.to_string_lossy().to_string());
                            let new_text = serde_json::to_string_pretty(&info)
                                .unwrap_or_else(|_| text.to_string());
                            first["text"] = json!(new_text);
                        }
                    }
                }
            }
        }
    }
    Ok(v)
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
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
                description: None,
                env: None,
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
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
                description: None,
                env: None,
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
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
                description: None,
                env: None,
            },
            &state,
        )
        .await;
        assert!(result.is_err(), "大写危险命令也应被拦截");
        assert!(state.running_commands.is_empty());
    }

    /// 正常命令不误拦、毁灭性命令拦住——策略判定的冒烟用例（详尽用例见 command_policy 模块测试）。
    #[test]
    fn benign_command_not_blocked_by_dangerous_filter() {
        use crate::mcp::tools::command_policy::validate_command_policy;
        use crate::mcp::tools::shell::ShellType;
        let ok = |c: &str| validate_command_policy(c, ShellType::Bash, None).is_ok();
        assert!(ok("cargo build --release"));
        assert!(ok("git status"));
        assert!(ok("rm -rf ./build")); // 相对路径不视为毁灭性
        assert!(!ok("rm -rf /"));
        assert!(!ok("sudo mkfs /dev/sdb"));
    }

    /// Layer 2 配置接线（④P0-1）：开启命令白名单后，未列入白名单的程序被拦截，
    /// 白名单内的良性命令放行；且 Layer 1（破坏性检测）不被白名单绕过。
    #[tokio::test]
    async fn layer2_allowlist_enforced_through_config() {
        // 1) 仅 echo 在白名单内：git（良性）应被 Layer 2 拦截；echo 放行。
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.command_allowlist_enabled = true;
            c.command_allowlist = vec!["echo".to_string()];
        });
        let cwd = Some(dir.to_string_lossy().into_owned());

        let blocked = handle(
            RunCommandArgs {
                command: "git status".into(),
                cwd: cwd.clone(),
                session_id: None,
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
                description: None,
                env: None,
            },
            &state,
        )
        .await;
        let err = blocked.expect_err("git 不在白名单内必须 Err");
        assert!(err.contains("白名单"), "应报白名单拦截，实际：{err}");

        let allowed = handle(
            RunCommandArgs {
                command: "echo hello".into(),
                cwd: cwd.clone(),
                session_id: None,
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
                description: None,
                env: None,
            },
            &state,
        )
        .await;
        assert!(allowed.is_ok(), "echo 在白名单内应放行");

        // 2) Layer 1 不被白名单绕过：即使把 rm 放进白名单，指向系统目录的 rm -rf 仍被拦。
        let (state2, dir2) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.command_allowlist_enabled = true;
            c.command_allowlist = vec!["rm".to_string()];
        });
        let destructive = handle(
            RunCommandArgs {
                command: "rm -rf C:\\Windows".into(),
                cwd: Some(dir2.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
                description: None,
                env: None,
            },
            &state2,
        )
        .await;
        let derr = destructive.expect_err("rm -rf C:\\Windows 必须被 Layer 1 拦截");
        assert!(
            !derr.contains("白名单"),
            "不应因白名单放行而绕过 Layer 1，实际：{derr}"
        );
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
                cwd: Some(forbidden.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
                description: None,
                env: None,
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
                cwd: Some(file_path.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 1000,
                max_output_bytes: 1024,
                description: None,
                env: None,
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
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
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
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
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
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
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
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 10,
                description: None,
                env: None,
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
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
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
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: true,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
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

    /// description 字段是纯透传：带 description 的 foreground 命令应正常执行，不被该字段影响。
    /// 回归护栏——确保新增的可选字段不会干扰既有执行路径（不进入白名单/危险命令判定）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn description_field_does_not_affect_execution() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let v = handle(
            RunCommandArgs {
                command: "echo hello_with_desc".into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: Some("a deploy step".into()),
                env: None,
            },
            &state,
        )
        .await
        .expect("foreground with description should succeed");
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
            stdout.contains("hello_with_desc"),
            "stdout 应含内容，实际：{stdout:?}"
        );
    }

    /// 会话级 cwd 持久化：第一次带 cwd 创建 session，返回的 JSON 应含 sessionId 与 cwd；
    /// 第二次仅带该 sessionId（不带 cwd）应能复用同一工作目录执行命令。
    /// 覆盖 RFC 测试点：create session → reuse cwd。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn session_cwd_created_and_reused() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            c.session_cwd_enabled = true;
        });

        // 第一次：带 cwd，创建会话。
        let v1 = handle(
            RunCommandArgs {
                command: "echo from_session".into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("第一次 run_command 应成功并创建 session");

        let text1 = v1
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .expect("response must have text payload");
        let info1: serde_json::Value = serde_json::from_str(text1).expect("text payload is JSON");
        let session_id = info1
            .get("sessionId")
            .and_then(|s| s.as_str())
            .expect("开启会话持久化时必须回显 sessionId")
            .to_string();
        assert!(session_id.starts_with("cwd_"), "sessionId 应以 cwd_ 前缀");
        // cwd 也应回显，供客户端在工具描述里引导。
        // 注意：resolve_safe_path 会 canonicalize，Windows 下产出 `\\?\` 前缀的 verbatim 路径，
        // 故与原始 dir 比较需用 canonicalize 后的形式。
        let canon = std::fs::canonicalize(&dir).expect("canonicalize dir");
        assert_eq!(
            info1.get("cwd").and_then(|s| s.as_str()),
            Some(canon.to_string_lossy().as_ref()),
            "回显 cwd 应与 canonicalize 后的请求一致"
        );
        assert!(state.cwd_sessions.contains_key(&session_id));

        // 第二次：仅带 sessionId，不带 cwd，应复用同一目录。
        let v2 = handle(
            RunCommandArgs {
                command: "echo reused_session".into(),
                cwd: None,
                session_id: Some(session_id.clone()),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("复用 session 时不应要求 cwd");
        let text2 = v2
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .expect("response must have text payload");
        let info2: serde_json::Value = serde_json::from_str(text2).expect("text payload is JSON");
        let stdout = info2.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(
            stdout.contains("reused_session"),
            "复用 session 的命令应正常执行，实际：{stdout:?}"
        );
        // 复用后 session 仍是同一个 key。
        assert!(state.cwd_sessions.contains_key(&session_id));
    }

    /// 会话绑定的 cwd 若已移出白名单，下次使用时必须被拒绝（每条 use 重校验）。
    /// 覆盖 RFC 测试点：whitelist rejection on session cwd —— 规则 7 红线不削弱。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn session_cwd_revalidates_whitelist() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            c.session_cwd_enabled = true;
        });

        // 先创建 session。
        let v1 = handle(
            RunCommandArgs {
                command: "echo ok".into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("创建 session 应成功");
        let text1 = v1
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .expect("response must have text payload");
        let info1: serde_json::Value = serde_json::from_str(text1).expect("text payload is JSON");
        let session_id = info1
            .get("sessionId")
            .and_then(|s| s.as_str())
            .expect("应回显 sessionId")
            .to_string();

        // 收紧白名单，使其不再包含 session 绑定的目录。
        state.config.write().await.allowed_roots.clear();
        // 同步刷新白名单缓存，否则缓存仍含被清掉的目录，后续校验会误放行。
        state.refresh_canonicalized_roots(&state.config.read().await.allowed_roots);

        // 复用 session —— 绑定的 cwd 已不在白名单，必须拒绝。
        let result = handle(
            RunCommandArgs {
                command: "echo should_fail".into(),
                cwd: None,
                session_id: Some(session_id),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await;
        let err = result.expect_err("session cwd 已出白名单必须 Err");
        assert!(
            err.contains("白名单") || err.contains("不在白名单"),
            "应提示 cwd 不在白名单，实际：{err}"
        );
    }

    /// 提供不存在/无效的 session_id 必须明确报错，且不应静默创建新会话。
    /// 覆盖 RFC 测试点：expired/unknown session error。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unknown_session_id_rejected() {
        let (state, _dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            c.session_cwd_enabled = true;
        });
        let before = state.cwd_sessions.len();
        let result = handle(
            RunCommandArgs {
                command: "echo nope".into(),
                cwd: None,
                session_id: Some("cwd_does_not_exist_0000000000000000".into()),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await;
        let err = result.expect_err("未知 sessionId 必须 Err");
        assert!(
            err.contains("不存在") || err.contains("过期"),
            "应提示 session 不存在或过期，实际：{err}"
        );
        // 不应因带未知 id 而自动新建会话。
        assert_eq!(
            state.cwd_sessions.len(),
            before,
            "未知 sessionId 不应静默创建新会话"
        );
    }

    /// 开关关闭时：等效旧行为——cwd 必传，且不回显 sessionId；
    /// 即便传入 sessionId 也被忽略（不创建、不报错、不持久化）。
    /// 覆盖 RFC 测试点：default-off regression —— 零行为变化。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn default_off_ignores_session_id() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            c.session_cwd_enabled = false; // 默认关
        });
        let v = handle(
            RunCommandArgs {
                command: "echo default_off".into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: Some("cwd_ignored".into()), // 即便传了也不应生效
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("默认关时带 sessionId 不应报错，行为与旧版一致");
        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .expect("response must have text payload");
        let info: serde_json::Value = serde_json::from_str(text).expect("text payload is JSON");
        // 默认关时不回显 sessionId。
        assert!(
            info.get("sessionId").is_none(),
            "默认关时不应回显 sessionId"
        );
        // 且不应持久化任何会话。
        assert!(
            state.cwd_sessions.is_empty(),
            "默认关时不应创建 cwd 会话，避免行为变化"
        );
        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(stdout.contains("default_off"), "命令应正常执行");
    }

    /// 测试辅助：从 run_command 返回的 Value（content[0].text 是 JSON 字符串）解析出内层 JSON。
    fn parse_response_text(v: &serde_json::Value) -> serde_json::Value {
        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .expect("response must have text payload");
        serde_json::from_str(text).expect("text payload is JSON")
    }

    /// bash 模式基础回归：shell_type=bash 时 `echo` 正常返回 stdout。
    /// 本机无 Git Bash 时跳过（不 fail）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bash_echo_returns_stdout() {
        if crate::mcp::tools::shell::detect_bash_exe().is_none() {
            eprintln!("skip bash_echo_returns_stdout: 未检测到 Git Bash");
            return;
        }
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            c.shell_type = "bash".into();
        });
        let v = handle(
            RunCommandArgs {
                command: "echo hello_bash".into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("bash echo should succeed");
        let info = parse_response_text(&v);
        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(
            stdout.contains("hello_bash"),
            "bash stdout 应含 hello_bash，实际：{stdout:?}"
        );
        assert_eq!(info.get("exitCode").and_then(|e| e.as_i64()), Some(0));
    }

    /// bash 会话内 cwd 持久化：第一次 `cd subdir && pwd` 后，第二次仅带 session_id 的 `pwd`
    /// 应输出 subdir —— 验证命令内 `cd` 跨调用持久化（pwd 文件法 + 白名单重校验后回写 session）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bash_session_cwd_persists() {
        if crate::mcp::tools::shell::detect_bash_exe().is_none() {
            eprintln!("skip bash_session_cwd_persists: 未检测到 Git Bash");
            return;
        }
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            c.session_cwd_enabled = true;
            c.shell_type = "bash".into();
        });
        let sub = dir.join("subdir");
        std::fs::create_dir_all(&sub).expect("create subdir");
        // 第一次：带 cwd，cd 进 subdir，创建 session。
        let v1 = handle(
            RunCommandArgs {
                command: "cd subdir && pwd".into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("第一次 run_command 应成功");
        let info1 = parse_response_text(&v1);
        let session_id = info1
            .get("sessionId")
            .and_then(|s| s.as_str())
            .expect("开启会话持久化必须回显 sessionId")
            .to_string();
        // 第二次：仅带 session_id，pwd 应输出 subdir（cd 持久化）。
        let v2 = handle(
            RunCommandArgs {
                command: "pwd".into(),
                cwd: None,
                session_id: Some(session_id),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("复用 session 应成功");
        let info2 = parse_response_text(&v2);
        let stdout = info2.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(
            stdout.contains("subdir"),
            "cwd 应持久化到 subdir，实际：{stdout:?}"
        );
    }

    /// bash 会话内 `cd` 到白名单外目录后，session cwd 不应被更新（回写前重校验白名单生效）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bash_cwd_persistence_rejected_when_outside_whitelist() {
        if crate::mcp::tools::shell::detect_bash_exe().is_none() {
            eprintln!(
                "skip bash_cwd_persistence_rejected_when_outside_whitelist: 未检测到 Git Bash"
            );
            return;
        }
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            c.session_cwd_enabled = true;
            c.shell_type = "bash".into();
        });
        // 创建 session（cwd=dir）。
        let v1 = handle(
            RunCommandArgs {
                command: "echo ok".into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("创建 session 应成功");
        let info1 = parse_response_text(&v1);
        let session_id = info1
            .get("sessionId")
            .and_then(|s| s.as_str())
            .expect("应回显 sessionId")
            .to_string();
        // cd 到一个存在但白名单外的目录（系统 temp）。用 POSIX 路径传给 bash。
        let outside = std::env::temp_dir();
        let posix = crate::mcp::tools::shell::windows_to_posix(&outside);
        let _ = handle(
            RunCommandArgs {
                command: format!("cd {posix} && pwd"),
                cwd: None,
                session_id: Some(session_id.clone()),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("cd 到白名单外不应报错（命令本身能跑）");
        // session cwd 必须仍是原 dir（越界路径回写被白名单拒绝）。
        // session.cwd 来自 resolve_safe_path 的 canonicalize，带 `\\?\` 前缀；dir 是测试原始路径，
        // 故比较前把 dir 也 canonicalize 对齐（Windows 上 canonicalize 返回 `\\?\` 形式）。
        let session = state.cwd_sessions.get(&session_id).expect("session 应存在");
        let expected = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        assert_eq!(
            session.cwd, expected,
            "session cwd 不应被更新为白名单外路径"
        );
    }
}
