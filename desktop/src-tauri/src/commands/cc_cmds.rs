//! CC 对话的 IPC 命令层。
//!
//! 命名带 `_cmds`：`crate::cc_session` 是实现层，这里是给前端的门面。
//!
//! ## 为什么大部分命令都这么薄
//!
//! 判断逻辑全在 `cc_session` 里（可写单测、可脱离 Tauri 跑），命令层只做三件事：
//! 读配置、拼参数、把 `Result` 翻成前端能看的文案。**唯一有分量的是 `cc_start`**，
//! 因为它要决定「本机还是远端」—— 那是 IPC 层才有的信息（连接 id + 配置）。
//!
//! ## 事件出去的路径
//!
//! 命令**不返回答内容**，内容全走 `cc-event` 事件 + `cc_snapshot` 快照。
//! 理由见 `manager.rs` 的模块文档：切页会卸载组件，只有事件流水活得过卸载。
//! 所以 `cc_start` 返回 `()`，前端发完立刻等事件，不阻塞在 invoke 上。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use super::ssh_cmds::ssh_link_args;
use crate::cc_session::channel::{self, LaunchSpec};
use crate::cc_session::manager::{self, Launch, SnapshotDto, TauriSink};
use crate::cc_session::proto::CcEvent;
use crate::cc_session::session::{with_answers, Verdict};
use crate::mcp::bridge::spawn;
use crate::state::AppState;

/// 探测结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcProbe {
    pub found: bool,
    /// 绝对路径。远端模式下**必须**用它执行：真正跑起来的 bash 是非登录的，
    /// 拿不到 `~/.local/bin` 那份 PATH。
    pub path: String,
    pub version: Option<String>,
    /// 给人看的一句话。`found=false` 时这就是错误说明。
    pub message: String,
    /// 走的是本机还是远端，前端据此显示「本机 / user@host」。
    pub target: String,
}

/// 起进程时不要弹黑窗口。
///
/// 🔴 这是已知故障（打包版执行命令弹 console）的同源修法：`claude.exe` 与控制台
/// 子系统链接，从 GUI 进程直接 spawn 会闪一个黑框。`spawn_piped` 已经带了
/// `CREATE_NO_WINDOW`，这里补的是**探针**那几条临时命令。
fn hidden_command(program: &Path) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 本机探测：解析出可执行文件，再问一次版本。
///
/// 版本只是**参考信息**，拿不到不影响使用（有的包装脚本不实现 `--version`）。
fn probe_local_sync(hint: &str) -> CcProbe {
    let target = "本机".to_string();
    let program = match spawn::resolve_program(hint) {
        Ok(p) => p,
        Err(e) => {
            return CcProbe {
                found: false,
                path: String::new(),
                version: None,
                message: format!("找不到 claude 命令：{e}。请确认已安装并加入 PATH。"),
                target,
            }
        }
    };
    let version = hidden_command(&program)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    CcProbe {
        found: true,
        path: program.to_string_lossy().into_owned(),
        version,
        message: "已找到 claude".into(),
        target,
    }
}

/// 远端探测：`bash -lc 'command -v claude'`。
///
/// 🔴 必须 `-l`：`claude` 常装在 `~/.local/bin`，非登录 shell 的 PATH 里没有。
fn probe_remote_sync(program: &Path, args: &[String], target: String) -> CcProbe {
    let out = hidden_command(program).args(args).output();
    let not_found = |msg: String| CcProbe {
        found: false,
        path: String::new(),
        version: None,
        message: msg,
        target: target.clone(),
    };
    let out = match out {
        Ok(o) => o,
        Err(e) => return not_found(format!("SSH 探测没能执行：{e}")),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    if let Some(path) = stdout
        .lines()
        .find_map(|l| l.trim().strip_prefix("__CC_PATH__"))
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        return CcProbe {
            found: true,
            path: path.to_string(),
            version: None,
            message: "已在远端找到 claude".into(),
            target,
        };
    }
    if stdout.contains("__CC_MISSING__") {
        return not_found(
            "远端没找到 claude。请确认已安装（`npm i -g @anthropic-ai/claude-code`），\
             并注意它可能只装在登录 shell 的 PATH 里。"
                .into(),
        );
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let detail = stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("没有输出");
    not_found(format!("远端探测失败：{detail}"))
}

/// 探测 claude 是否可用。`connection_id` 为空 = 本机。
///
/// 前端进入对话页、切换连接、重试时各调一次；结果里的 `path` 要带回
/// `cc_start`，避免每次启动都重探一遍。
#[tauri::command]
pub async fn cc_probe(
    state: State<'_, Arc<AppState>>,
    connection_id: Option<String>,
    claude_path: Option<String>,
) -> Result<CcProbe, String> {
    let hint = claude_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("claude");
    let Some(conn_id) = connection_id.filter(|s| !s.trim().is_empty()) else {
        // 本机探测会跑一个子进程（`--version`），放到阻塞线程池里，
        // 别占 tokio worker（CLAUDE.md 里那条 `#[tokio::test]` 死锁的教训）。
        let hint = hint.to_string();
        return tauri::async_runtime::spawn_blocking(move || probe_local_sync(&hint))
            .await
            .map_err(|e| format!("探测任务失败：{e}"));
    };

    // 复用 SSH 的启用开关：对话页要连远端，与终端是同一个前提。
    if !state.config.read().await.ssh_enabled {
        return Err("SSH 终端未启用，无法在远端运行".into());
    }
    let (ssh_args, destination) = ssh_link_args(state.inner(), &conn_id).await?;
    let program = spawn::resolve_program("ssh")
        .or_else(|_| spawn::resolve_program("ssh.exe"))
        .map_err(|e| format!("未检测到系统 OpenSSH 客户端：{e}"))?;
    let target = destination.clone();
    let mut args = ssh_args;
    args.push("--".into());
    args.push(destination);
    args.push(channel::probe_script().to_string());
    tauri::async_runtime::spawn_blocking(move || probe_remote_sync(&program, &args, target))
        .await
        .map_err(|e| format!("探测任务失败：{e}"))
}

/// `cc_start` 的入参。
///
/// 打成一个结构体而不是散参数：clippy 的 7 参数上限只是引子，真正的原因是这些字段
/// 全是可选字符串，平铺时**顺序写错也能编译**（`model` 传成 `cwd` 之类），
/// 而表现是「模型名不对」或「工作目录不存在」，排查方向会被完全带偏。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcStartReq {
    /// 空 = 本机跑。
    pub connection_id: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    /// 探测得到的 claude 绝对路径。远端模式下**必须**给：真正跑起来的 bash 是非登录的。
    pub claude_path: Option<String>,
    pub text: String,
}

/// 起一轮对话。**首条消息随启动一起发**，省一次往返。
///
/// 返回 `()` 而不是 session id：session id 只在 `system/init` 里出现，
/// 启动那一刻根本还不知道。前端从事件流里拿。
#[tauri::command]
pub async fn cc_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    req: CcStartReq,
) -> Result<(), String> {
    let text = req.text.trim().to_string();
    if text.is_empty() {
        return Err("消息不能为空".into());
    }
    // 🔴 忙碌判据是「有活跃轮次」，不是「进程活着」：实测 CLI 收到 `result` 后
    // 不会退出，它会一直等 stdin 的下一条消息。把这两件事混为一谈，第二条消息
    // 就会被永久拒绝（界面上是一句「上一轮还在进行」，而其实那一轮早就结束了）。
    if state.cc.shared().turn_active() {
        return Err("上一轮还在进行，请等它结束或先中断".into());
    }

    // 进程还活着 ⇒ 直接在它身上发下一句，省掉一次冷启动。
    // 实测冷启动 8~18s（大头是用户自己的 SessionStart 钩子），每条消息都付一次
    // 在聊天界面里是不可接受的。进程死了才走下面「新起 + --resume」那条路。
    if state.cc.is_running() && state.cc.send(&text).is_ok() {
        manager::record_local(&app, state.cc.shared(), CcEvent::UserMessage { text });
        return Ok(());
    }

    let spec = LaunchSpec {
        cwd: clean(req.cwd),
        model: clean(req.model),
        permission_mode: clean(req.permission_mode),
        resume: state.cc.shared().resume_id(),
    };
    let path_hint = clean(req.claude_path).unwrap_or_else(|| "claude".to_string());
    let conn_id = clean(req.connection_id);

    let launch = match conn_id {
        None => {
            let (program, args) = channel::local_command(&path_hint, &spec)?;
            // 留空 ⇒ 家用目录，**不能**用当前进程的 cwd：那是 cc-bridge 的安装目录，
            // 让 agent 在安装目录里乱翻是最容易出事的默认值。
            let dir = spec.cwd.as_deref().map(PathBuf::from).or_else(home_dir);
            if let Some(d) = dir.as_deref() {
                if !d.is_dir() {
                    return Err(format!("工作目录不存在：{}", d.display()));
                }
            }
            manager::local_launch(&program.to_string_lossy(), args, dir.as_deref())
        }
        Some(id) => {
            if !state.config.read().await.ssh_enabled {
                return Err("SSH 终端未启用，无法在远端运行".into());
            }
            let (ssh_args, destination) = ssh_link_args(state.inner(), &id).await?;
            let (program, args) =
                channel::remote_command(&ssh_args, &destination, &path_hint, &spec)?;
            // 远端 cwd 由引导脚本自己 `cd`，不能进 `Command::current_dir`
            // —— 那是本机路径，喂给 ssh 只会得到一句看不懂的报错。
            Launch {
                program,
                args,
                env: Vec::new(),
                cwd: None,
            }
        }
    };

    let sink = Arc::new(TauriSink::new(app.clone(), Arc::clone(state.cc.shared())));
    state.cc.start(launch, sink)?;

    // 先把用户这句话记进流水，再发出去：切页回来时它必须还在。
    manager::record_local(
        &app,
        state.cc.shared(),
        CcEvent::UserMessage { text: text.clone() },
    );

    if let Err(e) = state.cc.send(&text) {
        // 起得来却写不进去，说明进程已经在退（多半是 CLI 参数不对）。
        // 收尸，别留一个半死的轮次占着「进行中」。
        state.cc.interrupt();
        return Err(format!("消息没能送达 claude：{e}"));
    }
    Ok(())
}

/// 在**当前这一轮**里再发一句话。
///
/// ⚠️ `--print` 模式下 CLI 一次只处理一条消息，收到 `result` 就退出；真正的多轮
/// 靠下一次 `cc_start`（带 `resume`）。所以这个命令只在「进程还活着」时有意义，
/// 前端不必主动调它 —— 留着是为了将来 CLI 支持一轮多消息时不用改协议层。
#[tauri::command]
pub async fn cc_send(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    text: String,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("消息不能为空".into());
    }
    state.cc.send(text)?;
    manager::record_local(
        &app,
        state.cc.shared(),
        CcEvent::UserMessage {
            text: text.to_string(),
        },
    );
    Ok(())
}

/// 批准 / 拒绝 / 回答提问。
///
/// 🔴 `allow` 的入参**从 Rust 侧取**（sink 收到 `PermissionAsk` 时登记的），
/// 不让前端回传：那份入参决定了「批准的是哪条命令」，交给一个可能被旧状态污染的
/// 图层去重述，等于把安全判据外包。
///
/// 唯一的例外是 `answers`：`AskUserQuestion` 的答案在协议里就是
/// `updatedInput.answers`，没有第二条通道（2026-10-24 真机探针）。所以它只能
/// 在「登记时就是一条提问」的前提下并入，且键必须落在本次问过的问题里 ——
/// 放行条件由 `PendingAsk::accepts_answers` 定死，不由这一次调用声明。
#[tauri::command]
pub async fn cc_respond(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request_id: String,
    decision: String,
    message: Option<String>,
    answers: Option<serde_json::Value>,
) -> Result<(), String> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("缺少 request_id".into());
    }
    let decision = decision.trim().to_ascii_lowercase();
    let verdict = match decision.as_str() {
        "allow" => {
            let ask = state
                .cc
                .shared()
                .pending_ask(&request_id)
                .ok_or("这条请求已经失效（进程已退出或已处理过），请重新发起")?;
            let input = match answers {
                Some(given) => {
                    if !ask.accepts_answers {
                        return Err(
                            "这个工具不接受回答：只有提问（AskUserQuestion）能带 answers".into(),
                        );
                    }
                    with_answers(&ask.input, &given)?
                }
                // 提问却没带答案：CLI 会认定「用户没回答」（真机实测回执
                // `The user did not answer the questions.`），模型拿不到任何选择。
                // 与其让它误以为用户放弃了，不如让前端明确走「跳过」。
                None if ask.accepts_answers => {
                    return Err("这是一条提问，请先选择答案，或点「跳过」".into());
                }
                None => ask.input,
            };
            Verdict::allow_as_is(&input)
        }
        "deny" => Verdict::deny(message.unwrap_or_default()),
        other => return Err(format!("未知的裁决：{other}")),
    };
    state.cc.respond(&request_id, &verdict)?;
    // 写成功才摘单：写失败（进程刚好退出）时用户还能再点一次。
    state.cc.shared().forget(&request_id);
    manager::record_local(
        &app,
        state.cc.shared(),
        CcEvent::PermissionResolved {
            request_id,
            decision,
        },
    );
    Ok(())
}

/// 中断这一轮。返回「是否真有一轮被打断」。
#[tauri::command]
pub async fn cc_interrupt(state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    Ok(state.cc.interrupt())
}

/// 快照：切页回来 / 断线重连时重建界面用。
#[tauri::command]
pub async fn cc_snapshot(state: State<'_, Arc<AppState>>) -> Result<SnapshotDto, String> {
    Ok(state.cc.snapshot())
}

/// 新对话：清流水 + 清 session id。
///
/// 请求 id / 缓冲都清掉，等于换了一条会话链。**只在用户点「新对话」时调**。
#[tauri::command]
pub async fn cc_reset(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.cc.reset();
    Ok(())
}

/// 去空白；全空视作未提供。
fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 家用目录。Windows 认 `USERPROFILE`，其余认 `HOME`。
///
/// 单独提出来是因为它要能返回 `None`（老系统上变量可能缺）：那时只好退回进程 cwd，
/// 由调用方自己决定接不接受。
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_treats_blank_as_absent() {
        assert_eq!(clean(None), None);
        assert_eq!(clean(Some("   ".into())), None);
        assert_eq!(clean(Some(" x ".into())), Some("x".into()));
    }

    /// 探针必须能在**没有 claude** 的机器上稳定返回 found=false 而不是报错，
    /// 否则前端连「你没装 CLI」都显示不出来。
    #[test]
    fn missing_binary_is_reported_not_panicked() {
        let probe = probe_local_sync("cc-bridge-definitely-not-a-real-binary");
        assert!(!probe.found);
        assert!(probe.path.is_empty());
        assert!(probe.message.contains("找不到"), "{}", probe.message);
    }
}
