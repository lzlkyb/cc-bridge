//! 会话管理器：**唯一**持有「当前正在跑的轮次」的地方。
//!
//! ## 为什么状态放在 Rust 而不是 React
//!
//! `App.tsx` 的 `TabsContent value="ccgui"` 没有 `keepMounted`（终端页有），
//! 切到终端再回来组件就重新挂载、消息列表全丢。而进程活在 Rust 侧，
//! **只要 Rust 留一份事件流水，前端回来重放就能原样拼出来**（`ring.rs`）。
//!
//! 这条决定还顺手解决了 SSH 断线重连：连接断了前端一样什么都收不到，
//! 恢复后同样靠重放接上，不需要为「重连」单独写一套逻辑。
//!
//! ## 为什么 `resume_id` 由事件回填而不是调用方传
//!
//! `--resume` 要的是 CLI 自己的 `session_id`，它**只在 `system/init` 里出现**，
//! 启动前拿不到。所以第一轮必须空手启动，等 `Init` 事件回来后由 sink 记下来，
//! 第二轮才带上。写反了的表现是「每轮都是新会话，模型忘光前面」。
//!
//! ## 锁的粒度
//!
//! `live` 这把锁只在「起/停/写一行」时短暂持有，**绝不跨 IO 或等待**：
//! 写 stdin 是阻塞的，但 claude 的 stdin 管道从不写满（一行几十字节），
//! 真正会卡住的是 `wait`，而 `wait` 不在锁内。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::proto::CcEvent;
use super::ring::{EventRing, RingSnapshot};
use super::session::{EventSink, Run, Verdict};

/// 前端订阅的事件名。所有对话事件都从这里出去。
pub const CC_EVENT: &str = "cc-event";

/// `cc-event` 的载荷：**带序号**。
///
/// 🔴 序号不是装饰。前端重建界面的顺序是「先订阅、再拉快照、最后补漏」——
/// 订阅和快照之间一定会有一小段重叠，没有序号就只能靠时序猜哪些是重复的，
/// 而猜错的后果是消息重复一遍或丢一条，且只在慢机器上偶发。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcEventPayload {
    pub seq: u64,
    pub event: CcEvent,
}

/// 前端 `cc_snapshot` 的返回体。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDto {
    /// 缓冲的事件，按发生顺序重放。
    pub events: Vec<CcEvent>,
    /// 下一个事件的序号，前端做增量游标。
    pub next_seq: u64,
    /// `> 0` ⇒ 缓冲溢出，开头缺内容，界面必须提示「更早的已滚出」。
    pub dropped: u64,
    /// 现在有没有**正在进行的一轮**。
    ///
    /// 🔴 不是「进程还在不在」：`result` 之后 claude 进程会留在原地等 stdin
    /// （P0 探针结论），拿存活当忙碌会让「空闲」被误判成「进行中」。
    /// 判据见 [`snapshot_running`]。
    pub running: bool,
    /// 下一轮 `--resume` 会带上的 id（空 = 新会话）。
    pub resume_id: Option<String>,
}

/// 「现在有没有正在进行的一轮」= **进程活着 且 这一轮还没落定**。
///
/// 少写任何一半都会出事：
/// - 只看进程活着 ⇒ 轮次结束、进程还在等 stdin 时被误判成忙碌（真机实测：
///   切页回来一拉快照，界面就卡在「进行中」，发送按钮变灰、只能点中断杀进程）。
/// - 只看 `turn_active` ⇒ 进程意外死亡而 `Exit` 事件没到时会一直显示忙碌。
pub fn snapshot_running(process_alive: bool, turn_active: bool) -> bool {
    process_alive && turn_active
}

/// 贯穿一轮的共享单元：事件流水 + 会话 id。
///
/// 单独拆出来是因为**读线程（sink）也要写会话 id**，而它拿不到管理器的锁
/// （管理器要持有 `Run`，`Run` 又持有读线程 —— 直接互引会死锁）。
#[derive(Default)]
pub struct Shared {
    pub ring: EventRing,
    /// `Arc` 的原子替换由外层锁保护；用 `StdMutex<Option<String>>` 而不是
    /// `RwLock`：读频率低（每轮一次），换来的是不用处理 poison 的两种分支。
    pub resume_id: StdMutex<Option<String>>,
    /// 有没有**一轮正在进行**（已发消息、还没等到 `TurnEnd`）。
    ///
    /// 🔴 与「进程活着」是两件事：实测（2026-10-24）`--input-format stream-json`
    /// 下 CLI 收到 `result` 之后**不会退出**，它继续等 stdin 上的下一条消息。
    /// 所以「进程活着」只说明可以复用，不代表正在跑；拿它当忙碌判据会把
    /// 后续每一条消息都拒绝掉。
    turn_active: AtomicBool,
    /// 待批单：`request_id` → 工具原始入参。
    ///
    /// 🔴 存在这里是**为了不信任前端**：`allow` 必须把**完整入参**回给 CLI，
    /// 让前端把入参再传一遍，等于把「批准的是哪条命令」这个判据交给了一个可能
    /// 被旧状态污染的图层。sink 收到 `PermissionAsk` 时登记，批准/撤回时消费。
    pending: StdMutex<HashMap<String, serde_json::Value>>,
}

impl Shared {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn resume_id(&self) -> Option<String> {
        self.resume_id
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .filter(|s| !s.trim().is_empty())
    }

    fn set_resume_id(&self, id: &str) {
        if id.trim().is_empty() {
            return;
        }
        if let Ok(mut g) = self.resume_id.lock() {
            // 只覆盖空值：同一轮里 init 只会来一次，但重放/异常路径可能重复，
            // 后到的不能把先到的挤掉（CLI 只认最早那条链）。
            if g.as_deref().map(str::trim).unwrap_or("").is_empty() {
                *g = Some(id.to_string());
            }
        }
    }

    pub fn clear_resume(&self) {
        if let Ok(mut g) = self.resume_id.lock() {
            *g = None;
        }
    }

    pub fn turn_active(&self) -> bool {
        self.turn_active.load(Ordering::SeqCst)
    }

    pub fn set_turn_active(&self, on: bool) {
        self.turn_active.store(on, Ordering::SeqCst);
    }

    fn ask(&self, request_id: &str, input: &serde_json::Value) {
        if let Ok(mut g) = self.pending.lock() {
            g.insert(request_id.to_string(), input.clone());
        }
    }

    /// 取回待批单的入参。**不删除**：写失败（进程刚好退出）时用户还能再点一次。
    pub fn pending_input(&self, request_id: &str) -> Option<serde_json::Value> {
        self.pending.lock().ok()?.get(request_id).cloned()
    }

    pub fn forget(&self, request_id: &str) {
        if let Ok(mut g) = self.pending.lock() {
            g.remove(request_id);
        }
    }

    pub fn clear_pending(&self) {
        if let Ok(mut g) = self.pending.lock() {
            g.clear();
        }
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|g| g.len()).unwrap_or(0)
    }
}

/// 记一条**本地产生**的事件（用户自己的消息）。
///
/// 它必须走和 CLI 事件同一条流水：前端切页回来只认快照，本地消息不进流水就会消失。
pub fn record_local(app: &AppHandle, shared: &Shared, event: CcEvent) {
    let seq = shared.ring.push(event.clone()).unwrap_or(u64::MAX);
    let _ = app.emit(CC_EVENT, &CcEventPayload { seq, event });
}

/// 推到 Tauri 事件，同时落进环形缓冲。
pub struct TauriSink {
    app: AppHandle,
    shared: Arc<Shared>,
    /// 单调递增的事件序号，只用于日志排查「前端收到几条、丢没丢」。
    seen: AtomicU64,
}

impl TauriSink {
    pub fn new(app: AppHandle, shared: Arc<Shared>) -> Self {
        Self {
            app,
            shared,
            seen: AtomicU64::new(0),
        }
    }

    pub fn seen(&self) -> u64 {
        self.seen.load(Ordering::Relaxed)
    }
}

/// 事件对**共享状态**的副作用。与推事件分开，这样不用 `AppHandle` 就能测。
///
/// 顺序很重要：这里必须先于 `emit` 执行 —— 前端收到事件后可能立刻查快照，
/// 快照要能看到这条事件带来的状态变化（`resume_id` / 待批单）。
fn bookkeep(shared: &Shared, event: &CcEvent) {
    match event {
        CcEvent::Init { session_id, .. } => shared.set_resume_id(session_id),
        CcEvent::PermissionAsk {
            request_id, input, ..
        }
        | CcEvent::Question {
            request_id, input, ..
        } => shared.ask(request_id, input),
        CcEvent::PermissionCancel { request_id } => shared.forget(request_id),
        // 一轮结束（正常或崩溃）后，任何还挂着的待批单都**永远不会到达**了
        // —— CLI 那只 60s 计时器已经跟着这一轮结束。留着只会让卡片一直转圈。
        CcEvent::TurnEnd { .. } | CcEvent::Exit { .. } => {
            shared.clear_pending();
            // 落定「这一轮跑完了」。**不能靠进程退出**：进程会活着等下一条消息。
            shared.set_turn_active(false);
        }
        _ => {}
    }
}

impl EventSink for TauriSink {
    fn emit(&self, event: CcEvent) {
        bookkeep(&self.shared, &event);
        let seq = self.shared.ring.push(event.clone()).unwrap_or(u64::MAX);
        self.seen.fetch_add(1, Ordering::Relaxed);
        // 前端没在听是**正常**的（切到终端页时监听器已卸）。忽略错误，
        // 事件已经在 ring 里，回来靠快照重放。
        let _ = self.app.emit(CC_EVENT, &CcEventPayload { seq, event });
    }
}

/// 一轮启动需要的一切。
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
}

/// 对话会话管理器。
pub struct CcSession {
    shared: Arc<Shared>,
    live: StdMutex<Option<Run>>,
}

impl Default for CcSession {
    fn default() -> Self {
        Self::new()
    }
}

impl CcSession {
    pub fn new() -> Self {
        Self {
            shared: Shared::new(),
            live: StdMutex::new(None),
        }
    }

    pub fn shared(&self) -> &Arc<Shared> {
        &self.shared
    }

    pub fn is_running(&self) -> bool {
        self.live
            .lock()
            .map(|g| g.as_ref().map(Run::is_alive).unwrap_or(false))
            .unwrap_or(false)
    }

    /// 起一轮。已在跑则拒绝 —— 两个进程写同一份 `~/.claude/projects` 会互相踩。
    pub fn start(&self, launch: Launch, sink: Arc<dyn EventSink>) -> Result<(), String> {
        let mut guard = self.live.lock().map_err(|_| "会话状态已锁死".to_string())?;
        if let Some(run) = guard.as_ref() {
            if run.is_alive() {
                return Err("上一轮还在进行，请等它结束或先中断".into());
            }
        }
        // 上一轮已经死了（可能连 Exit 都没来），先把尸体收掉。
        if let Some(mut dead) = guard.take() {
            dead.kill();
        }
        let run = Run::start(
            &launch.program,
            &launch.args,
            &launch.env,
            launch.cwd.as_deref(),
            sink,
        )?;
        *guard = Some(run);
        // 上一轮残留的待批单在新一轮里永远不可能被满足（request_id 是上一轮进程的）。
        self.shared.clear_pending();
        Ok(())
    }

    pub fn send(&self, text: &str) -> Result<(), String> {
        let guard = self.live.lock().map_err(|_| "会话状态已锁死".to_string())?;
        let run = guard.as_ref().ok_or("当前没有进行中的对话")?;
        run.send_user(text)?;
        // 写成功才算「这一轮开始了」：写失败说明进程已经走了，别把界面锁在忙碌态。
        self.shared.set_turn_active(true);
        Ok(())
    }

    pub fn respond(&self, request_id: &str, verdict: &Verdict) -> Result<(), String> {
        let guard = self.live.lock().map_err(|_| "会话状态已锁死".to_string())?;
        let run = guard.as_ref().ok_or("这一轮已经结束，无法再批准")?;
        run.respond(request_id, verdict)
    }

    /// 中断：杀进程树，**保留已收到的内容**（ring 不清）。
    pub fn interrupt(&self) -> bool {
        let Ok(mut guard) = self.live.lock() else {
            return false;
        };
        match guard.as_mut() {
            Some(run) if run.is_alive() => {
                run.kill();
                self.shared.set_turn_active(false);
                true
            }
            _ => {
                self.shared.set_turn_active(false);
                false
            }
        }
    }

    pub fn snapshot(&self) -> SnapshotDto {
        let RingSnapshot {
            events,
            next_seq,
            dropped,
        } = self.shared.ring.snapshot();
        SnapshotDto {
            events,
            next_seq,
            dropped,
            running: snapshot_running(self.is_running(), self.shared.turn_active()),
            resume_id: self.shared.resume_id(),
        }
    }

    /// 新会话：清流水 + 清 session_id。**只在用户显式「新对话」时调用**。
    pub fn reset(&self) {
        let _ = self.interrupt();
        self.shared.ring.clear();
        self.shared.clear_resume();
        self.shared.clear_pending();
        if let Ok(mut guard) = self.live.lock() {
            drop(guard.take());
        }
    }
    /// 应用退出时收尾。宽限期短：用户已经关窗，多等没意义。
    pub fn shutdown(&self, grace: std::time::Duration) {
        if let Ok(mut guard) = self.live.lock() {
            if let Some(mut run) = guard.take() {
                run.shutdown(grace);
            }
        }
    }
}

/// 探到 `claude` 就返回绝对路径。**必须在启动前单独做一次**：
/// 失败时用户看到的是「没装 CLI」，而不是一条 ssh 超时。
pub fn probe_local(path_hint: &str) -> Result<String, String> {
    let p = crate::mcp::bridge::spawn::resolve_program(path_hint)
        .map_err(|e| format!("找不到 claude：{e}"))?;
    Ok(p.to_string_lossy().into_owned())
}

/// 本机启动参数：`claude` 直接吃 stdin/stdout。
///
/// `env` 里**不带** `TERM_PROGRAM` 之类的东西：claude 在 `--print` 模式下不看它们，
/// 乱设反而可能触发别的分支。唯一补的是 `CLAUDE_CODE_GIT_BASH_PATH`（见
/// [`git_bash_env`]）。
pub fn local_launch(claude_path: &str, args: Vec<String>, cwd: Option<&Path>) -> Launch {
    Launch {
        program: PathBuf::from(claude_path),
        args,
        env: git_bash_env(),
        cwd: cwd.map(Path::to_path_buf),
    }
}

/// claude 用来指定 Git Bash 路径的环境变量名。
#[cfg(windows)]
const GIT_BASH_ENV: &str = "CLAUDE_CODE_GIT_BASH_PATH";

/// 纯逻辑：算出要补的 env 项。
///
/// - `already_set`：用户自己已经设了 `CLAUDE_CODE_GIT_BASH_PATH` → 一律不覆盖，
///   那是他指定的 shell，优先级高于任何探测结果。
/// - `detected`：本机探测到的 `bash.exe`；`None` 就什么都不补（别写空值进去，
///   claude 会把空串当成「用户指定了一个无效路径」）。
#[cfg(windows)]
fn git_bash_env_from(already_set: bool, detected: Option<&Path>) -> Vec<(String, String)> {
    if already_set {
        return Vec::new();
    }
    match detected {
        Some(p) => vec![(GIT_BASH_ENV.to_string(), p.to_string_lossy().into_owned())],
        None => Vec::new(),
    }
}

/// 给 claude 补一个 `CLAUDE_CODE_GIT_BASH_PATH`。
///
/// ## 为什么必须补
///
/// Windows 上的 `claude.exe` 找 bash 只有三个来源：`C:\Program Files\Git\bin\bash.exe`、
/// `C:\Program Files (x86)\Git\bin\bash.exe`，以及这个环境变量 ——
/// **它既不读 `PATH`，也不读注册表 `HKLM\SOFTWARE\GitForWindows`**。
/// Git 装在别处（D 盘、Scoop、绿色版）时，claude 一律判定 "Git Bash not found"，
/// 于是所有 `.sh` 钩子都执行不了；warp 插件的权限审批钩子就在其中，它的失败被
/// 当成 block ⇒ **每一次工具调用都被挡在审批这一层**，用户看到的是「全废」。
///
/// cc-bridge 自己的 [`crate::mcp::tools::shell::detect_bash_exe`] 有三级兜底
/// （常见路径 → Scoop → `where git` 倒推），这里把它的结果透传过去，
/// 让「命令执行壳层」和「cli 自己的 BashTool」用同一个 bash。
#[cfg(windows)]
fn git_bash_env() -> Vec<(String, String)> {
    git_bash_env_from(
        std::env::var_os(GIT_BASH_ENV).is_some(),
        crate::mcp::tools::shell::detect_bash_exe().as_deref(),
    )
}

/// 非 Windows：bash 是系统自带的，claude 自己找得到，不需要接管。
#[cfg(not(windows))]
fn git_bash_env() -> Vec<(String, String)> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Collect(Mutex<Vec<CcEvent>>);

    impl EventSink for Collect {
        fn emit(&self, event: CcEvent) {
            if let Ok(mut v) = self.0.lock() {
                v.push(event);
            }
        }
    }

    /// sink 收到 `Init` 必须把 session_id 记下来 —— 这是 `--resume` 的唯一来源。
    #[test]
    fn init_updates_resume_id() {
        let shared = Shared::new();
        // 直接模拟 TauriSink 的前半步（emit 到 AppHandle 那一步在测试里没有）。
        shared.set_resume_id("s-abc");
        assert_eq!(shared.resume_id().as_deref(), Some("s-abc"));
    }

    /// 后到的 Init 不能挤掉先到的：重放路径可能重复投递。
    #[test]
    fn later_init_does_not_overwrite() {
        let shared = Shared::new();
        shared.set_resume_id("first");
        shared.set_resume_id("second");
        assert_eq!(shared.resume_id().as_deref(), Some("first"));
    }

    #[test]
    fn blank_resume_id_is_ignored() {
        let shared = Shared::new();
        shared.set_resume_id("   ");
        assert!(shared.resume_id().is_none());
    }

    #[test]
    fn snapshot_reports_idle_initially() {
        let s = CcSession::new();
        let snap = s.snapshot();
        assert!(!snap.running);
        assert!(snap.events.is_empty());
        assert!(snap.resume_id.is_none());
    }

    #[test]
    fn respond_without_run_is_an_error_not_a_panic() {
        let s = CcSession::new();
        let err = s
            .respond("r-1", &Verdict::deny("nope"))
            .expect_err("没有进程时必须报错");
        assert!(err.contains("结束") || err.contains("没有"), "{err}");
    }

    #[test]
    fn send_without_run_is_an_error() {
        let s = CcSession::new();
        assert!(s.send("hi").is_err());
    }

    #[test]
    fn interrupt_when_idle_returns_false() {
        let s = CcSession::new();
        assert!(!s.interrupt());
    }

    #[test]
    fn reset_clears_everything() {
        let s = CcSession::new();
        s.shared.ring.push(CcEvent::Exit { code: Some(0) });
        s.shared.set_resume_id("s-1");
        s.shared
            .ask("r-1", &serde_json::json!({"command": "rm -rf /"}));
        s.reset();
        let snap = s.snapshot();
        assert!(snap.events.is_empty());
        assert!(snap.resume_id.is_none());
        assert_eq!(s.shared.pending_count(), 0, "待批单必须一起清掉");
    }

    /// 批准回写靠这份登记表取入参 —— 不能靠前端再传一遍。
    #[test]
    fn pending_input_roundtrip() {
        let shared = Shared::new();
        let input = serde_json::json!({"command": "ls", "cwd": "/tmp"});
        shared.ask("r-7", &input);
        assert_eq!(shared.pending_input("r-7"), Some(input));
        // 取不删除：写失败时用户还能再点一次。
        assert!(shared.pending_input("r-7").is_some());
        shared.forget("r-7");
        assert!(shared.pending_input("r-7").is_none());
    }

    #[test]
    fn unknown_request_has_no_input() {
        let shared = Shared::new();
        assert!(shared.pending_input("never-seen").is_none());
    }

    /// 收集型 sink 用来验证 `EventSink` 的 dyn 分发能工作。
    #[test]
    fn sink_trait_object_is_usable() {
        let sink: Arc<dyn EventSink> = Arc::new(Collect::default());
        sink.emit(CcEvent::Exit { code: None });
    }

    /// 🔴 实测事实：CLI 收到 `result` 后**不退出**，继续等 stdin。
    /// 所以「这一轮跑完了」必须由 `TurnEnd` 落定，而不是进程退出。
    /// 写反了的表现是第二条消息被永远拒绝（界面说「上一轮还在进行」）。
    #[test]
    fn turn_end_clears_busy_even_if_process_stays_alive() {
        let shared = Shared::new();
        shared.set_turn_active(true);
        bookkeep(
            &shared,
            &CcEvent::TurnEnd {
                session_id: Some("s".into()),
                is_error: false,
                text: None,
                usage: None,
                cost_usd: None,
                num_turns: None,
                duration_ms: None,
            },
        );
        assert!(!shared.turn_active(), "TurnEnd 之后必须不再忙碌");
    }

    /// 崩溃路径：只有 Exit，没有 result。同样要落定。
    #[test]
    fn exit_also_clears_busy() {
        let shared = Shared::new();
        shared.set_turn_active(true);
        bookkeep(&shared, &CcEvent::Exit { code: Some(1) });
        assert!(!shared.turn_active());
    }

    /// 待批单在一轮结束时清空：那些 request_id 属于已经结束的进程，
    /// 留着只会让卡片永远转圈。
    #[test]
    fn turn_end_drops_pending_asks() {
        let shared = Shared::new();
        bookkeep(
            &shared,
            &CcEvent::PermissionAsk {
                request_id: "r1".into(),
                tool_name: "Bash".into(),
                input: serde_json::json!({"command": "ls"}),
                tool_use_id: None,
                reason: None,
            },
        );
        assert_eq!(shared.pending_count(), 1);
        bookkeep(&shared, &CcEvent::Exit { code: None });
        assert_eq!(shared.pending_count(), 0);
    }

    /// 中间的流式事件不能碰忙碌标志 —— 否则第二条消息会在回答中途被允许。
    #[test]
    fn ordinary_events_do_not_clear_busy() {
        let shared = Shared::new();
        shared.set_turn_active(true);
        bookkeep(
            &shared,
            &CcEvent::Text {
                block_id: "m:0".into(),
                text: "hi".into(),
                streaming: true,
            },
        );
        assert!(shared.turn_active(), "流式碎片不应结束这一轮");
    }

    // ---- Git Bash 透传（CLAUDE_CODE_GIT_BASH_PATH） ----

    #[cfg(windows)]
    #[test]
    fn user_supplied_bash_path_is_not_overridden() {
        // 用户自己设过就一个字都不能改：那是他指定的 shell。
        let got = git_bash_env_from(true, Some(Path::new(r"C:\anywhere\bin\bash.exe")));
        assert!(got.is_empty(), "已设置时必须完全不介入，实际 {got:?}");
    }

    #[cfg(windows)]
    #[test]
    fn detected_bash_is_passed_through_verbatim() {
        let got = git_bash_env_from(false, Some(Path::new(r"D:\AItool\Git\bin\bash.exe")));
        assert_eq!(
            got,
            vec![(
                "CLAUDE_CODE_GIT_BASH_PATH".to_string(),
                r"D:\AItool\Git\bin\bash.exe".to_string()
            )]
        );
    }

    #[cfg(windows)]
    #[test]
    fn missing_bash_adds_no_empty_value() {
        // 关键：不能写空串。claude 会把空值当成「用户指定了一个无效路径」报错，
        // 那比不设更糟。
        assert!(git_bash_env_from(false, None).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn local_launch_matches_this_machine_state() {
        // 真机冒烟：防止「函数写好了但没接进 local_launch」。
        let launch = local_launch("claude", Vec::new(), None);
        match crate::mcp::tools::shell::detect_bash_exe() {
            None => assert!(
                launch.env.is_empty(),
                "没探测到 bash 时不该硬塞路径，实际 {:?}",
                launch.env
            ),
            Some(detected) => {
                if std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").is_some() {
                    assert!(launch.env.is_empty(), "进程已设该变量时必须让位");
                } else {
                    assert_eq!(launch.env.len(), 1);
                    assert_eq!(launch.env[0].0, "CLAUDE_CODE_GIT_BASH_PATH");
                    assert_eq!(launch.env[0].1, detected.to_string_lossy());
                }
            }
        }
    }

    // ---- 快照里的 running（切页重放的根，别只看进程存活） ----

    #[test]
    fn snapshot_running_requires_both_halves() {
        // 进程活着但这一轮已经落定 —— 唯一需要小心的一种：正是它把界面卡成「进行中」。
        assert!(!snapshot_running(true, false));
        assert!(!snapshot_running(false, true));
        assert!(!snapshot_running(false, false));
        assert!(snapshot_running(true, true));
    }

    #[test]
    fn idle_process_does_not_look_busy_in_snapshot() {
        // 直接对着真实管理器验：没有进程时快照必须说「闲」。
        let s = CcSession::new();
        s.shared().set_turn_active(false);
        assert!(!s.snapshot().running);
        // 反过来：没有进程时哪怕 turn_active 被误置 true，也不能报忙碌。
        s.shared().set_turn_active(true);
        assert!(!s.snapshot().running);
    }

    /// 真的起一个长命进程，验证「进程活着但这一轮没在跑」时快照必须说闲。
    ///
    /// 这条是 [`snapshot_running`] 的**接线守卫**：把 `snapshot()` 改回
    /// `self.is_running()` 它立刻红。没有它，前两条测试在无进程环境下两种写法都通过。
    #[test]
    fn live_process_with_no_active_turn_is_idle() {
        let s = CcSession::new();
        let sink: Arc<dyn EventSink> = Arc::new(Collect::default());
        // 起一个足够久、又不需要交互的占位进程。
        #[cfg(windows)]
        let (program, args) = (
            "cmd",
            vec!["/C".to_string(), "ping -n 20 127.0.0.1".to_string()],
        );
        #[cfg(not(windows))]
        let (program, args) = ("sleep", vec!["20".to_string()]);
        let launch = Launch {
            program: PathBuf::from(program),
            args,
            env: Vec::new(),
            cwd: None,
        };
        s.start(launch, sink).expect("占位进程必须起得来");
        assert!(s.is_running(), "进程应该还活着");

        s.shared().set_turn_active(false);
        assert!(
            !s.snapshot().running,
            "进程活着但这一轮已经落定 ⇒ 快照必须说闲（否则切页回来界面卡在进行中）"
        );

        s.shared().set_turn_active(true);
        assert!(s.snapshot().running, "这一轮在跑 ⇒ 快照必须说忙");

        s.interrupt();
    }
}
