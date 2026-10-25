//! 历史对话的 IPC 命令层。
//!
//! 只做三件事：把阻塞扫描挪出 tokio worker、把打开动作翻译成「接管当前会话」、
//! 把结果拼成前端要的形状。判断逻辑全在 `cc_history` 里（可脱离 Tauri 测）。
//!
//! ## 为什么扫描必须 `spawn_blocking`
//!
//! 首次扫描要读 60 个文件、解析 24MB。放进 async 上下文里跑，它会把 tokio
//! worker 占住几百毫秒 —— 那期间**所有**其他 IPC（终端的每一次按键回显、
//! 配置读写）一起卡住。`#[tokio::test]` 死锁踩过一次，这是同一类错误的变体。

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use crate::cc_history::{self, index};
use crate::cc_session::manager::SnapshotDto;
use crate::cc_session::proto::CcEvent;
use crate::cc_session::store::{self, SessionFacts};
use crate::state::AppState;

/// 历史列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcHistoryList {
    /// 新的在前。远端条目与本地条目混排（都按 `lastUsedAt` 倒序）。
    pub rows: Vec<index::Row>,
    /// 有几份转录读不开（权限、坏文件）。`> 0` 时列表底部要给一句说明。
    pub failed: usize,
    /// `~/.claude/projects` 在不在。不在 ⇒ 列表空是**正常**的，界面显示引导
    /// 而不是「读取失败」。
    pub dir_found: bool,
    /// 这次扫描花了多少毫秒。慢的时候这是唯一能自证的线索。
    pub took_ms: u64,
}

/// 打开一条历史的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcHistoryOpened {
    /// 灌完历史之后的快照。前端直接 `replay` 它 —— **不要再逐条 `event`**，
    /// 那些事件已经在里面了。
    pub snapshot: SnapshotDto,
    /// 因体积上限被裁掉的**头部**事件数。与 `snapshot.dropped`（环形缓冲溢出）
    /// 是两回事，但界面上的含义一样：「更早的内容没加载」。
    pub trimmed: u64,
    pub title: String,
    /// 这条历史对应 `cc_sessions` 里的行号（库里已有行时才有；纯终端聊出来的没有）。
    /// 侧栏历史区对账、改名 / 归档都要它 —— 接管之后它是前端唯一的行号来源。
    pub row_id: Option<i64>,
    /// 这条历史在哪跑的。
    ///
    /// 🔴 前端必须把它写进工作目录输入框：`cc_start` 会拿它和内存里的
    /// `facts.cwd` 比，不一致就判定「换了目录」→ 清 resume id → **打开的历史
    /// 变成一条新会话**，模型忘光前面且没有任何报错。
    pub cwd: Option<String>,
}

/// 列出历史。本机与远端都走这里（远端条目从同一张索引表出）。
///
/// `query` 为空 = 全量；带词 = 先扫描（保证刚在终端聊的那条也进得了索引），
/// 再按 `index::search` 收窄。匹配口径见那边的注释。
#[tauri::command]
pub async fn cc_history_list(
    state: State<'_, Arc<AppState>>,
    query: Option<String>,
) -> Result<CcHistoryList, String> {
    let started = Instant::now();
    let st = Arc::clone(&*state);
    let out = tauri::async_runtime::spawn_blocking(move || {
        // `blocking_lock` 只能在非 runtime 线程用 —— 这里正是 spawn_blocking
        // 的线程池，所以安全。
        let conn = st.db.blocking_lock();
        let scanned = cc_history::scan_local(&conn)?;
        let rows = match query.as_deref().map(str::trim) {
            Some(q) if !q.is_empty() => index::search(&conn, "", q)?,
            _ => scanned.rows,
        };
        Ok::<_, String>((rows, scanned.failed, scanned.dir_found))
    })
    .await
    .map_err(|e| format!("扫描历史失败：{e}"))??;

    Ok(CcHistoryList {
        rows: out.0,
        failed: out.1,
        dir_found: out.2,
        took_ms: started.elapsed().as_millis() as u64,
    })
}

/// 打开一条历史：把它接管成「当前会话」。
///
/// ## 为什么是接管而不是新开一个只读视图
///
/// 打开历史之后用户第一件事肯定是「接着问」。要能接着问，内存里就必须同时具备：
/// `resume_id`（下一轮 `--resume` 带上它）、`cwd`（远端要 `cd` 过去）、
/// `connection_id`（知道连哪台机器）。这三样正是期一 `adopt` 写过的东西，
/// 这里复用同一条路 —— 只是内容来源从「我们的落盘」换成了「CLI 的 jsonl」。
///
/// 三者漏任何一个都是静默故障，症状与期一那张表完全一样。
#[tauri::command]
pub async fn cc_history_open(
    state: State<'_, Arc<AppState>>,
    // 内部会话 id（`cc_new_session` 铸发）—— 历史灌进哪一条 GUI 会话。
    session_id: u64,
    // **CC 的**历史会话 id（转录文件名 stem）。与上面的内部 id 同名不同物：
    // 那个是「这一路对话」的身份，这个才是 CLI `--resume` 要的值。
    history_id: String,
) -> Result<CcHistoryOpened, String> {
    let sid = history_id.trim().to_string();
    if sid.is_empty() {
        return Err("缺少会话 id".into());
    }
    let cc = state
        .cc
        .get(session_id)
        .ok_or_else(|| format!("会话不存在（内部 id {session_id}）"))?;
    let st = Arc::clone(&*state);
    let sid_for_read = sid.clone();
    let (opened, row_id) = tauri::async_runtime::spawn_blocking(move || {
        let conn = st.db.blocking_lock();
        let opened = cc_history::open_local(&conn, &sid_for_read)?;
        // 复用旧的落盘行（如果有）：同一条会话在 `cc_sessions` 里只该有一行。
        let row_id = store::find_by_session(&conn, "", &sid_for_read).unwrap_or(None);
        Ok::<_, String>((opened, row_id))
    })
    .await
    .map_err(|e| format!("读取历史失败：{e}"))??;

    // 🔴 必须先收掉还在跑的那一轮。
    //
    // 不收的后果两种，都很难看：进程在 `result` 之后还活着（实测它不会自己退），
    // 它**后面的每一条事件**都会接着 push 进刚灌好的历史流水里 —— 用户看到的是
    // 「三个月的旧会话 + 半段不相干的新回复」拼在一起。若那一轮还在输出，
    // 更糟：历史的最后一条会被新内容持续覆盖。
    //
    // 顺序放在读正文**之后**：读文件要几十到几百毫秒，先杀进程再读，用户会看到
    // 「点了历史，回复先断了，然后过了半秒才有内容」。反过来读失败时进程毫发无伤。
    cc.interrupt();

    take_over(cc.shared(), &sid, &opened, row_id);
    Ok(CcHistoryOpened {
        snapshot: cc.snapshot(),
        trimmed: opened.dropped,
        title: opened.meta.title(),
        row_id,
        cwd: opened.meta.cwd,
    })
}

/// 把一条历史灌进当前会话。**顺序有讲究**，见函数体注释。
fn take_over(
    shared: &Arc<crate::cc_session::Shared>,
    session_id: &str,
    opened: &cc_history::Opened,
    row_id: Option<i64>,
) {
    // 1. 先清：旧会话的流水、resume id、待批单全部作废。
    //    不清流水的话，新灌进来的历史会追加在旧消息后面。
    shared.ring.clear();
    shared.clear_resume();
    shared.clear_pending();
    shared.clear_row();

    // 2. 再接管三件套。
    if let Some(id) = row_id {
        shared.set_row_id(id);
    }
    // 🔴 这一句是「接着聊」的全部：下一轮 `--resume` 带上它，CLI 才认得这段历史。
    shared.set_resume_id(session_id);
    shared.set_facts(SessionFacts {
        // 本机。远端历史的 `connection_id` 由期二的远端扫描填（届时改这里）。
        connection_id: String::new(),
        cwd: opened.meta.cwd.clone(),
        claude_path: None,
        model: None,
        permission_mode: None,
    });

    // 3. 最后灌事件。
    //    开头补一条 `Init`：它让 reducer 拿到 sessionId 与 cwd（会话条要显示目录），
    //    同时经由 `bookkeep` 再确认一次 resume id。历史里没有这条事件，
    //    因为它是 CLI 启动时说的，不写进转录。
    shared.ring.push(CcEvent::Init {
        session_id: session_id.to_string(),
        cwd: opened.meta.cwd.clone(),
        model: None,
    });
    for event in &opened.events {
        shared.ring.push(event.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cc_history::parse::Meta;

    fn opened(events: Vec<CcEvent>) -> cc_history::Opened {
        cc_history::Opened {
            meta: Meta {
                session_id: "s-1".into(),
                cwd: Some("/proj".into()),
                user_count: 1,
                ..Meta::default()
            },
            events,
            dropped: 0,
        }
    }

    /// 🔴 打开历史必须把「下一轮在哪续、在哪个目录」写进内存。
    /// 漏 `set_resume_id` 的症状是「打开旧会话，问一句，模型忘光前面」。
    #[test]
    fn opening_history_sets_resume_and_facts() {
        let shared = crate::cc_session::Shared::new();
        take_over(
            &shared,
            "s-1",
            &opened(vec![CcEvent::UserMessage {
                text: "旧问题".into(),
            }]),
            Some(9),
        );
        assert_eq!(shared.resume_id().as_deref(), Some("s-1"));
        assert_eq!(shared.facts().cwd.as_deref(), Some("/proj"));
        assert_eq!(shared.row_id(), Some(9), "必须复用旧的落盘行");
        // Init + 一条用户消息
        assert_eq!(shared.ring.snapshot().events.len(), 2);
    }

    /// 打开历史会**清空**当前流水：不清的话新的接在旧消息后面，
    /// 用户看到的是两条毫不相干的会话拼在一起。
    #[test]
    fn opening_history_clears_previous_feed() {
        let shared = crate::cc_session::Shared::new();
        shared.ring.push(CcEvent::UserMessage {
            text: "当前会话的话".into(),
        });
        shared.set_resume_id("current");
        take_over(&shared, "old", &opened(Vec::new()), None);
        let events = shared.ring.snapshot().events;
        assert_eq!(events.len(), 1, "只剩新补的 Init");
        assert!(matches!(events[0], CcEvent::Init { .. }));
        assert_eq!(
            shared.resume_id().as_deref(),
            Some("old"),
            "必须被新的 id 顶掉（`set_resume_id` 只填空白，所以要先 clear）"
        );
    }

    /// 从没在对话页聊过的历史（终端页手敲 claude 产生的）没有落盘行，
    /// 不能因此报错 —— 下一轮插入新行即可。
    #[test]
    fn unknown_row_id_is_fine() {
        let shared = crate::cc_session::Shared::new();
        take_over(&shared, "s-2", &opened(Vec::new()), None);
        assert_eq!(shared.row_id(), None);
        assert_eq!(shared.resume_id().as_deref(), Some("s-2"));
    }

    /// 补的那条 `Init` 必须带 cwd：会话条靠它显示目录，缺了就是「默认目录」。
    #[test]
    fn synthetic_init_carries_cwd() {
        let shared = crate::cc_session::Shared::new();
        take_over(&shared, "s-3", &opened(Vec::new()), None);
        match shared.ring.snapshot().events.first() {
            Some(CcEvent::Init {
                session_id, cwd, ..
            }) => {
                assert_eq!(session_id, "s-3");
                assert_eq!(cwd.as_deref(), Some("/proj"));
            }
            other => panic!("第一条必须是 Init，实际 {other:?}"),
        }
    }
}
