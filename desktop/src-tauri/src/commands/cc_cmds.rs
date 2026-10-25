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
use crate::cc_session::store::{self, SessionFacts};
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
/// `session_id` 是内部 id（`cc_new_session` 铸发）：这一轮的全部状态 ——
/// 事件流水、进程、facts、库里的行 —— 都归在那一条 `CcSession` 上。
/// 多会话并存时它决定「这句话发给谁」；3-1a 期前端只持有其中一条。
#[tauri::command]
pub async fn cc_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    session_id: u64,
    req: CcStartReq,
) -> Result<(), String> {
    let cc = state
        .cc
        .get(session_id)
        .ok_or_else(|| format!("会话不存在（内部 id {session_id}）"))?;
    let text = req.text.trim().to_string();
    if text.is_empty() {
        return Err("消息不能为空".into());
    }

    // 先把这一轮的形状拼出来 —— 下面「目标变没变」要用它判断，而判断必须发生在
    // 「能不能复用旧进程」之前。
    let spec = LaunchSpec {
        cwd: clean(req.cwd),
        model: clean(req.model),
        permission_mode: clean(req.permission_mode),
        // 待会儿按需覆盖：目标变了就不能带上一个目标的 session id。
        resume: cc.shared().resume_id(),
    };
    let path_hint = clean(req.claude_path).unwrap_or_else(|| "claude".to_string());
    let conn_id = clean(req.connection_id);

    // 🔴 目标变了（换机器 / 换目录）必须先把旧进程收掉，并且**清掉 session id**。
    //
    // 不收的后果：`cc_start` 会走「进程还活着 ⇒ 直接 send」那条快路径，把这条消息
    // 写进**另一个目标**的 claude 里 —— 界面显示正常，内容却去了别处，没有任何报错。
    // 不清 id 的后果：本机的 session id 被带去远端 `--resume`，CLI 那边按机器+目录
    // 存转录，只会回一句「找不到会话」。
    let target_changed = !cc
        .shared()
        .same_target(conn_id.as_deref().unwrap_or(""), spec.cwd.as_deref());
    if target_changed {
        cc.interrupt();
        cc.shared().clear_resume();
        // 换目标 = 新会话：库里那条属于旧目标，接着更新它会让两个目标的记录混成一条。
        cc.shared().clear_row();
    }

    // 🔴 忙碌判据是「有活跃轮次」，不是「进程活着」：实测 CLI 收到 `result` 后
    // 不会退出，它会一直等 stdin 的下一条消息。把这两件事混为一谈，第二条消息
    // 就会被永久拒绝（界面上是一句「上一轮还在进行」，而其实那一轮早就结束了）。
    if cc.shared().turn_active() {
        return Err("上一轮还在进行，请等它结束或先中断".into());
    }

    // 进程还活着 ⇒ 直接在它身上发下一句，省掉一次冷启动。
    // 实测冷启动 8~18s（大头是用户自己的 SessionStart 钩子），每条消息都付一次
    // 在聊天界面里是不可接受的。进程死了才走下面「新起 + --resume」那条路。
    if cc.is_running() && cc.send(&text).is_ok() {
        manager::record_local(&app, cc.shared(), CcEvent::UserMessage { text });
        return Ok(());
    }

    // 上面可能刚刚清过 id，重新取一次才是对的。
    let spec = LaunchSpec {
        resume: cc.shared().resume_id(),
        ..spec
    };

    // 先记下「这一轮在哪跑」，落盘和恢复都要它。
    // 🔴 `claude_path` 必须在里面：远端续聊是非登录 bash，没有绝对路径就等于
    // 「远端没装 claude」—— 而这三个字段（连接/目录/可执行文件）在本地测试里
    // 全是空值，最容易被「本机通过」骗过去。
    cc.shared().set_facts(SessionFacts {
        connection_id: conn_id.clone().unwrap_or_default(),
        cwd: spec.cwd.clone(),
        claude_path: Some(path_hint.clone()),
        model: spec.model.clone(),
        permission_mode: spec.permission_mode.clone(),
    });

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

    let sink = Arc::new(TauriSink::new(app.clone(), Arc::clone(cc.shared())));
    cc.start(launch, sink)?;

    // 先把用户这句话记进流水，再发出去：切页回来时它必须还在。
    manager::record_local(
        &app,
        cc.shared(),
        CcEvent::UserMessage { text: text.clone() },
    );

    if let Err(e) = cc.send(&text) {
        // 起得来却写不进去，说明进程已经在退（多半是 CLI 参数不对）。
        // 收尸，别留一个半死的轮次占着「进行中」。
        cc.interrupt();
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
    session_id: u64,
    text: String,
) -> Result<(), String> {
    let cc = state
        .cc
        .get(session_id)
        .ok_or_else(|| format!("会话不存在（内部 id {session_id}）"))?;
    let text = text.trim();
    if text.is_empty() {
        return Err("消息不能为空".into());
    }
    cc.send(text)?;
    manager::record_local(
        &app,
        cc.shared(),
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
    session_id: u64,
    request_id: String,
    decision: String,
    message: Option<String>,
    answers: Option<serde_json::Value>,
) -> Result<(), String> {
    let cc = state
        .cc
        .get(session_id)
        .ok_or_else(|| format!("会话不存在（内部 id {session_id}）"))?;
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("缺少 request_id".into());
    }
    let decision = decision.trim().to_ascii_lowercase();
    let verdict = match decision.as_str() {
        "allow" => {
            let ask = cc
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
    cc.respond(&request_id, &verdict)?;
    // 写成功才摘单：写失败（进程刚好退出）时用户还能再点一次。
    cc.shared().forget(&request_id);
    manager::record_local(
        &app,
        cc.shared(),
        CcEvent::PermissionResolved {
            request_id,
            decision,
            // 用户亲手点的，永远不是 auto。
            auto: false,
        },
    );
    Ok(())
}

/// 中断这一轮。返回「是否真有一轮被打断」。
#[tauri::command]
pub async fn cc_interrupt(
    state: State<'_, Arc<AppState>>,
    session_id: u64,
) -> Result<bool, String> {
    let cc = state
        .cc
        .get(session_id)
        .ok_or_else(|| format!("会话不存在（内部 id {session_id}）"))?;
    Ok(cc.interrupt())
}

/// 快照：切页回来 / 断线重连时重建界面用。
#[tauri::command]
pub async fn cc_snapshot(
    state: State<'_, Arc<AppState>>,
    session_id: u64,
) -> Result<SnapshotDto, String> {
    let cc = state
        .cc
        .get(session_id)
        .ok_or_else(|| format!("会话不存在（内部 id {session_id}）"))?;
    Ok(cc.snapshot())
}

/// 上次那条会话的完整内容。**关掉 app 再打开**时用它。
///
/// 与 `cc_snapshot` 的分工：快照是「这个进程里发生过什么」（内存流水），
/// 恢复是「上次进程里发生过什么」（落盘的）。两者重叠时**以快照为准** ——
/// 活着的流水一定不比库里旧。判定放在前端（见 `useCcSession`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcRestore {
    /// 库里那一行的行号。
    ///
    /// 前端要它：侧栏「历史」区按它去重（这条已经在某个 pane 里开着，就不要再
    /// 摆一遍），关掉再点开也要认得是同一条。**新建的会话在首轮落盘之前是
    /// `None`** —— 那时它本来也还没进库。
    pub row_id: i64,
    /// 空串 = 本机。
    pub connection_id: String,
    pub cwd: Option<String>,
    /// 远端续聊必须的绝对路径。
    pub claude_path: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub session_id: Option<String>,
    /// 下一轮 `--resume` 要带的值。**没有它，恢复出来的对话发下一句就是新会话**。
    pub resume_id: Option<String>,
    pub title: Option<String>,
    /// 标题是用户手写的（`cc_rename_session` 写的）。前端据此决定「库里的标题」
    /// 能不能压过「首条消息派生的标题」。
    pub title_locked: bool,
    pub message_count: i64,
    /// 最后活跃时间（秒）。
    pub updated_at: i64,
    pub events: Vec<CcEvent>,
    /// 落盘时因超限被丢掉的事件数。`> 0` ⇒ 界面开头缺内容，必须提示。
    pub dropped: u64,
}

/// 读取并接管一条落盘的会话。
///
/// `row_id` 为 `None` = 最近那条（进页面自动恢复）；`Some` = 侧栏点开的那一行。
/// 两种都走同一条 `adopt` 路径 —— 三件套（row_id / facts / resume_id）漏一样
/// 就是一个静默故障，两套实现必然漂。
#[tauri::command]
pub async fn cc_restore(
    state: State<'_, Arc<AppState>>,
    session_id: u64,
    row_id: Option<i64>,
) -> Result<Option<CcRestore>, String> {
    let cc = state
        .cc
        .get(session_id)
        .ok_or_else(|| format!("会话不存在（内部 id {session_id}）"))?;
    // 用户点过「新对话」就不再**自动**拉旧的 —— 见 `Shared::suppress_restore`。
    // 明确给了行号的不受这条限制：那是用户在侧栏里主动点开的一条历史。
    if row_id.is_none() && cc.shared().restore_suppressed() {
        return Ok(None);
    }
    let row = {
        // 用完即放：`db` 是 tokio 的 `Mutex`，guard 不能跨 await 留着。
        let conn = state.db.lock().await;
        match row_id {
            Some(id) => store::by_row_id(&conn, id)?,
            None => store::latest(&conn)?,
        }
    };
    let Some(row) = row else { return Ok(None) };
    Ok(Some(with_leading_init(adopt(cc.shared(), row))))
}

/// 给恢复出来的事件流补一条开头的 `Init`（原来就有就原样返回）。
///
/// 为什么要补：库里的流水有体积上限，超限时**从头丢到一条用户消息为止** ——
/// 那时候第一条 `system/init` 早就被裁掉了。而前端的 `view.sessionId` / `view.cwd`
/// 全靠这条事件：
/// - `sessionId` 缺了 ⇒ 侧栏「历史」区对不上账，把**已经打开的那条**又摆一遍，
///   点它就会再开一个 pane，越点越多；
/// - 它还会被 `bookkeep` 用来确认 resume id。
///
/// 只补进返回给前端的 `events`，**不碰 `shared.ring`**：ring 的序号是前端事件
/// 游标的基准，凭空插一条会让之后每条的 `seq` 与前端预期错开一位。
/// （`cc_history_open` 那边补 Init 是 push 进 ring 的 —— 那条路径会把整段历史
/// 灌进 ring，语境不同，别把两处混起来。）
fn with_leading_init(mut out: CcRestore) -> CcRestore {
    if !matches!(out.events.first(), Some(CcEvent::Init { .. })) {
        let init = CcEvent::Init {
            session_id: out.session_id.clone().unwrap_or_default(),
            cwd: out.cwd.clone(),
            model: out.model.clone(),
        };
        out.events.insert(0, init);
    }
    out
}

/// 把库里读到的会话**接管**进内存，并翻成前端 DTO。
///
/// 单独成函数是为了能测「接管」这一步。三样东西少任何一样都是一个静默故障：
///
/// | 漏掉 | 症状 |
/// |---|---|
/// | `set_row_id` | 恢复后聊了几句，重开又回到恢复那一刻（新内容写进了另一行） |
/// | `set_facts` | 消息在、发出去却落到本机新会话上（远端会话最常见的踩法） |
/// | `set_resume_id` | 发下一句成了新会话，模型忘光前面 |
///
/// 三样全是「界面看起来正常」的那种错，只能靠测试守住。
fn adopt(shared: &crate::cc_session::Shared, row: crate::cc_session::store::Stored) -> CcRestore {
    // 🔴 必须把「当前会话就是这一行」写回内存。否则下一条消息会插入一条新会话，
    // 恢复出来的这条从此再不更新。
    shared.set_row_id(row.row_id);
    shared.set_facts(SessionFacts {
        connection_id: row.connection_id.clone(),
        cwd: row.cwd.clone(),
        claude_path: row.claude_path.clone(),
        model: row.model.clone(),
        permission_mode: row.permission_mode.clone(),
    });
    if let Some(id) = row.resume_id.as_deref() {
        // 只填空值：万一这个进程里已经有一条活着的会话链，不能让恢复覆盖它。
        shared.set_resume_id(id);
    }

    CcRestore {
        row_id: row.row_id,
        connection_id: row.connection_id,
        cwd: row.cwd,
        claude_path: row.claude_path,
        model: row.model,
        permission_mode: row.permission_mode,
        session_id: row.session_id,
        resume_id: row.resume_id,
        title: row.title,
        title_locked: row.title_locked,
        message_count: row.message_count,
        updated_at: row.updated_at,
        events: row.events,
        dropped: row.dropped,
    }
}

/// 侧栏「历史」区一次摆几条。
///
/// 30 的来历：240px 侧栏一屏大约放得下 12 行，30 条够翻两屏半；再多的会话
/// 用户也不会靠滚侧栏去找（那该用搜索）。后端上限仍是 `KEEP_SESSIONS`。
const DEFAULT_STORED_LIMIT: usize = 30;

/// 库里落盘过的会话摘要，新的在前。**不含正文**。
///
/// 与 `cc_history_list` 的分工见 `docs/批3-1c历史会话与同目录并发-2026-10-25.md`：
/// 这个只列「在对话页里聊过的」（有界面快照，所以能直接摆回侧栏），
/// 那个列 CLI 的全部转录（含终端页手敲 claude 产生的）。
#[tauri::command]
pub async fn cc_list_stored(
    state: State<'_, Arc<AppState>>,
    limit: Option<usize>,
    include_archived: Option<bool>,
) -> Result<Vec<store::Summary>, String> {
    let n = limit
        .unwrap_or(DEFAULT_STORED_LIMIT)
        .clamp(1, store::KEEP_SESSIONS);
    let conn = state.db.lock().await;
    store::list(&conn, n, include_archived.unwrap_or(false))
}

/// 给一条落盘会话改名（侧栏的「重命名」）。返回落库后的标题。
///
/// 改名写的是 `cc_sessions.title` 并打上 `title_locked`：下一次落盘会用首条用户
/// 消息重算标题，没有这个锁就等于每说一句话名字就被抹一次（见 `store::save`）。
///
/// 只认 `row_id`（库里的行），不认内部 id：改名是**对内容**的操作，而一条还没
/// 落过盘的新会话没有内容可命名 —— 前端那时不摆这个入口。
#[tauri::command]
pub async fn cc_rename_session(
    state: State<'_, Arc<AppState>>,
    row_id: i64,
    title: String,
) -> Result<String, String> {
    let conn = state.db.lock().await;
    store::rename(&conn, row_id, &title)
}

/// 归档 / 取消归档（侧栏的「归档」）。
///
/// 归档不是删除：只打一个时间戳，内容原样留在库里，用户随时能在「显示已归档」
/// 里把它捞回来。归档的会话不参与自动恢复（见 `store::latest`）。
#[tauri::command]
pub async fn cc_archive_session(
    state: State<'_, Arc<AppState>>,
    row_id: i64,
    archived: bool,
) -> Result<(), String> {
    let conn = state.db.lock().await;
    store::set_archived(&conn, row_id, archived)
}

/// 新对话：清流水 + 清 session id。
///
/// 请求 id / 缓冲都清掉，等于换了一条会话链。**只在用户点「新对话」时调**。
///
/// 内部 id 不变：reset 清的是「这条会话里发生过什么」，不是「这条会话本身」。
/// 多会话期每条 GUI 会话各清各的，id 照旧寻址。
#[tauri::command]
pub async fn cc_reset(state: State<'_, Arc<AppState>>, session_id: u64) -> Result<(), String> {
    let cc = state
        .cc
        .get(session_id)
        .ok_or_else(|| format!("会话不存在（内部 id {session_id}）"))?;
    cc.reset();
    Ok(())
}

/// 铸发一条新的对话会话，返回内部 id。
///
/// 前端进对话页时调一次，之后所有命令都带这个 id。**它不等价于 CC 的
/// session id**（那个只在 `system/init` 里出现）—— 它是「这一路对话」的
/// 稳定身份：事件分流、命令寻址、快照重放全按它。
///
/// 不设并发上限，见 [`crate::cc_session::CcSessions::new_session`]。
#[tauri::command]
pub async fn cc_new_session(state: State<'_, Arc<AppState>>) -> Result<u64, String> {
    Ok(state.cc.new_session())
}

/// 关掉一条会话（侧栏的「关闭会话」）。返回「是否真的关掉了一条」。
///
/// 顺序是**中断 → 落盘 → 摘表**，每一步都不能省：
/// - 先中断：摘表之后就没有句柄能再给这条会话发中断了，进程会变成没人管的孤儿；
/// - 再落盘：内容还在库里，3-1c 的「重启后从历史恢复」要靠它；
/// - 最后摘表：侧栏这条从此消失，`cc_snapshot`/`cc_send` 再带这个 id 会拿到
///   「会话不存在」，不会静默串到别的会话上。
///
/// 查不到就是 `Ok(false)` 而不是 `Err`：用户连点两下「关闭」不该看到报错。
#[tauri::command]
pub async fn cc_close_session(
    state: State<'_, Arc<AppState>>,
    session_id: u64,
) -> Result<bool, String> {
    let Some(cc) = state.cc.get(session_id) else {
        return Ok(false);
    };
    cc.interrupt();
    {
        let conn = state.db.lock().await;
        cc.persist(&conn);
    }
    Ok(state.cc.remove(session_id).is_some())
}

/// 润色的 SYSTEM 提示词。**逐字取自 `mods/prompt-polish/hooks/register.js`** ——
/// 那边是给终端用户的 mod 版本，这边是对话 GUI 的后端半边，两边必须同一份文案，
/// 改一处忘一处会让「同一个功能两种脾气」。
const POLISH_SYSTEM: &str = "你是提示词改写器。把用户给的草稿改写成一条更清晰、更可执行的编码任务提示词。\n要求：\n1. 只输出改写后的提示词本身，不要前言、解释、markdown 代码围栏。\n2. 保持用户原本的语言（中文草稿出中文），技术名词、路径、变量名逐字不变。\n3. 不要凭空添加用户没提过的需求、文件、验收标准；信息不足就保留原样。\n4. 补的是结构：目标、约束、验收。通常不超过原文 2.5 倍。";

/// 润色超时（秒）。`claude -p` 冷启动 + 生成，90s 对默认模型也够；
/// 到点强杀并报错 —— 一个按钮不该把界面挂住。
const POLISH_TIMEOUT_SECS: u64 = 90;

/// 草稿长度上限（字符）。再长就该拆文件了，润色也救不回来。
const POLISH_MAX_CHARS: usize = 20_000;

/// `cc_polish` 的入参。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcPolishReq {
    /// 空 = 本机跑。
    pub connection_id: Option<String>,
    pub cwd: Option<String>,
    /// 探测得到的 claude 绝对路径（可选）。给了就省一次探测。
    pub claude_path: Option<String>,
    pub draft: String,
}

/// 提示词润色 —— mods/prompt-polish 的后端半边。
///
/// ## 为什么是独立子进程而不是会话里的一句话
///
/// 润色是**界面的辅助动作**，不是对话内容：它不该进事件流水、不占会话上下文、
/// 不该让模型「记得」用户改写过草稿。所以走一次性 `claude -p --bare`，
/// 提示词经 stdin 进、结果从 stdout 出，进程随即退出。
///
/// 远端走 ssh 的 stdin 直达（见 `channel::polish_remote`），本机直跑。
#[tauri::command]
pub async fn cc_polish(
    state: State<'_, Arc<AppState>>,
    req: CcPolishReq,
) -> Result<String, String> {
    let draft = req.draft.trim().to_string();
    if draft.is_empty() {
        return Err("草稿不能为空".into());
    }
    if draft.chars().count() > POLISH_MAX_CHARS {
        return Err(format!(
            "草稿太长（{} 字符，上限 {POLISH_MAX_CHARS}），请先自行精简",
            draft.chars().count()
        ));
    }
    let prompt = format!("{POLISH_SYSTEM}\n\n用户草稿：\n{draft}");
    let conn_id = clean(req.connection_id);
    let cwd = clean(req.cwd);

    let launch = match conn_id {
        None => {
            let hint = clean(req.claude_path).unwrap_or_else(|| "claude".to_string());
            let (program, args) = channel::polish_local(&hint)?;
            // 留空 ⇒ 家用目录。与 `cc_start` 同义：不能让 agent 在安装目录里翻。
            let dir = cwd.as_deref().map(PathBuf::from).or_else(home_dir);
            if let Some(d) = dir.as_deref() {
                if !d.is_dir() {
                    return Err(format!("工作目录不存在：{}", d.display()));
                }
            }
            Launch {
                program,
                args,
                env: manager::git_bash_env(),
                cwd: dir,
            }
        }
        Some(id) => {
            if !state.config.read().await.ssh_enabled {
                return Err("SSH 终端未启用，无法在远端运行".into());
            }
            let (ssh_args, destination) = ssh_link_args(state.inner(), &id).await?;
            // 远端必须用绝对路径（非登录 bash 没有 `~/.local/bin` 的 PATH）。
            // 调用方给过就用；否则先探一次 —— 与 `cc_probe` 同一条路。
            let hint = match clean(req.claude_path) {
                Some(p) => p,
                None => {
                    let program = spawn::resolve_program("ssh")
                        .or_else(|_| spawn::resolve_program("ssh.exe"))
                        .map_err(|e| format!("未检测到系统 OpenSSH 客户端：{e}"))?;
                    let mut args = ssh_args.clone();
                    args.push("--".into());
                    args.push(destination.clone());
                    args.push(channel::probe_script().to_string());
                    let target = destination.clone();
                    let probe = tauri::async_runtime::spawn_blocking(move || {
                        probe_remote_sync(&program, &args, target)
                    })
                    .await
                    .map_err(|e| format!("探测任务失败：{e}"))?;
                    if !probe.found {
                        return Err(probe.message);
                    }
                    probe.path
                }
            };
            let (program, args) = channel::polish_remote(&ssh_args, &destination, &hint)?;
            // 远端 cwd 由调用方在本地判过存在性即可，ssh 不带 current_dir。
            Launch {
                program,
                args,
                env: Vec::new(),
                cwd: None,
            }
        }
    };

    // 🔴 外部进程必须走 spawn_blocking：`run_polish_sync` 里全是阻塞调用
    // （CLAUDE.md 的 `#[tokio::test]` 死锁教训 —— 占着 tokio worker 等子进程
    // 会把整个 runtime 挂住）。
    tauri::async_runtime::spawn_blocking(move || {
        run_polish_sync(launch, prompt, POLISH_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| format!("润色任务失败：{e}"))?
}

/// 跑一次性润色进程：stdin 喂提示词，stdout 收结果，超时强杀。
///
/// 为什么不用 `Command::output()`：它**没有超时**。claude 卡在登录/网络时
/// 这个调用会永远挂住，而它跑在阻塞线程池里 —— 池子被占满，别的阻塞操作
/// （落盘、探测）会跟着全停。
///
/// `timeout_secs` 是参数而不是常量：测试要用 1s 验证强杀路径，
/// 不可能等真常量 90s。
fn run_polish_sync(launch: Launch, prompt: String, timeout_secs: u64) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let mut cmd = hidden_command(&launch.program);
    cmd.args(&launch.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = launch.cwd.as_deref() {
        cmd.current_dir(dir);
    }
    for (k, v) in &launch.env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动 claude 失败：{e}"))?;
    // 提示词另起一条线程写：管道缓冲可能小于提示词（Windows 上只有几 KB），
    // 主线程直接 write_all 会互卡到超时。写完 drop 即 EOF，claude 这才开始读。
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
    }
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "润色超时（{timeout_secs}s 没返回），已中断。可重试或缩短草稿"
                    ));
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 claude 退出失败：{e}"));
            }
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("读取 claude 输出失败：{e}"))?;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        let last = tail
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("没有任何输出");
        return Err(format!("claude 退出码 {:?}：{last}", out.status.code()));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Err("润色没有返回内容（模型回了空）".into());
    }
    Ok(text)
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

    fn restore_of(events: Vec<CcEvent>) -> CcRestore {
        CcRestore {
            row_id: 1,
            connection_id: String::new(),
            cwd: Some("/proj".into()),
            claude_path: None,
            model: Some("opus".into()),
            permission_mode: None,
            session_id: Some("s-1".into()),
            resume_id: Some("s-1".into()),
            title: None,
            title_locked: false,
            message_count: 1,
            updated_at: 0,
            events,
            dropped: 0,
        }
    }

    /// 老流水可能因为体积裁剪丢了开头的 `system/init`。缺了它，前端
    /// `view.sessionId` 为空 ⇒ 侧栏历史区把已打开的会话又摆一遍（越点越多）。
    #[test]
    fn leading_init_is_synthesized_when_trimmed_away() {
        let out = with_leading_init(restore_of(vec![CcEvent::UserMessage {
            text: "旧问题".into(),
        }]));
        match out.events.first() {
            Some(CcEvent::Init {
                session_id, cwd, ..
            }) => {
                assert_eq!(session_id, "s-1");
                assert_eq!(cwd.as_deref(), Some("/proj"));
            }
            other => panic!("第一条必须是 Init，实际 {other:?}"),
        }
        assert_eq!(out.events.len(), 2, "原有事件不能丢");
    }

    /// 本来就有 Init 的（绝大多数）不能被补成两条。
    #[test]
    fn existing_init_is_not_duplicated() {
        let out = with_leading_init(restore_of(vec![
            CcEvent::Init {
                session_id: "s-1".into(),
                cwd: Some("/proj".into()),
                model: None,
            },
            CcEvent::UserMessage { text: "x".into() },
        ]));
        assert_eq!(out.events.len(), 2);
    }

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

    fn stored_row(resume: &str) -> crate::cc_session::store::Stored {
        crate::cc_session::store::Stored {
            row_id: 7,
            connection_id: "conn-1".into(),
            session_id: Some(resume.into()),
            resume_id: Some(resume.into()),
            cwd: Some("/home/u/proj".into()),
            claude_path: Some("/usr/bin/claude".into()),
            model: Some("m".into()),
            permission_mode: Some("acceptEdits".into()),
            title: Some("标题".into()),
            title_locked: false,
            preview: None,
            message_count: 3,
            updated_at: 1,
            archived_at: None,
            events: Vec::new(),
            dropped: 0,
        }
    }

    /// 恢复必须**接管**：行号、目标、session id 三样都要写回内存。
    ///
    /// 这三样漏任何一个都不会报错，只会让「恢复」变成一次性快照 ——
    /// 聊几句、重开，内容又回到恢复那一刻。
    #[test]
    fn restore_adopts_row_into_shared() {
        let shared = crate::cc_session::Shared::new();
        let dto = adopt(&shared, stored_row("s-1"));
        assert_eq!(shared.row_id(), Some(7), "必须接管行号");
        assert_eq!(
            shared.resume_id().as_deref(),
            Some("s-1"),
            "必须接管 session id"
        );
        assert_eq!(shared.facts().connection_id, "conn-1");
        assert_eq!(
            shared.facts().claude_path.as_deref(),
            Some("/usr/bin/claude"),
            "远端续聊靠这个绝对路径"
        );
        assert_eq!(dto.connection_id, "conn-1");
        assert_eq!(dto.message_count, 3);
    }

    /// 这个进程里已经有活着的会话链时，恢复**不能**把它的 id 顶掉。
    #[test]
    fn restore_does_not_steal_live_resume_id() {
        let shared = crate::cc_session::Shared::new();
        shared.set_resume_id("live-id");
        adopt(&shared, stored_row("stale-id"));
        assert_eq!(shared.resume_id().as_deref(), Some("live-id"));
    }

    // ---- 润色执行器（run_polish_sync） ----

    /// 占位进程：把 stdin 原样印到 stdout。
    ///
    /// Windows 用 `sort` 而不是 `findstr`：`findstr /R "^"` 经 cmd 的 `/C` 引号
    /// 规则会被啃掉（退出码 1、零输出）。`sort` 对**单行**输入是恒等映射，
    /// 也不像 `more` 那样做分页与制表符展开。
    #[cfg(windows)]
    fn echo_launch() -> Launch {
        Launch {
            program: PathBuf::from("cmd"),
            args: vec!["/C".into(), "sort".into()],
            env: Vec::new(),
            cwd: None,
        }
    }

    #[cfg(not(windows))]
    fn echo_launch() -> Launch {
        Launch {
            program: PathBuf::from("cat"),
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
        }
    }

    /// 提示词必须经 stdin 抵达、stdout 原样收回 —— 这是整个润色功能的命脉
    /// （argv 传会在 Windows 32767 上限处炸掉，见 `channel::POLISH_ARGS` 注释）。
    #[test]
    fn run_polish_sync_echoes_stdin_to_stdout() {
        // 单行：执行器对 stdout 做 trim，多行只会把断言复杂化（这里要验的是
        // 「提示词完整抵达」而不是「换行符原样保留」）
        let prompt = "把这段代码改成异步的";
        let out = run_polish_sync(echo_launch(), prompt.to_string(), 30).expect("回显进程必须成功");
        assert_eq!(out, prompt, "stdout 必须与 stdin 逐字一致");
    }

    /// 卡死的进程必须被强杀并报错，不能永远挂住（调用点在阻塞线程池里）。
    #[test]
    fn run_polish_sync_times_out_and_kills() {
        #[cfg(windows)]
        let launch = Launch {
            program: PathBuf::from("cmd"),
            // ~4s 的占位：1s 超时足够验证强杀，孤儿进程最多再活几秒。
            args: vec!["/C".into(), "ping -n 5 127.0.0.1".into()],
            env: Vec::new(),
            cwd: None,
        };
        #[cfg(not(windows))]
        let launch = Launch {
            program: PathBuf::from("sleep"),
            args: vec!["5".into()],
            env: Vec::new(),
            cwd: None,
        };
        let err = run_polish_sync(launch, "随便".into(), 1).expect_err("必须超时");
        assert!(err.contains("超时"), "{err}");
    }

    /// 退出码非零 = 失败，且 stderr 的尾巴要带给用户（登录过期只在 stderr 说）。
    ///
    /// 标记用 ASCII：cmd 的 echo 按 OEM 代码页（中文系统 GBK）写字节，中文断言
    /// 串回读是乱码；真的 claude CLI 由 Node 写 UTF-8，不受这个测试坑影响。
    #[test]
    fn run_polish_sync_reports_nonzero_exit() {
        #[cfg(windows)]
        let launch = Launch {
            program: PathBuf::from("cmd"),
            args: vec!["/C".into(), "echo POLISH_BOOM 1>&2 & exit 3".into()],
            env: Vec::new(),
            cwd: None,
        };
        #[cfg(not(windows))]
        let launch = Launch {
            program: PathBuf::from("sh"),
            args: vec!["-c".into(), "echo POLISH_BOOM 1>&2; exit 3".into()],
            env: Vec::new(),
            cwd: None,
        };
        let err = run_polish_sync(launch, "x".into(), 30).expect_err("必须报错");
        assert!(err.contains("退出码"), "{err}");
        assert!(err.contains("POLISH_BOOM"), "stderr 尾巴必须带上：{err}");
    }
}
