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

use dashmap::DashMap;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::autoapprove;
use super::proto::CcEvent;
use super::ring::{EventRing, RingSnapshot};
use super::session::{EventSink, Run, Transport, UserImage, Verdict};
use super::store::{self, SessionFacts};
use super::usage::{self, CcUsage};
use crate::state::AppState;

/// 前端订阅的事件名。所有对话事件都从这里出去。
pub const CC_EVENT: &str = "cc-event";

/// `cc-event` 的载荷：**带序号**。
///
/// 🔴 序号不是装饰。前端重建界面的顺序是「先订阅、再拉快照、最后补漏」——
/// 订阅和快照之间一定会有一小段重叠，没有序号就只能靠时序猜哪些是重复的，
/// 而猜错的后果是消息重复一遍或丢一条，且只在慢机器上偶发。
///
/// `session_id` 是**我们自己的内部 id**（`CcSessions::new_session` 铸发的单调
/// u64），不是 CC 的 resume id —— 那个只在 `system/init` 里出现，启动那一刻
/// 还拿不到，而路由从第一条事件起就需要它。多会话并存时前端按它分流；
/// 单会话期前端只认自己那一条，其余原样忽略。
///
/// `#[serde(default)]` 是给**旧前端**的兼容：3-1a 前后端同一个发版，但开发时
/// 前端热重载可能早于后端重启完成，缺字段时按 0 处理（0 不是任何合法 id，
/// `CcSessions` 从 1 开始铸发 ⇒ 旧前端的过滤只会丢事件，不会错认别人的）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcEventPayload {
    pub seq: u64,
    /// 内部会话 id。见结构体注释。
    #[serde(default)]
    pub session_id: u64,
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
    /// **我们自己的**内部会话 id（`CcSessions` 铸发的单调 u64）。
    ///
    /// 与 `resume_id`（CC 的 session id，只在 `system/init` 出现）是两回事：
    /// 那个启动那一刻还拿不到，而事件路由从第一条事件起就需要一个稳定身份。
    ///
    /// `Default` 给 0 ⇒ 「未设置」。`CcSessions` 从 1 开始铸发，所以 0 永远
    /// 查不到 —— 测试里裸构造的 `Shared` 落在这个格子里，正好不进任何路由。
    internal_id: AtomicU64,
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
    /// 待批单：`request_id` → 工具原始入参（外加「能不能补 answers」的判据）。
    ///
    /// 🔴 存在这里是**为了不信任前端**：`allow` 必须把**完整入参**回给 CLI，
    /// 让前端把入参再传一遍，等于把「批准的是哪条命令」这个判据交给了一个可能
    /// 被旧状态污染的图层。sink 收到 `PermissionAsk` 时登记，批准/撤回时消费。
    pending: StdMutex<HashMap<String, PendingAsk>>,
    /// 这一轮「在哪跑、用什么模型」—— 落盘和恢复都要它。
    ///
    /// 🔴 `claude_path` / `connection_id` / `cwd` 三者共同决定「下一轮能不能接着聊」：
    /// 远端续聊是非登录 bash，没有绝对路径就等于「远端没装 claude」；没有 cwd
    /// 就没有远端工作目录；没有 connection_id 就不知道该 ssh 到哪台机器。
    facts: StdMutex<SessionFacts>,
    /// 当前会话在 `cc_sessions` 里的行号。`None` = 还没落过盘（下一轮插入新行）。
    row_id: StdMutex<Option<i64>>,
    /// 落盘代次。见 [`persist_later`]：写入线程靠它丢弃过期的落盘任务。
    persist_gen: AtomicU64,
    /// 用户**主动**开了新对话吗。一旦为 true，`cc_restore` 就不再返回旧会话。
    ///
    /// 为什么需要它：`ring.clear()` 会把事件序号归零，前端据此判断「这个进程还
    /// 什么都没产生」——而**冷启动也是这个状态**，两者从流水上看完全一样。
    /// 不分清楚的话，用户点「新对话」、切到终端页再切回来，旧对话就会自己冒出来。
    suppress_restore: AtomicBool,
    /// 最近一轮 `TurnEnd` 的累计用量（`modelUsage` 求和）。
    ///
    /// 放在共享态而不是顺着事件往下传：`persist_shared` 只拿得到 `&Shared`，
    /// 而用量长在事件里。这样同步退出路径与异步落盘路径读到的是同一份。
    /// 清零时机只有 `reset()`（换了一条会话链，旧账不该跟过去）。
    usage: StdMutex<Option<CcUsage>>,
    /// 事件「push 进 ring + emit 给前端」这一整段的顺序锁。
    ///
    /// 读线程（[`TauriSink::emit`]）与命令线程（[`record_local`]）都会做这两步；
    /// 每一步各自原子、两步合起来却可能跨线程交错 —— seq=n 的 emit 晚于
    /// seq=n+1 到达时，前端的单向去重会把 n 当重复丢掉（实例：`PermissionResolved`
    /// 丢失 ⇒ 审批卡永远「等待中」）。把这俩动作绑进同一临界区，emit 的到达顺序
    /// 就与 seq 严格一致。
    ///
    /// 🔴 临界区**不得**包含 `maybe_auto_approve`：它会再走 `record_local` 拿同一把锁，
    /// `std::sync::Mutex` 不可重入，多持一步就是死锁。
    emit_order: StdMutex<()>,
}

/// 一条待批请求。
///
/// `accepts_answers` 在**登记那一刻**由事件类型定死（只有 `AskUserQuestion` 是 true），
/// 而不是等 `cc_respond` 时再问前端「这是什么工具」—— 那样前端一句谎话就能给
/// `Bash` 的入参塞进去任意字段。
#[derive(Debug, Clone, Default)]
pub struct PendingAsk {
    /// `true` = 这是提问，允许把用户的回答写进 `updatedInput.answers`。
    pub accepts_answers: bool,
    /// 工具原始入参，批准时原样回传（除非上一条为 true 且带了回答）。
    pub input: serde_json::Value,
}

impl Shared {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 内部会话 id。0 = 还没归进 `CcSessions`（测试裸构造的 shared）。
    pub fn internal_id(&self) -> u64 {
        self.internal_id.load(Ordering::SeqCst)
    }

    /// 铸发时由 `CcSessions::new_session` 设入，**只设一次**（后到者忽略）。
    pub fn set_internal_id(&self, id: u64) {
        // 比较交换：并发下也只有一个赢家，且不覆盖已有值。
        let _ = self
            .internal_id
            .compare_exchange(0, id, Ordering::SeqCst, Ordering::SeqCst);
    }

    pub fn resume_id(&self) -> Option<String> {
        self.resume_id
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .filter(|s| !s.trim().is_empty())
    }

    /// 记下 session id（`system/init` 给的那个）。
    ///
    /// 公开是因为 `cc_restore` 要把库里的值填回来 —— 少了它，恢复出来的对话
    /// 发下一句就成了新会话，模型忘光前面。
    pub fn set_resume_id(&self, id: &str) {
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

    fn ask(&self, request_id: &str, accepts_answers: bool, input: &serde_json::Value) {
        if let Ok(mut g) = self.pending.lock() {
            g.insert(
                request_id.to_string(),
                PendingAsk {
                    accepts_answers,
                    input: input.clone(),
                },
            );
        }
    }

    /// 取回待批单。**不删除**：写失败（进程刚好退出）时用户还能再点一次。
    pub fn pending_ask(&self, request_id: &str) -> Option<PendingAsk> {
        self.pending.lock().ok()?.get(request_id).cloned()
    }

    /// 只要入参（大多数调用方）。
    pub fn pending_input(&self, request_id: &str) -> Option<serde_json::Value> {
        self.pending_ask(request_id).map(|a| a.input)
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

    /// 记下这一轮的目标信息。`cc_start` 在起进程前调一次。
    pub fn set_facts(&self, facts: SessionFacts) {
        if let Ok(mut g) = self.facts.lock() {
            *g = facts;
        }
    }

    pub fn facts(&self) -> SessionFacts {
        self.facts.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// 本次请求的目标和「当前这条会话链」一致吗。
    ///
    /// 只比 `connection_id` 与 `cwd`：模型和权限模式变了**不该**重开会话链
    /// （CLI 支持同一会话换模型，权限模式更是每轮都能改）。但换了机器或目录就必须
    /// 重开 —— 转录在 CLI 那边是按「机器 + 目录」分开存的，跨目标 `--resume`
    /// 一定找不到会话。
    ///
    /// 尾部斜杠必须抹平：前端从 localStorage 读回来的 `D:\proj\` 与 `D:\proj`
    /// 是同一个目录，判成不同会让用户每切一次页就多出一条会话记录。
    pub fn same_target(&self, connection_id: &str, cwd: Option<&str>) -> bool {
        let facts = self.facts();
        let norm = |v: &str| v.trim().trim_end_matches(['/', '\\']).to_string();
        norm(&facts.connection_id) == norm(connection_id)
            && facts.cwd.as_deref().map(norm) == cwd.map(norm)
    }

    pub fn row_id(&self) -> Option<i64> {
        self.row_id.lock().ok().and_then(|g| *g)
    }

    pub fn set_row_id(&self, id: i64) {
        if let Ok(mut g) = self.row_id.lock() {
            *g = Some(id);
        }
    }

    /// 忘掉「当前是库里哪一行」。点「新对话」时用：下一轮插入一条新会话，
    /// 旧会话留在表里（那是历史，不能因为开了新的就消失）。
    pub fn clear_row(&self) {
        if let Ok(mut g) = self.row_id.lock() {
            *g = None;
        }
    }

    /// 用户显式开了新对话 ⇒ 不再允许从库里「恢复上次那条」。
    pub fn mark_new_session(&self) {
        self.suppress_restore.store(true, Ordering::SeqCst);
    }

    pub fn restore_suppressed(&self) -> bool {
        self.suppress_restore.load(Ordering::SeqCst)
    }

    /// 记下这一轮的累计用量。由 `bookkeep` 在 `TurnEnd` 上调。
    ///
    /// 🔴 覆盖而不是累加：CLI 的 `modelUsage` 给的就是累计值（见 `usage.rs` 模块文档）。
    pub fn set_usage(&self, usage: CcUsage) {
        if let Ok(mut g) = self.usage.lock() {
            *g = Some(usage);
        }
    }

    pub fn usage(&self) -> Option<CcUsage> {
        self.usage.lock().ok().and_then(|g| g.clone())
    }
}

/// 把当前会话写进库。返回行号；没有内容可写时返回 `None`。
///
/// 同步版本。异步路径见 [`persist_later`]；**应用退出时用这个** ——
/// 那一刻必须保证写下去，异步任务可能还没轮到就随进程消失了。
pub fn persist_shared(conn: &Connection, shared: &Shared) -> Result<Option<i64>, String> {
    let events = shared.ring.snapshot().events;
    if events.is_empty() {
        // 从没聊过（比如刚开新对话就退出）—— 不要往库里插一条空会话。
        return Ok(None);
    }
    // 期一里 `session_id` 与 `resume_id` 同源（都是 CLI 的 `system/init` 给的）。
    // 期二打开历史后两者才分岔：`session_id` 是这条转录的身份，`resume_id` 是
    // 下一轮 `--resume` 要带的值。
    let sid = shared.resume_id();
    let snap = shared.facts().snapshot(sid.clone(), sid, events);
    let id = store::save(conn, shared.row_id(), &snap)?;
    shared.set_row_id(id);
    // 用量账：覆盖写同一行（累计值），失败只警告——它是锦上添花的统计，
    // 不能反过来把「会话内容落盘」这件事带崩。
    // `sid` 已在上面被 `snapshot()` 移走，这里按值再取一次。
    if let (Some(sid), Some(usage)) = (shared.resume_id(), shared.usage()) {
        let conn_id = shared.facts().connection_id.clone();
        if let Err(e) = usage::record(conn, &sid, &conn_id, &usage) {
            log::warn!("会话用量落库失败：{e}");
        }
    }
    Ok(Some(id))
}

/// 异步落盘：**不占读线程**。
///
/// 🔴 为什么必须换线程拿 `db` 锁：调用点之一是 `TauriSink::emit`，它跑在 claude
/// 的 stdout 读线程上。那条线程一停，claude 的管道就会写满 → 整个 CLI 卡住 →
/// 界面表现为「对话莫名不动了」。落盘只是件锦上添花的事，绝不能让它反过来冻住
/// 主流程，所以哪怕一次慢查询也不行。
///
/// 🔴 代次检查必须在**锁内**：两次落盘（用户消息一次、`TurnEnd` 一次）可能乱序
/// 完成，锁外检查挡不住「先拿锁的是旧代次」。丢掉中间态无所谓，最后态必须落地。
pub fn persist_later(app: &AppHandle, shared: &Arc<Shared>) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let gen = shared.persist_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let st = Arc::clone(&*state);
    let sh = Arc::clone(shared);
    std::thread::spawn(move || {
        // `blocking_lock` 只能在非 runtime 线程上用 —— 这里正是自建的 std 线程，
        // 所以安全。改成 `.lock().await` 就需要 async 上下文，而调用方之一
        // （stdout 读线程）根本没有 runtime。
        let conn = st.db.blocking_lock();
        if sh.persist_gen.load(Ordering::SeqCst) != gen {
            return;
        }
        match persist_shared(&conn, &sh) {
            Ok(_) => {
                // 顺手清理：会话数只增不减会把库撑大，保留最近 100 条足够。
                if let Err(e) = store::prune(&conn, store::KEEP_SESSIONS) {
                    log::warn!("清理旧会话失败：{e}");
                }
            }
            Err(e) => log::warn!("会话落盘失败：{e}"),
        }
    });
}

/// 记一条**本地产生**的事件（用户自己的消息）。
///
/// 它必须走和 CLI 事件同一条流水：前端切页回来只认快照，本地消息不进流水就会消失。
///
/// 顺带落盘：用户发完消息立刻关掉 app 是最常见的「丢内容」场景，
/// 光等 `TurnEnd` 的话这一句就白打了。
pub fn record_local(app: &AppHandle, shared: &Arc<Shared>, event: CcEvent) {
    // push + emit 绑成原子（与读线程的 TauriSink::emit 互斥），见 `Shared::emit_order`。
    let _order = shared.emit_order.lock().ok();
    let seq = shared.ring.push(event.clone()).unwrap_or(u64::MAX);
    let _ = app.emit(
        CC_EVENT,
        &CcEventPayload {
            seq,
            session_id: shared.internal_id(),
            event,
        },
    );
    drop(_order);
    persist_later(app, shared);
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
        } => shared.ask(request_id, false, input),
        // 提问是**唯一**允许回传 `answers` 的请求：协议里答案就走
        // `updatedInput.answers`，不是另一条通道（2026-10-24 真机探针确认）。
        CcEvent::Question {
            request_id, input, ..
        } => shared.ask(request_id, true, input),
        CcEvent::PermissionCancel { request_id } => shared.forget(request_id),
        // 一轮结束（正常或崩溃）后，任何还挂着的待批单都**永远不会到达**了
        // —— CLI 那只 60s 计时器已经跟着这一轮结束。留着只会让卡片一直转圈。
        CcEvent::TurnEnd { .. } | CcEvent::Exit { .. } => {
            shared.clear_pending();
            // 落定「这一轮跑完了」。**不能靠进程退出**：进程会活着等下一条消息。
            shared.set_turn_active(false);
            // 用量账：只有正常结束的 `TurnEnd` 带 `modelUsage`（`Exit` 是崩溃路径，
            // 那一轮没有 result 行，没有可信用量）。`turns` 取 CLI 的累计值，
            // 它缺失时保留上一轮的数——不清零，否则余量条会在一轮之间闪没。
            if let CcEvent::TurnEnd {
                model_usage: Some(mu),
                num_turns,
                ..
            } = event
            {
                let mut u = usage::from_model_usage(mu);
                u.turns = num_turns.unwrap_or(u.turns);
                shared.set_usage(u);
            }
        }
        _ => {}
    }
}

impl EventSink for TauriSink {
    fn emit(&self, event: CcEvent) {
        bookkeep(&self.shared, &event);
        // 一轮落定（正常结束 / 进程退出）就把内容写下去。
        // `Exit` 也要：崩在 `result` 之前的那半轮同样是用户打出来的东西。
        let settled = matches!(event, CcEvent::TurnEnd { .. } | CcEvent::Exit { .. });
        {
            // push + emit 绑成原子（与命令线程的 record_local 互斥），见
            // `Shared::emit_order`。临界区到这里为止 —— 下面的 autoapprove 会再走
            // record_local 拿同一把锁，std::sync::Mutex 不可重入。
            let _order = self.shared.emit_order.lock().ok();
            let seq = self.shared.ring.push(event.clone()).unwrap_or(u64::MAX);
            self.seen.fetch_add(1, Ordering::Relaxed);
            // 前端没在听是**正常**的（切到终端页时监听器已卸）。忽略错误，
            // 事件已经在 ring 里，回来靠快照重放。
            let _ = self.app.emit(
                CC_EVENT,
                &CcEventPayload {
                    seq,
                    session_id: self.shared.internal_id(),
                    event: event.clone(),
                },
            );
        }
        // 审批规则命中就在这条 Ask 进流水**之后**代替用户回 allow：前端会先看到
        // 卡片、再收到一条 auto 的 Resolved，卡片自己落定成「已自动放行」。
        // 🔴 只对 PermissionAsk 生效：Question（AskUserQuestion）的答案只能用户给。
        if let CcEvent::PermissionAsk {
            request_id,
            tool_name,
            input,
            ..
        } = &event
        {
            self.maybe_auto_approve(request_id, tool_name, input);
        }
        if let CcEvent::TurnEnd { is_error, text, .. } = &event {
            self.notify_turn_end(*is_error, text.as_deref());
        }
        if settled {
            persist_later(&self.app, &self.shared);
        }
    }
}

/// 这条 Ask 要不要自动放行。**纯函数**，抽出来是为了能脱离 AppHandle 测接线。
///
/// 返回 `Some(规则原文)` = 放行（原文进日志，用户得知道是哪一条放的行）。
/// 三条 fail-closed：空规则表、没有规则命中、`AskUserQuestion` ——
/// 最后一条是**纵深防御**：调用方本来就只对 `PermissionAsk` 调它，
/// 这里再挡一次，免得将来有人把 Question 也接上来还不知道。
pub fn auto_approve_hit(
    rules: &[String],
    tool_name: &str,
    input: &serde_json::Value,
) -> Option<String> {
    if rules.is_empty() || tool_name == "AskUserQuestion" {
        return None;
    }
    autoapprove::RuleSet::compile(rules)
        .match_rule(tool_name, input)
        .map(str::to_string)
}

impl TauriSink {
    /// 读一条配置的**当前值**。读线程（stdout 泵）专用：
    /// `try_read` 拿不到锁（正在保存配置）时返回 `None` = 按关闭处理 ——
    /// 那条线程一停，claude 的 stdout 管道就会写满、整个 CLI 卡住。
    fn config_flag(&self, pick: impl Fn(&crate::config::BridgeConfig) -> bool) -> bool {
        let Some(state) = self.app.try_state::<Arc<AppState>>() else {
            return false;
        };
        let Ok(cfg) = state.config.try_read() else {
            return false;
        };
        pick(&cfg)
    }

    /// 命中规则就代替用户回 `allow`，并记一条 `auto: true` 的 Resolved。
    ///
    /// 全程 fail-closed：规则表空 / 编译失败 / 主参数取不到 / 写 stdin 失败，
    /// 统统安静退场，卡片留在原地等用户 —— 自动放行是**优化**，不是必需路径。
    fn maybe_auto_approve(&self, request_id: &str, tool_name: &str, input: &serde_json::Value) {
        let Some(state) = self.app.try_state::<Arc<AppState>>() else {
            return;
        };
        // 一次读完就用：`try_read` 失败（正在存配置）= 本轮不自动放行。
        let rules = {
            let Ok(cfg) = state.config.try_read() else {
                return;
            };
            cfg.cc_auto_approve_rules.clone()
        };
        let Some(hit) = auto_approve_hit(&rules, tool_name, input) else {
            return;
        };
        // 回写走与用户点击同一条路（`CcSession::respond`）：它管加锁、管进程存活。
        // 失败只可能是进程正在退 —— 那时用户自己点也一样会失败。
        //
        // 寻址按**这条 sink 所属的会话**（internal id 铸发时落进了 shared）：
        // 多会话并存时自动放行必须回到提问的那一条上，不能借用户当前聚焦的那条。
        // 拿不到（理论上不会：3-1a 没有移除入口）⇒ 安静退场，卡片留给用户。
        let wrote = state
            .cc
            .get(self.shared.internal_id())
            .and_then(|cc| cc.respond(request_id, &Verdict::allow_as_is(input)).ok())
            .is_some();
        if !wrote {
            return;
        }
        // 摘单：晚了进来的用户点击会得到「已失效」，而不是重复回一条裁决。
        self.shared.forget(request_id);
        record_local(
            &self.app,
            &self.shared,
            CcEvent::PermissionResolved {
                request_id: request_id.to_string(),
                decision: "allow".to_string(),
                auto: true,
            },
        );
        log::info!("审批规则命中，已自动放行 {tool_name}（规则：{hit}）");
    }

    /// 本轮结束推一条桌面通知。**两道门**都开才推：
    /// `cc_notify_turn_end`（要不要为对话弹）与 `notify_task_complete`（让不让弹）。
    fn notify_turn_end(&self, is_error: bool, text: Option<&str>) {
        let on = self.config_flag(|c| c.cc_notify_turn_end && c.notify_task_complete);
        if !on {
            return;
        }
        let title = if is_error {
            "CC 对话出错了"
        } else {
            "CC 对话已完成"
        };
        let body = match text.map(str::trim).filter(|t| !t.is_empty()) {
            // 结果正文可能很长，取第一行、再截断：通知是摘要不是全文。
            Some(t) => {
                let first = t.lines().next().unwrap_or(t);
                let mut out: String = first.chars().take(100).collect();
                if first.chars().count() > 100 {
                    out.push('…');
                }
                out
            }
            None => "本轮已结束。".to_string(),
        };
        let app = self.app.clone();
        // 转成 owning：`run_on_main_thread` 要 `'static` 闭包，借用的 &str 进不去。
        let title = title.to_string();
        // 闭包要 move 一个 AppHandle 进去，而 `run_on_main_thread` 本身借的是
        // 外面这个 —— 各持一份克隆，互不占用。
        let notify_app = app.clone();
        // 通知插件在 mac 上要求主线程；`run_on_main_thread` 从任何线程调都安全，
        // 而这里跑在 claude 的 stdout 读线程上。
        let _ = app.run_on_main_thread(move || {
            let _ = crate::commands::notify_desktop_impl(notify_app, &title, &body);
        });
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
    /// 当前的 IO 挂载点。`None` = 没有在跑的进程。
    ///
    /// 批 3-2 起是 [`Transport`] 而不是 [`Run`]：托管（S4）要换的是 IO 挂载点，
    /// 而 `Run` 的「一个子进程 + 一条 stdout」语义不动。
    live: StdMutex<Option<Transport>>,
}

impl Default for CcSession {
    /// 仅测试与容器内部用：内部 id = 0（「未设置」），在任何路由里都查不到。
    /// 生产路径一律走 `with_id` / `CcSessions::new_session`。
    fn default() -> Self {
        Self::new()
    }
}

impl CcSession {
    /// 裸构造（内部 id = 0，未归进 `CcSessions`）。**生产路径不许用** ——
    /// 只有测试与 `with_id` 内部走这里。`Default` 是 clippy 的
    /// `new_without_default` 逼出来的，语义与它一致：id=0 的会话在任何路由里
    /// 都查不到，「忘了铸发」不会静默串到别的会话头上。
    pub fn new() -> Self {
        Self {
            shared: Shared::new(),
            live: StdMutex::new(None),
        }
    }

    /// 归进 `CcSessions` 的构造：内部 id 在 shared 里落定，事件一带即走。
    pub fn with_id(internal_id: u64) -> Self {
        let s = Self::new();
        s.shared.set_internal_id(internal_id);
        s
    }

    pub fn shared(&self) -> &Arc<Shared> {
        &self.shared
    }

    /// 当前**正在进行的那一轮**属于哪个 CC 会话（拿不到 ⇒ `None`）。
    ///
    /// 用途：MCP 工具调用把它记进审计，两套账才能按同一个 session id 对上
    /// （见 `audit.rs` 的 `ccSessionId`）。
    ///
    /// 🔴 只在 `turn_active` 时返回。轮次之间从**别的客户端**来的调用若也被记到
    /// 上一条会话头上，就是张冠李戴——那时根本不是它在干活。
    /// 残余误差只有毫秒级（`send()` 先置位再写 stdin；`TurnEnd` 落定与 CLI 最后
    /// 一次工具返回之间可能差几毫秒），可接受，但方向必须是「宁可漏、不可错」。
    pub fn active_session_id(&self) -> Option<String> {
        if !self.shared().turn_active() {
            return None;
        }
        self.shared().resume_id()
    }

    pub fn is_running(&self) -> bool {
        self.live
            .lock()
            .map(|g| g.as_ref().map(Transport::is_alive).unwrap_or(false))
            .unwrap_or(false)
    }

    /// 起一轮。已在跑则拒绝 —— 两个进程写同一份 `~/.claude/projects` 会互相踩。
    pub fn start(&self, launch: Launch, sink: Arc<dyn EventSink>) -> Result<(), String> {
        let mut guard = self.live.lock().map_err(|_| "会话状态已锁死".to_string())?;
        if let Some(t) = guard.as_ref() {
            if t.is_alive() {
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
        *guard = Some(Transport::Direct(run));
        // 上一轮残留的待批单在新一轮里永远不可能被满足（request_id 是上一轮进程的）。
        self.shared.clear_pending();
        Ok(())
    }

    pub fn send(&self, text: &str) -> Result<(), String> {
        self.send_user_images(text, &[])
    }

    /// 带图发一条（走既有进程）。
    ///
    /// 格式 / 5 MB / 裸 base64 的校验在 `Run::send_user_images` 里 fail-closed，
    /// 且发生在写 stdin 之前 —— 与 `send` 一样，写成功才算这一轮开始。
    pub fn send_user_images(&self, text: &str, images: &[UserImage]) -> Result<(), String> {
        let guard = self.live.lock().map_err(|_| "会话状态已锁死".to_string())?;
        let t = guard.as_ref().ok_or("当前没有进行中的对话")?;
        t.send_user_images(text, images)?;
        self.shared.set_turn_active(true);
        Ok(())
    }

    pub fn respond(&self, request_id: &str, verdict: &Verdict) -> Result<(), String> {
        let guard = self.live.lock().map_err(|_| "会话状态已锁死".to_string())?;
        let t = guard.as_ref().ok_or("这一轮已经结束，无法再批准")?;
        t.respond(request_id, verdict)
    }

    /// 中断：杀进程树，**保留已收到的内容**（ring 不清）。
    pub fn interrupt(&self) -> bool {
        let Ok(mut guard) = self.live.lock() else {
            return false;
        };
        match guard.as_mut() {
            Some(t) if t.is_alive() => {
                t.kill();
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

    /// 新会话：清流水 + 清 session_id + 忘掉库里的行。**只在用户显式「新对话」时调用**。
    ///
    /// 不清库里的旧行 —— 那是历史。下一次落盘会插入一条新会话。
    pub fn reset(&self) {
        let _ = self.interrupt();
        self.shared.ring.clear();
        self.shared.clear_resume();
        self.shared.clear_pending();
        self.shared.clear_row();
        self.shared.mark_new_session();
        self.shared.set_facts(SessionFacts::default());
        // 用量账跟着会话链一起清：新对话从零开始，不能把上一条的 token 带过来
        // （否则「新对话」第一轮就显示一条老账）。
        if let Ok(mut g) = self.shared.usage.lock() {
            *g = None;
        }
        if let Ok(mut guard) = self.live.lock() {
            drop(guard.take());
        }
    }

    /// 同步落盘一次。应用退出时调 —— 那时异步任务可能来不及跑。
    ///
    /// 不返回 `Result`：退出路径上没地方处理错误，记进日志即可。
    pub fn persist(&self, conn: &Connection) {
        match persist_shared(conn, &self.shared) {
            Ok(_) => {}
            Err(e) => log::warn!("退出前落盘会话失败：{e}"),
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

/// 多会话容器：内部 id → 一条 [`CcSession`]。
///
/// ## 为什么是它，而不是「前端自己记着哪条是哪条」
///
/// 切 tab 会卸载前端组件，进程与事件流水必须活过卸载 —— 那是 `CcSession`
/// 的既有决定（`state.rs` 字段注释）。多会话只是把「唯一一条」换成「一组」，
/// 寻址方式与业界同构：OpenHands V1 每个端点带 `conversation_id`、MCP
/// 2026-07-28 起改显式 handle（调研见 `docs/批3多会话结构方案-2026-10-24.md` §三）。
///
/// ## 存 `Arc<CcSession>` 而不是裸值
///
/// 与 AppState 其它 DashMap 同一条教训（`state.rs` 的 `path_locks` 注释）：
/// `DashMap::get` 返回的 Ref 不能跨 await 长期持有，而命令处理函数全程要
/// 用它。clone 一个 `Arc` 出来，锁即用即放。
///
/// ## id 从 1 开始
///
/// 0 是 `Shared::default()` 的「未设置」值。从 1 铸发保证「查不到 0」——
/// 测试里裸构造的 shared 因此永远不会被路由命中。
pub struct CcSessions {
    next_id: AtomicU64,
    map: DashMap<u64, Arc<CcSession>>,
}

impl Default for CcSessions {
    fn default() -> Self {
        Self::new()
    }
}

impl CcSessions {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            map: DashMap::new(),
        }
    }

    /// 铸发一条新会话，返回它的内部 id。
    ///
    /// 不设上限：本地产品的并发上限由机器资源与服务端 rate limit 决定，
    /// 不是我们能代用户拍的数字（CC workflow guideline 原话 "advice rather
    /// than a hard cap"；Cline Cloud 的 10 条是云 sandbox 成本，与我们无关）。
    pub fn new_session(&self) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.map.insert(id, Arc::new(CcSession::with_id(id)));
        id
    }

    /// 按内部 id 取会话。查不到（传了没铸发过的 id）⇒ `None`。
    pub fn get(&self, id: u64) -> Option<Arc<CcSession>> {
        self.map.get(&id).map(|r| Arc::clone(&r))
    }

    /// 归属给 MCP 审计的 CC session id（语义见 [`CcSession::active_session_id`]）。
    ///
    /// 汇总规则：**只有一条**活跃轮次时才归属；零条或多条都返回 `None`。
    /// 多条时无法判断这一笔工具调用该记到谁头上 —— 张冠李戴比不记更糟
    /// （审计的价值全在「对得上」）。这个判断让 `http.rs` / `sse.rs` /
    /// `batch.rs` / `transfer.rs` 四个调用点在多实例化后一行都不用改。
    pub fn active_session_id(&self) -> Option<String> {
        let mut only: Option<String> = None;
        let mut live = 0usize;
        for r in self.map.iter() {
            if r.shared().turn_active() {
                live += 1;
                only = r.active_session_id();
            }
        }
        if live == 1 {
            only
        } else {
            None
        }
    }

    /// 关掉一条会话：从表里摘掉并返回它（调用方负责先 `interrupt`）。
    ///
    /// 侧栏的「关闭会话」用它。**摘表不等于杀进程** —— 进程归 `CcSession` 自己管，
    /// 这里不做是因为调用点（命令层）要能选顺序：先落盘再摘表，还是先摘再杀。
    /// 返回 `Option` 让调用方分辨「本来就没有」与「刚关掉」，界面上是两种提示。
    pub fn remove(&self, id: u64) -> Option<Arc<CcSession>> {
        self.map.remove(&id).map(|(_, v)| v)
    }

    /// 同步落盘全部会话。应用退出时调 —— 那时异步任务可能来不及跑。
    pub fn persist_all(&self, conn: &Connection) {
        for r in self.map.iter() {
            r.persist(conn);
        }
    }

    /// 收尾全部会话。宽限期短：用户已经关窗，多等没意义。
    pub fn shutdown_all(&self, grace: std::time::Duration) {
        for r in self.map.iter() {
            r.shutdown(grace);
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
///
/// `pub(crate)`：润色（`cc_polish`）的一次性子进程也用它 —— 那边虽然 `--bare`
/// 跳过钩子，但保持一致比省一个环境变量更不容易出事。
#[cfg(windows)]
pub(crate) fn git_bash_env() -> Vec<(String, String)> {
    git_bash_env_from(
        std::env::var_os(GIT_BASH_ENV).is_some(),
        crate::mcp::tools::shell::detect_bash_exe().as_deref(),
    )
}

/// 非 Windows：bash 是系统自带的，claude 自己找得到，不需要接管。
#[cfg(not(windows))]
pub(crate) fn git_bash_env() -> Vec<(String, String)> {
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

    /// 首次调用（`facts` 还是默认值）与本机空目标必须算「同一目标」。
    ///
    /// 判成不同会走到「清 session id + 清行号」那条路 —— 对第一次说话无害，
    /// 但它同时会 `interrupt()`，在恢复后第一次发言时把刚起来的进程打断。
    #[test]
    fn default_facts_match_local_target() {
        let shared = Shared::new();
        assert!(shared.same_target("", None));
    }

    /// 尾部斜杠 / 空白不能算成不同目标：前端从 localStorage 读回来的值
    /// 常常带一个尾巴，判错会让用户每切一次页就多出一条会话记录。
    #[test]
    fn trailing_separator_is_not_a_target_change() {
        let shared = Shared::new();
        shared.set_facts(SessionFacts {
            cwd: Some("D:\\proj".into()),
            ..SessionFacts::default()
        });
        assert!(shared.same_target("", Some("D:\\proj\\  ")));
    }

    /// 换机器、换目录都必须算目标变了 —— 转录在 CLI 那边按「机器 + 目录」分开存，
    /// 跨目标复用进程会把消息写进另一个目标的 claude 里，且没有任何报错。
    #[test]
    fn different_machine_or_dir_is_a_new_target() {
        let shared = Shared::new();
        shared.set_facts(SessionFacts {
            connection_id: "conn-1".into(),
            cwd: Some("/home/u/a".into()),
            ..SessionFacts::default()
        });
        assert!(shared.same_target("conn-1", Some("/home/u/a")));
        assert!(!shared.same_target("conn-2", Some("/home/u/a")), "换机器");
        assert!(!shared.same_target("conn-1", Some("/home/u/b")), "换目录");
        assert!(!shared.same_target("", Some("/home/u/a")), "本地↔远端");
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

    /// 工具账归属的判据：**空闲时一律不归属**，否则轮次之间从别的客户端来的
    /// 调用会被张冠李戴记到上一条对话头上。跑着一轮时才给 session id。
    #[test]
    fn active_session_id_only_while_turn_active() {
        let s = CcSession::new();
        assert!(s.active_session_id().is_none(), "没聊过 ⇒ 无归属");
        s.shared().set_resume_id("cc-1");
        assert!(s.active_session_id().is_none(), "有 id 但没在跑 ⇒ 仍不归属");
        s.shared().set_turn_active(true);
        assert_eq!(s.active_session_id().as_deref(), Some("cc-1"));
        // 一轮落定后立刻收回：CLI 进程还活着，但那一轮已经结束了。
        s.shared().set_turn_active(false);
        assert!(s.active_session_id().is_none());
    }

    /// 用量账跟着会话链清零：新对话不能带着上一条的 token 出场。
    #[test]
    fn reset_clears_usage() {
        let s = CcSession::new();
        s.shared().set_usage(crate::cc_session::usage::CcUsage {
            input_tokens: 100,
            output_tokens: 10,
            cost_usd: 0.1,
            turns: 2,
        });
        assert!(s.shared().usage().is_some());
        s.reset();
        assert!(s.shared().usage().is_none());
    }

    #[test]
    fn reset_clears_everything() {
        let s = CcSession::new();
        s.shared.ring.push(CcEvent::Exit { code: Some(0) });
        s.shared.set_resume_id("s-1");
        s.shared
            .ask("r-1", false, &serde_json::json!({"command": "rm -rf /"}));
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
        shared.ask("r-7", false, &input);
        assert_eq!(shared.pending_input("r-7"), Some(input));
        // 取不删除：写失败时用户还能再点一次。
        assert!(shared.pending_input("r-7").is_some());
        shared.forget("r-7");
        assert!(shared.pending_input("r-7").is_none());
    }

    /// 只有提问允许补答案。这条判据必须在登记时定死，不能由调用方在回写时自行声明。
    #[test]
    fn only_questions_accept_answers() {
        let shared = Shared::new();
        shared.ask("ask-1", false, &serde_json::json!({"command": "ls"}));
        shared.ask(
            "q-1",
            true,
            &serde_json::json!({"questions": [{"question": "吃什么"}]}),
        );
        assert!(!shared.pending_ask("ask-1").expect("有单").accepts_answers);
        assert!(shared.pending_ask("q-1").expect("有单").accepts_answers);
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
                model_usage: None,
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

    // ---- 审批自动放行（接线守卫：TauriSink 只认这个纯函数的结论） ----

    #[test]
    fn auto_approve_hit_empty_rules_returns_none() {
        // 空规则表 = 全部人工。这是默认形态，必须是「谁都不放」。
        assert!(auto_approve_hit(&[], "Bash", &serde_json::json!({"command": "ls"})).is_none());
    }

    #[test]
    fn auto_approve_hit_matches_rule_and_reports_raw() {
        let rules = vec!["Bash(git status)".to_string()];
        assert_eq!(
            auto_approve_hit(
                &rules,
                "Bash",
                &serde_json::json!({"command": "git status"})
            ),
            Some("Bash(git status)".to_string())
        );
        assert!(
            auto_approve_hit(&rules, "Bash", &serde_json::json!({"command": "rm -rf /"})).is_none()
        );
    }

    /// 🔴 提问永不自动放行：答案只能用户给。规则写得再宽（`AskUserQuestion(**)`）
    /// 也不放 —— 这是纯函数里的纵深防御，与调用方「只对 PermissionAsk 调」双保险。
    #[test]
    fn auto_approve_hit_never_allows_questions() {
        let rules = vec!["AskUserQuestion(**)".to_string()];
        let input = serde_json::json!({"questions": [{"question": "吃什么"}]});
        assert!(auto_approve_hit(&rules, "AskUserQuestion", &input).is_none());
    }

    /// 通知标题/正文的截断逻辑不能把多字节字符劈碎（`chars()` 计数，不是字节）。
    #[test]
    fn notify_body_truncates_on_char_boundary() {
        // 与 `notify_turn_end` 同规则的截断：先取第一行，再按字符截到 100。
        let long: String = "中".repeat(300);
        let first = long.lines().next().unwrap_or(&long);
        let mut out: String = first.chars().take(100).collect();
        if first.chars().count() > 100 {
            out.push('…');
        }
        assert_eq!(out.chars().count(), 101);
        assert!(out.ends_with('…'));
        assert!(out.is_char_boundary(out.len()));
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

    // ---- CcSessions 多会话容器 ----

    #[test]
    fn new_session_mints_unique_increasing_ids() {
        let c = CcSessions::new();
        let a = c.new_session();
        let b = c.new_session();
        let d = c.new_session();
        assert!(a >= 1, "0 是「未设置」，不许铸发");
        assert!(b > a && d > b, "id 必须单调：{a} {b} {d}");
        for id in [a, b, d] {
            let s = c.get(id).expect("铸发过的 id 必须取得到");
            assert_eq!(
                s.shared().internal_id(),
                id,
                "id 必须落进 shared —— 事件路由与前端分流都靠它"
            );
        }
    }

    #[test]
    fn get_unknown_id_returns_none() {
        let c = CcSessions::new();
        assert!(c.get(999).is_none());
        assert!(c.get(0).is_none(), "0 是未设置值，永远查不到");
    }

    #[test]
    fn active_session_id_needs_exactly_one_live_turn() {
        let c = CcSessions::new();
        // 零条活跃 ⇒ 不归属。
        assert_eq!(c.active_session_id(), None);
        let a = c.new_session();
        let b = c.new_session();
        // 一条活跃 ⇒ 归属到它（resume id 是 CC 的 id，与内部 id 两回事）。
        c.get(a).unwrap().shared().set_turn_active(true);
        c.get(a).unwrap().shared().set_resume_id("cc-a");
        assert_eq!(c.active_session_id().as_deref(), Some("cc-a"));
        // 两条同时活跃 ⇒ 判断不出该记到谁头上，宁可不归。
        c.get(b).unwrap().shared().set_turn_active(true);
        c.get(b).unwrap().shared().set_resume_id("cc-b");
        assert_eq!(c.active_session_id(), None, "多条活跃时必须放弃归属");
    }

    #[test]
    fn remove_takes_session_out_of_map_once() {
        let c = CcSessions::new();
        let a = c.new_session();
        let b = c.new_session();
        assert_eq!(
            c.remove(a).map(|s| s.shared().internal_id()),
            Some(a),
            "摘掉的必须就是那一条"
        );
        assert!(c.get(a).is_none(), "摘掉后不许再查得到");
        assert!(c.get(b).is_some(), "只摘这一条，别的会话不受影响");
        assert!(c.remove(a).is_none(), "第二条命令要能分辨「已经没了」");
    }

    #[test]
    fn persist_and_shutdown_all_survive_empty_and_live() {
        // 空容器是退出路径上最常见的形态（没聊过就关窗），不许炸。
        let c = CcSessions::new();
        let conn = Connection::open_in_memory().expect("内存库");
        c.persist_all(&conn);
        c.shutdown_all(std::time::Duration::from_millis(1));
        // 有一条（无进程）时同理：空 ring 的 persist 直接跳过，无轮次的 shutdown 空转。
        c.new_session();
        c.persist_all(&conn);
        c.shutdown_all(std::time::Duration::from_millis(1));
    }
}
