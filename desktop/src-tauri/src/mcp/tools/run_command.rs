use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use crate::mcp::tools::command_policy::validate_command_policy;
use crate::mcp::tools::output_clip::{fit_result, Capture, FitOpts};
use crate::mcp::tools::output_filter::OutputFilter;
use crate::mcp::tools::shell::{
    build_invocation, normalize_cwd_from_shell, parse_shell_type, ShellType,
};
use crate::mcp::tools::text_result;

// 这两个是跨平台的 trait，两边都要。
use process_wrap::std::{StdChildWrapper, StdCommandWrap};
// 以下均为平台专属的“怎么管进程树”实现：
// Windows 靠 JobObject（容器）+ CreationFlags（不弹控制台窗口）；
// Unix 靠进程组（setpgid 后对整组发信号），也不存在“黑窗口”问题。
#[cfg(unix)]
use process_wrap::std::ProcessGroup;
#[cfg(windows)]
use process_wrap::std::{CreationFlags, JobObject};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, PROCESS_CREATION_FLAGS,
};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::security;
use crate::state::{AppState, CwdSession, RunningCommand};

// 子进程创建标志的选型理由（实际使用处见下方 spawn 点：
// `CREATE_NO_WINDOW.0 | CREATE_NEW_PROCESS_GROUP.0`）。
// 注：这段原本是 `SPAWN_FLAGS` 常量的文档，常量改成内联后注释成了孤儿并错挂到
// 下面的 `default_timeout_ms` 上，故降为普通注释。
// - `CREATE_NO_WINDOW (0x08000000)`：不创建可见控制台窗口，输出走管道（Stdio::piped）。
//   相比 `DETACHED_PROCESS`，真实 .exe 子进程（git/cargo/npm）的 stdout/stderr 能被正确
//   捕获（DETACHED_PROCESS 下孙进程控制台输出会丢失）；相比 ConPTY（portable-pty），
//   不需要终端模拟器回应控制序列握手，cmd.exe 不会卡在 DSR 查询。
// - `CREATE_NEW_PROCESS_GROUP (0x00000200)`：把 cmd 及其子孙放进独立进程组，隔离控制台
//   事件广播，缓解 MSVC 并发链接时偶发的 STATUS_CONTROL_C_EXIT 崩溃
//   （仅当远程用本工具自构建 cc-bridge 本体时可能触发，构建用户自己的项目无此问题）。

/// 前台命令默认超时。
///
/// 从 30s 提到 120s：按审计日志 1281 次真实调用统计，**141 次（11%）撞到 30s 超时**，
/// 而 p50 只有 1125ms——也就是说绝大多数命令很快，但构建类（cargo build / npm run build）
/// 被成批截断。120s 能覆盖绝大多数增量构建；真正的长任务应该用 `background: true`，
/// 而不是把超时改成无限大（否则客户端侧会先超时，反而拿不到任何输出）。
fn default_timeout_ms() -> u64 {
    120_000
}

/// 单次返回的默认上限，单位是**序列化后的 UTF-8 字节**（不是「每路捕获多少」）。
///
/// 32KB 的依据：客户端对单次 MCP 结果的序列化文本超过约 5 万字符就**整条落盘**、对话里
/// 只给前 2KB 预览（实测 49,823 字符原样内联；52,116 字节只剩 2,373 字符）。32KB 换算
/// 下来英文约 3.2 万字符、中文约 1.1 万字符，两种都留有余量。
/// 而旧的 1MB 上限在历史 833 次调用里**一次都没触发过**——它既不省也不防。
fn default_max_output_bytes() -> usize {
    crate::mcp::tools::output_clip::DEFAULT_RETURN_LIMIT
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
    /// 本次**返回正文**的上限，单位是序列化后的 UTF-8 字节：默认 32KB，封顶 45KB。
    ///
    /// 超出时只给头 1/8 + 尾 7/8（中段省略并摘出关键行），完整输出可用返回的 `handle`
    /// 配 `get_command_output` 翻页取回。**旧语义是「每路捕获多少字节」，已废弃**——
    /// 捕获缓冲的大小不再由调用方控制（后端固定约 1MB，保头 1/8 + 真尾 7/8）。
    #[serde(default = "default_max_output_bytes", rename = "maxOutputBytes")]
    pub max_output_bytes: usize,
    /// 环境变量（key=value 映射）。**本次调用总是生效**（与会话开关无关）；
    /// 仅当 session_cwd_enabled 开启且有效 session_id（或新建会话）时才额外跨调用持久：
    /// 首次随 cwd 设立会话时作为初始 env，后续调用与既有 env_overrides 合并（后写覆盖）。
    /// 旧版在开关关闭时把 env 整个丢掉且不报错，传密钥会静默发出空凭证。
    /// 注意：无法自动捕获 shell 内 `source` 激活的虚拟环境（每次起重壳激活即
    /// 丢失），请用 env 显式持久化 VIRTUAL_ENV / PATH 等。
    #[serde(default, rename = "env")]
    pub env: Option<Vec<EnvEntry>>,
    /// 人类可读描述，用于权限 UX / 审计日志（对标 native Claude Code 的 description 字段）。
    /// 不参与执行逻辑，仅作记录；缺省为 None。
    #[serde(default)]
    pub description: Option<String>,
    /// 可选：只保留匹配该正则的 stdout/stderr 行（服务端过滤，被剔除的行只报数量）。
    #[serde(default)]
    pub include: Option<String>,
    /// 可选：剔除匹配该正则的行。
    #[serde(default)]
    pub exclude: Option<String>,
    /// 可选：只返回末尾 N 行（先过滤再截尾）。省略即不截尾。
    #[serde(default, rename = "tailLines")]
    pub tail_lines: Option<usize>,
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
    // B 类容错标记：cwd 未传或已消失而回退到 allowed_root 时置位，
    // 响应里注入 cwdFallback + 实际 cwd，让模型知道自己在哪跑的（审计可对照）。
    let mut cwd_fallback = false;
    // 开关关闭却传了 sessionId：照旧忽略，但在响应里明说，免得模型以为 cwd 会被记住。
    let session_ignored = !config.session_cwd_enabled && args.session_id.is_some();
    let (resolved_cwd, cwd_display, effective_session_id) = if config.session_cwd_enabled {
        if let Some(sid) = &args.session_id {
            match state.cwd_sessions.get(sid) {
                Some(s) => {
                    let resolved = security::path::resolve_safe_path_cached(
                        &s.cwd.to_string_lossy(),
                        &state.cached_roots(),
                        &config.exclude_patterns,
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
                &config.exclude_patterns,
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
        match args.cwd.as_ref() {
            Some(cwd) => {
                let resolved = security::path::resolve_safe_path_cached(
                    cwd,
                    &state.cached_roots(),
                    &config.exclude_patterns,
                    config.whitelist_enabled,
                )?;
                (resolved, cwd.clone(), None)
            }
            None => {
                // B 类容错（审计近 30 天实锤 27 条「cwd 必传」报错）：cwd 缺失时
                // 回退到第一个存在的 allowed_root 继续执行——与下方「cwd 消失恢复」
                // 同一先例（回退目标天然在白名单内，不削弱安全围栏）。
                // 白名单无可用目录时维持原报错，不猜 home 之类的魔法值。
                let fallback = allowed_roots
                    .iter()
                    .map(std::path::PathBuf::from)
                    .find(|p| p.is_dir())
                    .ok_or_else(|| {
                        "cwd 必传（会话持久化未开启时），且白名单中不存在可用目录作为回退"
                            .to_string()
                    })?;
                cwd_fallback = true;
                let display = fallback.to_string_lossy().into_owned();
                (fallback, display, None)
            }
        }
    };

    // cwd 消失恢复：白名单校验通过后，若 cwd 已不在磁盘（如上一命令 rm -rf 了它），
    // 回退到第一个存在的 allowed_root 再继续（对齐 Claude Code 的 cwd 恢复），避免每次硬报错。
    // 回退目标仍在白名单内，不削弱安全围栏。
    let resolved_cwd = if !resolved_cwd.exists() {
        match allowed_roots
            .iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.exists())
        {
            Some(fb) => {
                cwd_fallback = true;
                fb
            }
            None => resolved_cwd,
        }
    } else {
        resolved_cwd
    };

    if !resolved_cwd.is_dir() {
        return Err(format!("cwd 不是一个目录: {}", resolved_cwd.display()));
    }
    let max_output_bytes = args
        .max_output_bytes
        .clamp(1, crate::mcp::tools::output_clip::MAX_RETURN_LIMIT);
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
    // 输出过滤（RFC 十七）：前台输出在**服务端**过滤后再返回，被剔除的行只报数量，
    // 不进上下文——省掉「再跑一次 grep -v」的整轮往返。
    //
    // 后台模式下此刻还没有输出，这三个参数对 run_command 自身无效果；那一路请把
    // 过滤参数传给 `wait_command` / `get_command_output`（工具描述里已写明）。
    let filter = crate::mcp::tools::output_filter::OutputFilter::new(
        args.include.as_deref(),
        args.exclude.as_deref(),
        args.tail_lines,
    )?;
    if let Some(desc) = &description {
        log::info!(target: "mcp::run_command", "run_command(description={}): {}", desc, command);
    }
    let state = state.clone();

    // 环境变量：先叠会话既有 env_overrides，再叠本次传入的 env（后写覆盖）。
    // 本次的 env 无论有无会话都注入；只有在会话内才写回 session 跨调用保留。
    // 注入子进程时不绕过白名单（仅环境变量，与路径无关；命令本身就能 export）；cwd 仍每次重校验。
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
        }
    }
    if let Some(env) = &args.env {
        for e in env {
            session_env.push((e.key.clone(), e.value.clone()));
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
            filter,
        )
    })
    .await
    .map_err(|e| format!("run_command 任务 panic: {e}"))?;
    // result: Result<(Value, Option<PathBuf>), String> —— 第二个元素是命令结束后的有效 cwd（仅 track_cwd 时 Some）。
    let (value, effective_new_cwd) = result?;

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
                    &cfg.exclude_patterns,
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

    // 回声当前壳层由 inject_session_info 一并写进 content[0].text（见该函数注释）。
    inject_session_info(
        Ok(value),
        effective_session_id,
        &resolved_cwd,
        cwd_fallback,
        session_ignored,
        shell,
    )
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
    filter: OutputFilter,
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
    #[cfg(windows)]
    {
        cmd.wrap(JobObject);
        cmd.wrap(CreationFlags(PROCESS_CREATION_FLAGS(
            CREATE_NO_WINDOW.0 | CREATE_NEW_PROCESS_GROUP.0,
        )));
    }
    // Unix 对应物：把子进程设为进程组组长，于是 `start_kill()` 向整组发信号，
    // 连子孙进程一起杀（对应 Windows 的 TerminateJobObject）。
    // 不需要 CREATE_NO_WINDOW 类的处理：Unix 下不会弹控制台窗口。
    #[cfg(unix)]
    cmd.wrap(ProcessGroup::leader());

    let child = cmd.spawn().map_err(|e| format!("启动命令失败: {e}"))?;

    if background {
        spawn_background(
            child,
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
            &filter,
            state,
            command,
            &cwd_display,
            description,
        )
    }
}

/// 起一个专门的 OS 线程持续读取管道输出（Read trait 是同步阻塞的，不能直接 await）。
///
/// 累积缓冲用 [`Capture`]（头 1/8 固定 + 尾 7/8 滚动，约 1MB），不再是「攒满就丢后面」——
/// 后者会把**结尾**丢掉，而构建/测试日志的错误恰恰在结尾。缓冲大小与「返回上限」是两件事：
/// 后台命令的 `untilPattern` / 过滤 / 偏移都要在完整内容上工作，只有进上下文的那一段受
/// 32KB 约束（方案 §3.3 定稿 ①）。
fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
) -> (Arc<AsyncMutex<Capture>>, Arc<AtomicBool>) {
    let buf = Arc::new(AsyncMutex::new(Capture::with_default_cap()));
    let done = Arc::new(AtomicBool::new(false));
    let buf_clone = buf.clone();
    let done_clone = done.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => buf_clone.blocking_lock().push(&chunk[..n]),
                Err(_) => break,
            }
        }
        done_clone.store(true, Ordering::Relaxed);
    });
    (buf, done)
}

fn take_reader(
    pipe: Option<impl Read + Send + 'static>,
) -> (Arc<AsyncMutex<Capture>>, Arc<AtomicBool>) {
    match pipe {
        Some(s) => spawn_reader_thread(Box::new(s)),
        // 没有管道 = 没有待读数据，done 必须一开始就是 true。
        // 若给 false，「输出是否完整」这类判据会永久为假（继承 stdio 的场景）。
        None => (
            Arc::new(AsyncMutex::new(Capture::with_default_cap())),
            Arc::new(AtomicBool::new(true)),
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

/// 前台命令结束时把「输出被裁」的那份保存缓冲登记进注册表，好让模型凭 handle 翻页取回
/// 完整内容（方案 §3.3 定稿 ⑤）。条目按 `command_cleanup_secs`（默认 120s）回收，
/// 名额满时 `evict_finished_commands` 会先清掉它们，不会挡住新的后台命令。
struct FinishCtx<'a> {
    state: &'a Arc<AppState>,
    pid: u32,
    command: &'a str,
    cwd: &'a str,
    description: Option<String>,
    started_at: Instant,
    stdout: &'a Arc<AsyncMutex<Capture>>,
    stderr: &'a Arc<AsyncMutex<Capture>>,
    /// 两路读线程的 EOF 标记，随快照条目一起登记，供 `get_command_output` 判「输出是否完整」。
    stdout_done: &'a Arc<AtomicBool>,
    stderr_done: &'a Arc<AtomicBool>,
}

#[allow(clippy::too_many_arguments)]
fn run_foreground(
    mut child: Box<dyn StdChildWrapper>,
    timeout_ms: u64,
    max_output_bytes: usize,
    track_cwd: bool,
    cwd_file: Option<&std::path::Path>,
    filter: &OutputFilter,
    state: &Arc<AppState>,
    command: &str,
    cwd_display: &str,
    description: Option<String>,
) -> Result<(Value, Option<PathBuf>), String> {
    let pid = child.id();
    let started_at = Instant::now();
    let (stdout_buf, stdout_done) = take_reader(child.stdout().take());
    let (stderr_buf, stderr_done) = take_reader(child.stderr().take());
    let ctx = FinishCtx {
        state,
        pid,
        command,
        cwd: cwd_display,
        description,
        started_at,
        stdout: &stdout_buf,
        stderr: &stderr_buf,
        stdout_done: &stdout_done,
        stderr_done: &stderr_done,
    };

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
            let stdout = stdout_buf.blocking_lock();
            let stderr = stderr_buf.blocking_lock();
            // 会话内：读回命令结束后的有效 cwd（bash 经 `pwd -W` 写 Windows 风格路径，规整回
            // 原生 PathBuf；cmd 经 `cd` 写原生路径）。文件不存在说明命令提前失败，None（不更新）。
            let effective_cwd = if track_cwd {
                read_cwd_file(cwd_file)
            } else {
                None
            };
            let code = status.code();
            Ok((
                register_truncated_output(
                    build_output_result(
                        &stdout,
                        &stderr,
                        json!(code),
                        false,
                        None,
                        filter,
                        max_output_bytes,
                        true,
                    ),
                    &ctx,
                    code,
                    false,
                ),
                effective_cwd,
            ))
        }
        None => {
            // 超时：必须用 start_kill()（TerminateJobObject）杀整树，
            // 不能只 kill() cmd 本体——否则 git/cargo 等孙进程会变孤儿进程。
            let _ = child.start_kill();
            // 超时也要把**已产出的输出还回去**。
            //
            // 旧实现这里硬编码 `"stdout": ""` / `"stderr": ""`，而那两个缓冲里其实已经有
            // reader 线程收到的内容——相当于把已经拿到的诊断信息丢掉。对 cargo build 这类
            // 边跑边吐进度的命令，超时前的输出恰好是最有用的部分（卡在哪一步）。
            // 审计日志显示 11% 的调用走到这条分支，影响面不小。
            //
            // start_kill() 后管道写端关闭，reader 会读到 EOF；给它们一个短窗口排空（最多 ~200ms），
            // 超时就用当前已有的内容，绝不因为等 reader 而把超时处理本身拖住。
            let mut spins = 0;
            while (!stdout_done.load(Ordering::Relaxed) || !stderr_done.load(Ordering::Relaxed))
                && spins < 100
            {
                std::thread::sleep(Duration::from_millis(2));
                spins += 1;
            }
            let stdout = stdout_buf.blocking_lock();
            let stderr = stderr_buf.blocking_lock();
            Ok((
                register_truncated_output(
                    build_output_result(
                        &stdout,
                        &stderr,
                        Value::Null,
                        true,
                        Some(format!(
                            "命令超过 {timeout_ms}ms 未结束，已强制终止（含子进程）。以上是超时前已产出的输出；\
                             长任务请用 background:true 后用 wait_command 等结果（超时不会杀进程）。"
                        )),
                        filter,
                        max_output_bytes,
                        true,
                    ),
                    &ctx,
                    None,
                    true,
                ),
                None,
            ))
        }
    }
}

/// 前台结果组装：stdout/stderr 经服务端过滤后，再压进返回上限（方案 §3.3）。
///
/// 顺序固定「**先过滤、再裁剪**」：`include` 先把无关行剔掉，剩下的才是要挤进上下文的内容；
/// 反过来做会把过滤本来能救回来的信息先裁掉。
///
/// 过滤统计字段只在**真的用了**参数时出现——零参数调用（绝大多数）的响应形状
/// 与改造前逐字段一致，不会平白多出两个 0 让人怀疑「输出被截了」。
#[allow(clippy::too_many_arguments)]
fn build_output_result(
    stdout: &Capture,
    stderr: &Capture,
    exit_code: Value,
    timed_out: bool,
    note: Option<String>,
    filter: &OutputFilter,
    max_output_bytes: usize,
    tail_is_final: bool,
) -> Value {
    let out = filter.apply(&stdout.text());
    let err = filter.apply(&stderr.text());

    let mut info = serde_json::Map::new();
    info.insert("stdout".into(), json!(out.text));
    info.insert("stderr".into(), json!(err.text));
    info.insert("exitCode".into(), exit_code);
    // 总量报**真实**产出（不是保留量，也不是本次展示量），另给被丢弃的中段字节数。
    info.insert("stdoutTotalBytes".into(), json!(stdout.total_bytes()));
    info.insert("stderrTotalBytes".into(), json!(stderr.total_bytes()));
    if stdout.dropped_bytes() > 0 {
        info.insert("stdoutDroppedBytes".into(), json!(stdout.dropped_bytes()));
    }
    if stderr.dropped_bytes() > 0 {
        info.insert("stderrDroppedBytes".into(), json!(stderr.dropped_bytes()));
    }
    info.insert("timedOut".into(), json!(timed_out));
    if let Some(note) = note {
        info.insert("note".into(), json!(note));
    }
    if filter.is_active() {
        for (k, v) in filter.stats_fields("stdout", &out) {
            info.insert(k, v);
        }
        for (k, v) in filter.stats_fields("stderr", &err) {
            info.insert(k, v);
        }
    }
    // `stdoutTruncated` / `stderrTruncated` 由 fit_result 统一写：含义是「本次返回不完整」，
    // 无论是保存缓冲丢了中段还是返回层裁了头尾。
    let info = fit_result(
        info,
        &FitOpts {
            limit: max_output_bytes,
            extract_key_lines: !filter.is_active(),
            tail_is_final,
            next_offsets: false,
        },
    );
    text_result(&Value::Object(info))
}

/// 输出被裁时把保存缓冲登记进注册表，并在返回里补 `handle`（方案 §3.3 定稿 ⑤）。
///
/// 为什么值得多这一步：模型几乎不会主动翻第二页（arXiv 2608.26130），所以「中段关键行」
/// 才是主手段；但「构建日志里唯一那行 FAILED 恰好在省掉的中段、又不含关键词」这种情况
/// 只能靠取回全文。写盘已被否决——没有安全的落盘位置，还要自己管清理；注册表是现成的，
/// 且已结束的条目会被 `command_cleanup_secs`（默认 120s）自动回收。
///
/// 不再重新裁剪：`handle` + 一句说明约 200 字节，32KB 上再叠这点仍是 33KB，
/// 离客户端 5 万字符的落盘门槛还有很远；二次裁剪只会在已裁过的文本上再切一刀，
/// 留下嵌套的「省略」标记。
fn register_truncated_output(
    value: Value,
    ctx: &FinishCtx<'_>,
    exit_code: Option<i32>,
    terminated: bool,
) -> Value {
    let Some(text) = value
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
    else {
        return value;
    };
    let Ok(mut info) = serde_json::from_str::<Value>(text) else {
        return value;
    };
    if info.get("stdoutTruncated").and_then(|v| v.as_bool()) != Some(true)
        && info.get("stderrTruncated").and_then(|v| v.as_bool()) != Some(true)
    {
        return value;
    }

    let handle_id = format!("cmd_{:016x}", rand::random::<u64>());
    ctx.state.running_commands.insert(
        handle_id.clone(),
        RunningCommand {
            pid: ctx.pid,
            command: ctx.command.to_string(),
            cwd: ctx.cwd.to_string(),
            description: ctx.description.clone(),
            child: None,
            stdout: ctx.stdout.clone(),
            stderr: ctx.stderr.clone(),
            exit_code: Arc::new(AsyncMutex::new(exit_code)),
            // 前台超时被杀的那条：`exit_code` 只能是 None（我们没 wait 到状态），
            // 若不打终止标记，清理任务只按「已结束」判断 ⇒ 这条永久占位、缓冲也泄漏。
            // 打上标记后由 `cleanup_finished_commands` 的兜底分支按宽容期回收。
            stop_requested: Arc::new(AtomicBool::new(terminated)),
            stop_requested_at: Arc::new(AsyncMutex::new(if terminated {
                Some(Instant::now())
            } else {
                None
            })),
            // 前台路径在返回前已经等过两路 reader 排空（见 run_foreground 的 done 等待），
            // 把真实标记带进去而不是硬写 true：万一没排空，`outputComplete` 会如实报 false。
            stdout_done: ctx.stdout_done.clone(),
            stderr_done: ctx.stderr_done.clone(),
            started_at: ctx.started_at,
            finished_elapsed_secs: Arc::new(AsyncMutex::new(Some(
                ctx.started_at.elapsed().as_secs(),
            ))),
        },
    );

    if let Some(fields) = info.as_object_mut() {
        fields.insert("handle".into(), json!(handle_id));
        let existing = fields
            .get("note")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let extra = "完整输出已保留：可用 get_command_output(handle) 按 stdoutOffset / stderrOffset 翻页取回（约 2 分钟内有效）。";
        fields.insert(
            "note".into(),
            json!(format!("{existing} {extra}").trim().to_string()),
        );
    }
    text_result(&info)
}

#[allow(clippy::too_many_arguments)]
#[cfg_attr(not(feature = "notifications"), allow(unused_variables))]
fn spawn_background(
    mut child: Box<dyn StdChildWrapper>,
    command: String,
    cwd: String,
    description: Option<String>,
    state: &Arc<AppState>,
    notify_command_complete: bool,
) -> Result<Value, String> {
    let (stdout_buf, stdout_done) = take_reader(child.stdout().take());
    let (stderr_buf, stderr_done) = take_reader(child.stderr().take());

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
    // notifications feature 关闭时 app_handle 字段不存在（state.rs 用 feature gate 剔除），
    // 对应变量也不编译。用 feature gate 而非 #[cfg(not(test))]：后者对集成测试无效。
    #[cfg(feature = "notifications")]
    let app_handle = state.app_handle.lock().unwrap().clone();
    #[cfg(feature = "notifications")]
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
                // 后台命令完成通知（notifications feature 关闭时不链接 notification 插件，避免 0xc0000139）
                #[cfg(feature = "notifications")]
                if notify_command_complete {
                    if let Some(ref h) = app_handle {
                        use tauri_plugin_notification::NotificationExt;
                        let body = match code {
                            Some(0) => format!("{} 已完成（退出码 0）", notify_cmd),
                            Some(c) => format!("{} 已结束（退出码 {}）", notify_cmd, c),
                            None => format!("{} 已结束（无退出码）", notify_cmd),
                        };
                        // 不吞错：理由见 main.rs::notify_toast 的注释（mac 上这是唯一的失败信号）。
                        if let Err(e) = h
                            .notification()
                            .builder()
                            .title("后台命令完成")
                            .body(&body)
                            .show()
                        {
                            log::warn!("后台命令完成通知发送失败：{e}");
                        }
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
            child: Some(child),
            stdout: stdout_buf,
            stderr: stderr_buf,
            exit_code,
            stop_requested: Arc::new(AtomicBool::new(false)),
            stop_requested_at: Arc::new(AsyncMutex::new(None)),
            stdout_done,
            stderr_done,
            started_at,
            finished_elapsed_secs: finished_elapsed,
        },
    );

    Ok(text_result(&json!({ "handle": handle_id, "pid": pid })))
}

/// 把会话 id 与本次生效 cwd 注入 run_command 返回的 JSON 文本
/// （`content[0].text` 是一段 JSON 字符串）。仅成功路径调用——错误响应结构不同，不注入。
fn inject_session_info(
    result: Result<Value, String>,
    session_id: Option<String>,
    resolved_cwd: &std::path::Path,
    cwd_fallback: bool,
    session_ignored: bool,
    shell: ShellType,
) -> Result<Value, String> {
    let mut v = result?;
    if let Some(obj) = v.as_object_mut() {
        if let Some(arr) = obj.get_mut("content").and_then(|c| c.as_array_mut()) {
            if let Some(first) = arr.first_mut() {
                if let Some(text) = first.get_mut("text").and_then(|t| t.as_str()) {
                    if let Ok(mut info) = serde_json::from_str::<serde_json::Value>(text) {
                        // 非对象（理论上不会出现，text_result 恒为 json!({..})）就不动，
                        // 避免 `info["k"] = …` 在数组/标量上 panic。
                        if let Some(fields) = info.as_object_mut() {
                            // 🔴 必须写进 content[0].text 内层：模型只读这个字段。
                            // 旧实现是 `value.as_object_mut().insert("shell", …)`，插在
                            // text_result 的**包装层**（与 `content` 同级）——MCP 客户端只
                            // 读 content 数组，顶层多余字段被直接丢弃，于是「回声当前壳层」
                            // 从未真正生效（换壳后模型仍按旧语法写命令）。
                            fields.insert("shell".into(), json!(shell.as_str()));
                            // 其余字段仍只在确有会话或发生 cwd 回退时注入（不留 null 占位）。
                            if session_id.is_some() || cwd_fallback {
                                if let Some(sid) = session_id {
                                    fields.insert("sessionId".into(), json!(sid));
                                }
                                if cwd_fallback {
                                    fields.insert("cwdFallback".into(), json!(true));
                                }
                                fields.insert(
                                    "cwd".into(),
                                    json!(resolved_cwd.to_string_lossy().to_string()),
                                );
                            }
                            if session_ignored {
                                fields.insert(
                                    "sessionNote".into(),
                                    json!("「命令会话持久化」未开启，sessionId 已忽略：工作目录与 env 不会带到下一次调用，请每次显式传 cwd。本次传入的 env 仍已生效。"),
                                );
                            }
                            // 与 `text_result` 同档位（compact）：这里是把字段补回已经序列化好的
                            // content[0].text，用 pretty 会让同一个返回前后两种格式并存。
                            let new_text =
                                serde_json::to_string(&info).unwrap_or_else(|_| text.to_string());
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
    use crate::mcp::tools::testutil::make_state as make_state_with_config;

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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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

    /// 壳层回声必须落在 `content[0].text` 内层——那是模型唯一会读的字段。
    /// 旧实现插在 `text_result` 的包装层（与 `content` 同级），客户端只取 content 数组，
    /// 顶层字段被直接丢弃，等于这个功能从未生效。
    #[test]
    fn shell_echo_lands_inside_content_text() {
        let wrapped = crate::mcp::tools::text_result(&json!({ "stdout": "hi", "exitCode": 0 }));
        let out = inject_session_info(
            Ok(wrapped),
            None,
            std::path::Path::new("C:/tmp"),
            false,
            false,
            ShellType::Bash,
        )
        .expect("注入成功");

        assert!(
            out.get("shell").is_none(),
            "包装层不该再有 shell（模型读不到）：{out}"
        );
        let info: Value = serde_json::from_str(
            out["content"][0]["text"]
                .as_str()
                .expect("content[0].text 必须是字符串"),
        )
        .expect("解析内层 JSON");
        assert_eq!(info["shell"], json!("bash"), "{info}");
        // 默认（无 session、无 cwd 回退）不得留 sessionId/cwd 的 null 占位。
        assert!(info.get("sessionId").is_none(), "{info}");
        assert!(info.get("cwd").is_none(), "{info}");
        // 原有字段原样保留。
        assert_eq!(info["stdout"], json!("hi"), "{info}");
    }

    /// 真实执行路径同样要能读到 shell 字段（守住「注入点被回退成包装层」这类回归）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shell_field_visible_in_real_response() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let expected = {
            let cfg = state.config.read().await;
            crate::mcp::tools::shell::parse_shell_type(&cfg.shell_type)
                .as_str()
                .to_string()
        };
        let v = handle(
            RunCommandArgs {
                command: "echo shell_probe".into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                include: None,
                exclude: None,
                tail_lines: None,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("echo 应成功");

        assert!(v.get("shell").is_none(), "包装层不该有 shell：{v}");
        let info: serde_json::Value =
            serde_json::from_str(v["content"][0]["text"].as_str().expect("text")).expect("json");
        assert_eq!(info["shell"], json!(expected), "{info}");
    }

    /// 回归：会话持久化关闭（默认）时 env 曾被整个丢掉、子进程里变量为空且不报错。
    /// 同时传了 sessionId 时应回 sessionNote 说明它被忽略。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn env_applies_without_session_and_notes_ignored_session() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            c.session_cwd_enabled = false;
        });
        let command = {
            let cfg = state.config.read().await;
            match crate::mcp::tools::shell::parse_shell_type(&cfg.shell_type) {
                ShellType::Bash => "echo \"[$CCB_ENV_PROBE]\"",
                _ => "echo [%CCB_ENV_PROBE%]",
            }
        };
        let v = handle(
            RunCommandArgs {
                command: command.into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: Some("cwd_whatever".into()),
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                include: None,
                exclude: None,
                tail_lines: None,
                description: None,
                env: Some(vec![EnvEntry {
                    key: "CCB_ENV_PROBE".into(),
                    value: "probe_ok".into(),
                }]),
            },
            &state,
        )
        .await
        .expect("echo 应成功");
        let info: serde_json::Value =
            serde_json::from_str(v["content"][0]["text"].as_str().expect("text")).expect("json");
        let stdout = info["stdout"].as_str().unwrap_or("");
        assert!(stdout.contains("[probe_ok]"), "env 未注入：{info}");
        assert!(
            info.get("sessionNote").is_some(),
            "应提示 sessionId 被忽略：{info}"
        );
    }

    /// B 类容错：cwd 缺失时回退到第一个存在的 allowed_root 继续执行，
    /// 响应注入 cwdFallback=true + 实际 cwd（审计近 30 天实锤 27 条「cwd 必传」报错）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_cwd_falls_back_to_allowed_root() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let v = handle(
            RunCommandArgs {
                command: "echo hello".into(),
                cwd: None,
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                include: None,
                exclude: None,
                tail_lines: None,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("cwd 缺失应回退到 allowed_root 而非报错");

        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .expect("response must have text payload");
        let info: serde_json::Value = serde_json::from_str(text).expect("text payload is JSON");

        assert_eq!(
            info.get("cwdFallback").and_then(|f| f.as_bool()),
            Some(true),
            "回退发生时必须显式标记：{info}"
        );
        assert_eq!(
            info.get("cwd").and_then(|c| c.as_str()),
            Some(dir.to_string_lossy().as_ref()),
            "回显的实际 cwd 应为回退目标"
        );
        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(
            stdout.contains("hello"),
            "命令应在回退目录正常执行：{stdout:?}"
        );
    }

    /// B 类容错的边界：白名单无可用目录时维持「cwd 必传」报错，不猜魔法值。
    #[tokio::test]
    async fn missing_cwd_without_roots_still_errors() {
        let (state, _dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            c.allowed_roots.clear();
        });
        let err = handle(
            RunCommandArgs {
                command: "echo hello".into(),
                cwd: None,
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 4096,
                include: None,
                exclude: None,
                tail_lines: None,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect_err("无 cwd 且无可用回退目录时应报错");
        assert!(err.contains("cwd 必传"), "报错应说明 cwd 必传的根因：{err}");
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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

    /// maxOutputBytes 的新语义 = **返回正文**上限（序列化后 UTF-8 字节，方案 §3.3）：
    /// 跑一段远超上限的输出，期望 ① 序列化结果压进「上限 + 登记说明开销」；
    /// ② stdoutTruncated:true；③ 头尾标记都在（头 1/8 + 真尾 7/8，错误结论在尾）；
    /// ④ 返回带 handle，且凭 handle 用 get_command_output 能翻页取回完整输出（定稿 ⑤）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn foreground_max_output_bytes_truncates() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        let payload = format!("HEAD_MARK_{}", "x".repeat(6000));
        let v = handle(
            RunCommandArgs {
                command: format!("echo {payload}_TAIL_MARK"),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 5000,
                max_output_bytes: 2048,
                include: None,
                exclude: None,
                tail_lines: None,
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
        // register_truncated_output 在 fit 之后追加 handle 与取回说明（约 300 字节），不重裁。
        assert!(
            text.len() <= 2048 + 512,
            "返回应压在上限+登记说明内，实际 {} 字节",
            text.len()
        );
        let info: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            info.get("stdoutTruncated").and_then(|t| t.as_bool()),
            Some(true),
            "stdoutTruncated 字段必须是 true"
        );
        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(stdout.contains("HEAD_MARK"), "头部要保留：{stdout:?}");
        assert!(stdout.contains("TAIL_MARK"), "真尾要保留：{stdout:?}");
        // ⑤ 登记的 handle 能翻页取回完整输出。
        let handle_id = info
            .get("handle")
            .and_then(|h| h.as_str())
            .expect("截断时必须登记 handle")
            .to_string();
        let full = crate::mcp::tools::get_command_output::handle(
            crate::mcp::tools::get_command_output::GetCommandOutputArgs {
                handle: handle_id,
                stdout_offset: 0,
                stderr_offset: 0,
                include: None,
                exclude: None,
                tail_lines: None,
            },
            &state,
        )
        .await
        .expect("凭 handle 应能取回完整输出");
        let full_text = full
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .unwrap();
        let full_info: serde_json::Value = serde_json::from_str(full_text).unwrap();
        let full_stdout = full_info
            .get("stdout")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        assert!(
            full_stdout.len() > stdout.len(),
            "翻页取回的应比截断后的更完整：{} vs {}",
            full_stdout.len(),
            stdout.len()
        );
        assert!(full_stdout.contains("HEAD_MARK"));
        assert!(full_stdout.contains("TAIL_MARK"));
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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
                include: None,
                exclude: None,
                tail_lines: None,
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

    /// 超时必须把**已产出的输出**带回来，而不是返回空串。
    ///
    /// 回归背景：旧实现在超时分支里硬编码 `"stdout": ""` / `"stderr": ""`，而 reader 线程
    /// 其实已经把内容收进缓冲了——相当于把拿到手的诊断信息丢掉。对 `cargo build`
    /// 这类边跑边吐进度的命令，超时前的输出恰好是最有用的部分（卡在哪一步）；
    /// 审计日志统计 1281 次调用中有 141 次（11%）会走到超时分支。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timeout_preserves_partial_output() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });

        // 先 echo（立即产出），再阻塞约 19s，确保一定撞上 2s 超时。
        //
        // Windows：用 `ping -n` 而不用 `timeout /t`——后者在 stdin 被重定向时会直接
        // 报错退出，而我们的子进程 stdin 是 `Stdio::null()`。
        // Unix：用 `sleep`（POSIX 自带）。注意不能直接用 Windows 那串——`ping -n`
        // 在 mac 上是非法参数（应为 `-c`）、`> nul` 也不是空设备（应为 `/dev/null`），
        // 两者都会让命令立即失败、根本撞不到超时，测试就失去意义了。
        #[cfg(windows)]
        let blocking_cmd = "echo partial_before_timeout && ping -n 20 127.0.0.1 > nul";
        #[cfg(not(windows))]
        let blocking_cmd = "echo partial_before_timeout && sleep 19";

        let v = handle(
            RunCommandArgs {
                command: blocking_cmd.into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 2000,
                max_output_bytes: 64 * 1024,
                include: None,
                exclude: None,
                tail_lines: None,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("超时不应返回 Err，而应返回带 timedOut 标记的结果");

        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .unwrap();
        let info: serde_json::Value = serde_json::from_str(text).unwrap();

        assert_eq!(
            info.get("timedOut").and_then(|b| b.as_bool()),
            Some(true),
            "命令超时时 timedOut 必须为 true：{info}"
        );
        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(
            stdout.contains("partial_before_timeout"),
            "超时分支必须保留超时前已产出的 stdout（旧实现返回空串），实际：{stdout:?}"
        );
    }

    /// **Unix 真实执行验证**：确认 `/bin/sh -c` 这条链路真的能跑通。
    ///
    /// 为何单独写：mac 侧的壳层实现（`build_invocation_unix`）是在 Windows 机器上
    /// 盲写的，CI 的 `clippy` 只能保证编译、保证不了真能执行。这条在 macOS runner 上
    /// 真的 spawn 一次 `/bin/sh`，把「写完没跑过」变成「跑过了」。
    #[tokio::test]
    #[cfg(not(windows))]
    async fn unix_sh_really_executes() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
        });
        // 用 $(( )) 算术展开：这是 POSIX sh 语法，能顺带证明走的确实是 sh 而非别的壳层。
        let v = handle(
            RunCommandArgs {
                command: "echo unix_ok_$((6*7))".into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 10_000,
                max_output_bytes: 4096,
                include: None,
                exclude: None,
                tail_lines: None,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("Unix 前台 sh 执行应成功");

        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.get("text"))
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string();
        let info: serde_json::Value = serde_json::from_str(&text).expect("结果应为 JSON");
        let stdout = info.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
        assert!(
            stdout.contains("unix_ok_42"),
            "sh 算术展开未生效，说明壳层不是 POSIX sh 或未真正执行：{stdout:?}"
        );
        assert_eq!(info.get("exitCode").and_then(|c| c.as_i64()), Some(0));
    }

    /// **Unix 真实执行验证**：会话 cwd 捕获链路（`pwd` 写文件 → Rust 读回）。
    ///
    /// 这条专门盯 `build_invocation_unix` 里把 Windows 的 `pwd -W` 换成 `pwd` 那处改动：
    /// `-W` 是 MSYS 专属扩展，在 Unix 上是非法选项、会让整条命令失败。若哪天有人把
    /// 两个平台的实现又合并回去，这条会立刻红。
    ///
    /// 注意 sessionId 是**后端生成的 opaque handle**（`cwd_` 前缀），必须从首次响应里
    /// 取出来再复用——不能自造字符串（那会被当成无效 handle）。
    #[tokio::test]
    #[cfg(not(windows))]
    async fn unix_session_cwd_capture_works() {
        let (state, dir) = make_state_with_config(|c| {
            c.shell_enabled = true;
            c.whitelist_enabled = true;
            c.session_cwd_enabled = true;
        });
        std::fs::create_dir_all(dir.join("sub")).expect("建子目录");

        let payload = |v: &serde_json::Value| -> serde_json::Value {
            let t = v
                .get("content")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|x| x.get("text"))
                .and_then(|x| x.as_str())
                .expect("响应应带 text 载荷")
                .to_string();
            serde_json::from_str(&t).expect("text 载荷应为 JSON")
        };

        // 第一次：带 cwd 建会话，并在命令里 cd 进子目录——cwd 捕获应把子目录记下来。
        let v1 = handle(
            RunCommandArgs {
                command: "cd sub && echo moved".into(),
                cwd: Some(dir.to_string_lossy().into_owned()),
                session_id: None,
                background: false,
                timeout_ms: 10_000,
                max_output_bytes: 4096,
                include: None,
                exclude: None,
                tail_lines: None,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("首次带 cwd 的会话命令应成功");
        let info1 = payload(&v1);
        let session_id = info1
            .get("sessionId")
            .and_then(|s| s.as_str())
            .expect("开启会话持久化时必须回显 sessionId")
            .to_string();

        // 第二次：只带 sessionId 跑 `pwd`，输出应落在子目录里——证明 `pwd` 捕获链路真的生效。
        let v2 = handle(
            RunCommandArgs {
                command: "pwd".into(),
                cwd: None,
                session_id: Some(session_id),
                background: false,
                timeout_ms: 10_000,
                max_output_bytes: 4096,
                include: None,
                exclude: None,
                tail_lines: None,
                description: None,
                env: None,
            },
            &state,
        )
        .await
        .expect("复用会话的命令应成功");
        let stdout = payload(&v2)
            .get("stdout")
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string();
        assert!(
            stdout.trim_end().ends_with("sub"),
            "会话 cwd 未落到子目录，说明 Unix 侧 pwd 捕获链路没跑通：{stdout:?}"
        );
    }

    /// 默认超时不得回退到 30s。
    ///
    /// 依据：审计日志 1281 次真实调用里 141 次（11%）serverMs ≥ 29s（撞 30s 超时），
    /// 而 p50 只有 1125ms——多数命令很快，是构建类被成批截断。这条锁住默认值，
    /// 避免以后被无意改回。
    #[test]
    fn default_timeout_is_not_30s() {
        assert_eq!(default_timeout_ms(), 120_000);
    }
}
