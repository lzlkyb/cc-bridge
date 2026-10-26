//! 会话落盘：让「关掉 app 就没了」消失。
//!
//! ## 落什么、不落什么
//!
//! 落的是**我们自己产生的事件流水**（`CcEvent[]` 的 JSON），不是 CLI 的转录。
//! 红线不动 `~/.claude/*` —— 那是 CLI 的，改它等于改用户的原始记录。
//! 两边的关系在期二理清：届时 `--resume` 靠 CLI 的 jsonl，界面靠这里的快照，
//! 谁新谁旧用 `file_mtime` 对账。
//!
//! ## 为什么存整段事件而不是「渲染后的消息」
//!
//! 和 `ring.rs` 同一条理由：渲染模型活在前端，Rust 存一份它就得跟着漂。
//! 存事件则前端重放和恢复走**同一条 reducer 路径**，不存在「恢复出来的长得不一样」
//! 这种只有用户能发现的 bug。
//!
//! ## 体积
//!
//! 一轮几百条事件、几十到几百 KB。单个会话超 [`MAX_EVENTS_BYTES`] 时**从头丢**，
//! 并且丢到一条完整用户消息为止 —— 否则界面会从一个没头没尾的工具卡开始。
//! 丢了多少如实返回，前端必须提示「更早的已滚出」，不能假装完整。
//!
//! ## 主键为什么是自增 id 而不是 session_id
//!
//! 用户发出第一条消息的那一刻就要落盘，而 CLI 的 `session_id` 直到 `system/init`
//! 才出现。拿 `session_id` 当主键，这段时间**根本没有键可写**。
//! 所以用自增 `id` 做物理主键，`session_id` 只是可空的业务列（`init` 到达后回填）。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::proto::CcEvent;

/// 单条会话事件快照的上限。
///
/// 4MB 是个折中：真实会话通常远小于它（本机实测单条 jsonl 最大 1MB），
/// 而一旦某个会话真的涨到几 MB，写库的耗时和内存都要有上限。
pub const MAX_EVENTS_BYTES: usize = 4 * 1024 * 1024;

/// 保留多少条会话。超出按最后活跃时间淘汰。
///
/// 一条会话一行，会话数只跟「对话页里新开过几次」有关，正常一年也就几百条。
/// 设上限纯粹是防「events_json 越攒越大把库撑爆」。
pub const KEEP_SESSIONS: usize = 100;

/// 用户手写标题的长度上限（字符）。
///
/// 比自动标题的 80 字宽一点：手写的往往是「客户 A · 发票导出」这种短标签，
/// 但也不该让一行侧栏塞下一整句话。按**字符**截（中文按字节切会乱码）。
pub const MAX_TITLE_CHARS: usize = 120;

/// 一次落盘的内容。
#[derive(Debug, Default, Clone)]
pub struct Snapshot {
    /// 空串 = 本机。远端是连接 id。
    pub connection_id: String,
    /// CLI 的 session id。`init` 之前是 `None`。
    pub session_id: Option<String>,
    /// 下一轮 `--resume` 要带的值（通常等于 `session_id`，但不强求）。
    pub resume_id: Option<String>,
    pub cwd: Option<String>,
    /// 远端必需：非登录 bash 拿不到 `~/.local/bin`，没有它就「远端没装 claude」。
    pub claude_path: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub events: Vec<CcEvent>,
}

/// 库里读出来的一条会话。
#[derive(Debug, Clone)]
pub struct Stored {
    pub row_id: i64,
    pub connection_id: String,
    pub session_id: Option<String>,
    pub resume_id: Option<String>,
    pub cwd: Option<String>,
    pub claude_path: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub title: Option<String>,
    /// 标题是用户手写的（`cc_rename_session` 写的）。
    ///
    /// 🔴 落盘每次都会用「第一条用户消息」重算标题 —— 没有这一位，用户改完名字
    /// 发下一句就变回原来的自动标题，而且**没有任何提示**，看起来像改名没生效。
    pub title_locked: bool,
    pub preview: Option<String>,
    pub message_count: i64,
    pub updated_at: i64,
    /// 归档时间（秒）。`Some` = 已归档，不出现在默认列表与自动恢复里。
    pub archived_at: Option<i64>,
    pub events: Vec<CcEvent>,
    /// 落盘时因为超限被丢掉了多少条事件（`> 0` 时界面必须提示）。
    pub dropped: u64,
}

/// 建表 + 补列。只在 `init_database` 里调一次。
pub fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cc_sessions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id   TEXT    NOT NULL DEFAULT '',
            session_id      TEXT,
            resume_id       TEXT,
            cwd             TEXT,
            claude_path     TEXT,
            model           TEXT,
            permission_mode TEXT,
            title           TEXT,
            preview         TEXT,
            message_count   INTEGER NOT NULL DEFAULT 0,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL,
            last_active_at  INTEGER NOT NULL,
            file_size       INTEGER,
            file_mtime_ms   INTEGER,
            source          TEXT    NOT NULL DEFAULT 'local',
            dropped         INTEGER NOT NULL DEFAULT 0,
            events_json     TEXT,
            title_locked    INTEGER NOT NULL DEFAULT 0,
            archived_at     INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS cc_sessions_ident
            ON cc_sessions(connection_id, session_id)
            WHERE session_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS cc_sessions_active
            ON cc_sessions(last_active_at DESC);",
    )
    .map_err(|e| format!("建 cc_sessions 表失败：{e}"))?;
    // 老库补列（`CREATE TABLE IF NOT EXISTS` 对已存在的表什么都不做）。
    ensure_column(conn, "title_locked", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "archived_at", "INTEGER")?;
    Ok(())
}

/// 老库补一列。已经有了就什么都不做。
///
/// 只走 `ADD COLUMN`（SQLite 支持且不重写表），不动已有数据 —— 缺的列由默认值
/// 兜底，语义等价于「没改过名 / 没归档」。
fn ensure_column(conn: &Connection, name: &str, decl: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info('cc_sessions')")
        .map_err(|e| format!("读取表结构失败：{e}"))?;
    let exists = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| format!("读取表结构失败：{e}"))?
        .filter_map(Result::ok)
        .any(|c| c == name);
    if exists {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE cc_sessions ADD COLUMN {name} {decl}"),
        [],
    )
    .map_err(|e| format!("给 cc_sessions 补列 {name} 失败：{e}"))?;
    Ok(())
}

/// 落盘。`row_id` 为空则插新行，否则更新它（行已不存在时也退回插入）。
///
/// 返回真正写入的那一行的 id —— 调用方必须把它记下来，下次才能更新同一条，
/// 而不是每轮插一条新会话。
pub fn save(conn: &Connection, row_id: Option<i64>, snap: &Snapshot) -> Result<i64, String> {
    let now = now_secs();
    // 先给没有结局的待批单补一条取消，再裁体积。
    let settled = settle_pending(&snap.events);
    let (events, dropped) = trim_events(&settled, MAX_EVENTS_BYTES);
    let events_json = serde_json::to_string(&events).map_err(|e| format!("序列化事件失败：{e}"))?;
    let title = derive_title(&snap.events);
    let preview = derive_preview(&snap.events);
    let count = count_user_messages(&snap.events);

    if let Some(id) = row_id {
        let changed = conn
            .execute(
                "UPDATE cc_sessions SET
                    connection_id = ?1, session_id = ?2, resume_id = ?3, cwd = ?4,
                    claude_path = ?5, model = ?6, permission_mode = ?7,
                    title = CASE WHEN title_locked = 1 THEN title ELSE ?8 END,
                    preview = ?9, message_count = ?10,
                    updated_at = ?11, last_active_at = ?11,
                    dropped = ?12, events_json = ?13
                 WHERE id = ?14",
                params![
                    snap.connection_id,
                    snap.session_id,
                    snap.resume_id,
                    snap.cwd,
                    snap.claude_path,
                    snap.model,
                    snap.permission_mode,
                    title,
                    preview,
                    count,
                    now,
                    dropped as i64,
                    events_json,
                    id,
                ],
            )
            .map_err(|e| format!("更新会话失败：{e}"))?;
        if changed > 0 {
            return Ok(id);
        }
        // 行被 prune 掉了（或者库被重建）—— 退回插入，别把这一轮丢了。
    }

    conn.execute(
        "INSERT INTO cc_sessions(
            connection_id, session_id, resume_id, cwd, claude_path, model,
            permission_mode, title, preview, message_count,
            created_at, updated_at, last_active_at, dropped, events_json
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?11,?12,?13)",
        params![
            snap.connection_id,
            snap.session_id,
            snap.resume_id,
            snap.cwd,
            snap.claude_path,
            snap.model,
            snap.permission_mode,
            title,
            preview,
            count,
            now,
            dropped as i64,
            events_json,
        ],
    )
    .map_err(|e| format!("写入会话失败：{e}"))?;
    Ok(conn.last_insert_rowid())
}

/// 最后活跃的一条。启动恢复用它。
///
/// 归档的**不参与**自动恢复：用户把它收起来就是不想再看到它，重开又自己跳出来
/// 等于归档没生效。
pub fn latest(conn: &Connection) -> Result<Option<Stored>, String> {
    conn.query_row(
        "SELECT id, connection_id, session_id, resume_id, cwd, claude_path, model,
                permission_mode, title, preview, message_count, updated_at,
                dropped, events_json, title_locked, archived_at
         FROM cc_sessions
         WHERE events_json IS NOT NULL AND archived_at IS NULL
         ORDER BY last_active_at DESC, id DESC
         LIMIT 1",
        [],
        map_row,
    )
    .optional()
    .map_err(|e| format!("读取最近会话失败：{e}"))
}

/// 列表用的摘要：**不含 `events_json`**。
///
/// 那一列是正文（一行几十到几百 KB），而侧栏只要标题 / 轮数 / 时间。列表一次
/// 几十行，带上正文就是几十 MB 的读放大 —— 而侧栏每次进页面都会重取一次。
/// `SELECT` 里不出现那一列就够，不需要额外索引。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub row_id: i64,
    /// 空串 = 本机。
    pub connection_id: String,
    /// CLI 的 session id。侧栏用它和「已经打开的 pane」对账去重。
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    /// 标题是不是用户手写的。前端据此把库里的标题当作「权威标题」用，
    /// 而不是拿它跟首条消息派生的标题打架。
    pub title_locked: bool,
    pub preview: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub message_count: i64,
    pub updated_at: i64,
    /// 归档时间（秒）。`Some` = 已归档，只在「显示已归档」时摆出来。
    pub archived_at: Option<i64>,
    /// 落盘时因超限被丢掉的事件数。
    pub dropped: u64,
}

/// 最近活跃的前 `limit` 条会话摘要。侧栏的「历史」区用它。
///
/// 排序与 [`latest`] 一致（`last_active_at DESC, id DESC`）：列表第一行必须正好是
/// 「重启时会自动恢复的那条」，否则用户看到的是「列表最上面那条」和「打开的那条」
/// 不是同一个，很容易以为恢复错了。
///
/// `include_archived`：归档的默认不摆。侧栏那个「显示已归档」开关会传 `true`，
/// 否则用户归档完就再也找不到那条会话来取消归档了。
pub fn list(
    conn: &Connection,
    limit: usize,
    include_archived: bool,
) -> Result<Vec<Summary>, String> {
    let filter = if include_archived {
        ""
    } else {
        "AND archived_at IS NULL"
    };
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, connection_id, session_id, cwd, title, title_locked, preview, model,
                    permission_mode, message_count, updated_at, dropped, archived_at
             FROM cc_sessions
             WHERE events_json IS NOT NULL {filter}
             ORDER BY last_active_at DESC, id DESC
             LIMIT ?1"
        ))
        .map_err(|e| format!("准备会话列表查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![limit as i64], |row| {
            Ok(Summary {
                row_id: row.get(0)?,
                connection_id: row.get(1)?,
                session_id: row.get(2)?,
                cwd: row.get(3)?,
                title: row.get(4)?,
                title_locked: row.get::<_, i64>(5)? != 0,
                preview: row.get(6)?,
                model: row.get(7)?,
                permission_mode: row.get(8)?,
                message_count: row.get(9)?,
                updated_at: row.get(10)?,
                dropped: row.get::<_, i64>(11)? as u64,
                archived_at: row.get(12)?,
            })
        })
        .map_err(|e| format!("查询会话列表失败：{e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取会话列表失败：{e}"))?);
    }
    Ok(out)
}

/// 按行号取一条完整会话（含正文）。侧栏点开历史时用它。
///
/// `None` 不是错误：行可能刚好被 [`prune`] 淘汰掉（用户在很旧的列表上点了它）。
/// 那时给一句「这条会话已经不在库里」，比报「查询失败」准确得多。
///
/// 归档的**照样能取**：用户点「显示已归档」就是为了把它捞回来。
pub fn by_row_id(conn: &Connection, row_id: i64) -> Result<Option<Stored>, String> {
    conn.query_row(
        "SELECT id, connection_id, session_id, resume_id, cwd, claude_path, model,
                permission_mode, title, preview, message_count, updated_at,
                dropped, events_json, title_locked, archived_at
         FROM cc_sessions
         WHERE id = ?1",
        params![row_id],
        map_row,
    )
    .optional()
    .map_err(|e| format!("读取会话失败：{e}"))
}

/// 用户改名。返回落库后的标题（已按 [`MAX_TITLE_CHARS`] 截断）。
///
/// 空白标题直接拒绝：那会让侧栏出现一行空白的会话，用户再也认不出它是什么。
pub fn rename(conn: &Connection, row_id: i64, title: &str) -> Result<String, String> {
    let flat = flatten(title);
    if flat.is_empty() {
        return Err("标题不能为空".into());
    }
    let title = truncate_chars(&flat, MAX_TITLE_CHARS);
    let changed = conn
        .execute(
            "UPDATE cc_sessions SET title = ?1, title_locked = 1 WHERE id = ?2",
            params![title, row_id],
        )
        .map_err(|e| format!("改名失败：{e}"))?;
    if changed == 0 {
        return Err("这条会话已经不在库里了（可能被清理），刷新列表后重试".into());
    }
    Ok(title)
}

/// 归档 / 取消归档。
///
/// 归档只改一个时间戳，**不删内容**：用户随时能捞回来，这也是「归档」和
/// 「删除」的区别（后者我们没做，也不打算做 —— 删了就找不回来了）。
pub fn set_archived(conn: &Connection, row_id: i64, archived: bool) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE cc_sessions SET archived_at = ?1 WHERE id = ?2",
            params![if archived { Some(now_secs()) } else { None }, row_id],
        )
        .map_err(|e| format!("归档失败：{e}"))?;
    if changed == 0 {
        return Err("这条会话已经不在库里了（可能被清理），刷新列表后重试".into());
    }
    Ok(())
}

/// 库里有没有「这条 CLI 会话」的落盘行。
///
/// 打开历史时用它复用行号：同一条会话在 `cc_sessions` 里只该有一行，
/// 否则用户「打开历史 → 聊一句 → 关掉 → 重开」，恢复出来的是新插的那条，
/// 而旧的那条还挂着同一份内容，列表里出现两条一模一样的会话。
///
/// 返回 `None` 不是错误：从没在对话页里聊过的历史（终端页手敲 claude 产生的）
/// 当然没有落盘行 —— 那一轮插入新行即可。
pub fn find_by_session(
    conn: &Connection,
    connection_id: &str,
    session_id: &str,
) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM cc_sessions
         WHERE connection_id = ?1 AND session_id = ?2
         ORDER BY last_active_at DESC, id DESC
         LIMIT 1",
        params![connection_id, session_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| format!("查询会话行失败：{e}"))
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Stored> {
    let raw: Option<String> = row.get(13)?;
    // 反序列化失败不能把整条恢复拖垮：宁可空白，也不要启动就报错。
    let events: Vec<CcEvent> = raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    Ok(Stored {
        row_id: row.get(0)?,
        connection_id: row.get(1)?,
        session_id: row.get(2)?,
        resume_id: row.get(3)?,
        cwd: row.get(4)?,
        claude_path: row.get(5)?,
        model: row.get(6)?,
        permission_mode: row.get(7)?,
        title: row.get(8)?,
        preview: row.get(9)?,
        message_count: row.get(10)?,
        updated_at: row.get(11)?,
        dropped: row.get::<_, i64>(12)? as u64,
        title_locked: row.get::<_, i64>(14)? != 0,
        archived_at: row.get(15)?,
        events,
    })
}

/// 按最后活跃时间淘汰旧会话。
pub fn prune(conn: &Connection, keep: usize) -> Result<usize, String> {
    let n = conn
        .execute(
            "DELETE FROM cc_sessions WHERE id NOT IN (
                SELECT id FROM cc_sessions
                ORDER BY last_active_at DESC, id DESC LIMIT ?1
             )",
            params![keep as i64],
        )
        .map_err(|e| format!("清理旧会话失败：{e}"))?;
    Ok(n)
}

/// 给「没有结局的待批单」补一条取消事件。
///
/// 落盘通常发生在 `Exit` 之后（进程已经没了），但事件流里可能还留着一条
/// `permissionAsk`。前端 reducer 会把没有结局的 ask 渲染成**正在等待批准**，
/// 而那个进程早就不在了 —— 用户点下去只会收到「这一轮已经结束，无法再批准」，
/// 反复点反复错，且没有任何线索说明它为什么点不动。
///
/// 补在末尾（而不是插到 ask 后面）是为了不动已发生事件的顺序：前端是按序重放的。
pub fn settle_pending(events: &[CcEvent]) -> Vec<CcEvent> {
    use std::collections::HashSet;

    let mut asked: Vec<String> = Vec::new();
    let mut settled: HashSet<&str> = HashSet::new();
    for e in events {
        match e {
            CcEvent::PermissionAsk { request_id, .. } | CcEvent::Question { request_id, .. } => {
                asked.push(request_id.clone());
            }
            CcEvent::PermissionCancel { request_id }
            | CcEvent::PermissionResolved { request_id, .. } => {
                settled.insert(request_id.as_str());
            }
            _ => {}
        }
    }
    let mut out = events.to_vec();
    for id in asked {
        if !settled.contains(id.as_str()) {
            out.push(CcEvent::PermissionCancel { request_id: id });
        }
    }
    out
}

/// 太长的快照从头丢，并且丢到一条完整用户消息为止。
///
/// 为什么必须落在用户消息边界：事件流是「用户说话 → 工具卡 → 回复」的序列，
/// 从中间切开会让界面以一张没有 tool_use 的工具结果卡开头，看起来像 bug。
pub fn trim_events(events: &[CcEvent], max_bytes: usize) -> (Vec<CcEvent>, u64) {
    let mut total = 0usize;
    let mut start = events.len();
    for (i, e) in events.iter().enumerate().rev() {
        total += serde_json::to_string(e).map(|s| s.len()).unwrap_or(0);
        if total > max_bytes {
            break;
        }
        start = i;
    }
    if start == 0 {
        return (events.to_vec(), 0);
    }
    // 往回切事件会把开头切在半截，往前挪到最近的一条用户消息。
    while start < events.len() && !matches!(events[start], CcEvent::UserMessage { .. }) {
        start += 1;
    }
    if start >= events.len() {
        // 整段没有用户消息（极端情况：只有一条巨长的工具结果）—— 宁可全丢也不留半截。
        return (Vec::new(), events.len() as u64);
    }
    (events[start..].to_vec(), start as u64)
}

/// 标题 = 第一条用户消息，压平换行、截 80 字。
///
/// 剥 `<file>` / `[Image #N]` 这类 CLI 注入的噪声留到期二（`cc_history/title.rs`），
/// 这里只做最小可用版本 —— 但逻辑独立成函数，届时替换它即可。
pub fn derive_title(events: &[CcEvent]) -> Option<String> {
    events.iter().find_map(|e| match e {
        CcEvent::UserMessage { text, images } => {
            let flat = flatten(text);
            if !flat.is_empty() {
                return Some(truncate_chars(&flat, 80));
            }
            // 纯图片消息没有文字。不补标题的话这条会话在列表里就是无名行，
            // 而「发了一张图问它哪里不对」正是最容易没文字的一类消息。
            (!images.is_empty()).then(|| format!("[{} 张图片]", images.len()))
        }
        _ => None,
    })
}

/// 预览 = 最后一条助手正文，截 120 字。列表里没有标题时的回退。
pub fn derive_preview(events: &[CcEvent]) -> Option<String> {
    events.iter().rev().find_map(|e| match e {
        CcEvent::Text { text, .. } => {
            let flat = flatten(text);
            if flat.is_empty() {
                None
            } else {
                Some(truncate_chars(&flat, 120))
            }
        }
        _ => None,
    })
}

/// 用户消息条数。列表里显示「12 条消息」用，不用打开文件数。
pub fn count_user_messages(events: &[CcEvent]) -> i64 {
    events
        .iter()
        .filter(|e| matches!(e, CcEvent::UserMessage { .. }))
        .count() as i64
}

fn flatten(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 按**字符**截断。按字节切会把中文切成半个，落进 SQLite 是乱码。
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 落盘时除了事件以外，前端还需要知道的元数据。
///
/// 单独定义而不是复用 `Snapshot`：`Snapshot` 带着 `events`，把这个结构塞进
/// `Shared` 会让「持有几十 KB 的事件」和「只持有几个字段」混成一谈。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFacts {
    pub connection_id: String,
    pub cwd: Option<String>,
    pub claude_path: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
}

impl SessionFacts {
    /// 拼成落盘用的快照。
    pub fn snapshot(
        &self,
        session_id: Option<String>,
        resume_id: Option<String>,
        events: Vec<CcEvent>,
    ) -> Snapshot {
        Snapshot {
            connection_id: self.connection_id.clone(),
            session_id,
            resume_id,
            cwd: self.cwd.clone(),
            claude_path: self.claude_path.clone(),
            model: self.model.clone(),
            permission_mode: self.permission_mode.clone(),
            events,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("内存库");
        ensure_table(&c).expect("建表");
        c
    }

    fn user(t: &str) -> CcEvent {
        CcEvent::UserMessage {
            text: t.into(),
            images: Vec::new(),
        }
    }

    fn text(t: &str) -> CcEvent {
        CcEvent::Text {
            block_id: "b".into(),
            text: t.into(),
            streaming: false,
        }
    }

    fn snap(events: Vec<CcEvent>) -> Snapshot {
        Snapshot {
            connection_id: String::new(),
            session_id: Some("s-1".into()),
            resume_id: Some("s-1".into()),
            cwd: Some("/tmp".into()),
            claude_path: Some("claude".into()),
            model: Some("m".into()),
            permission_mode: Some("default".into()),
            events,
        }
    }

    #[test]
    fn insert_then_update_reuses_same_row() {
        let c = conn();
        let id = save(&c, None, &snap(vec![user("第一句")])).expect("插入");
        let id2 = save(&c, Some(id), &snap(vec![user("第一句"), text("答")])).expect("更新");
        assert_eq!(id, id2, "同一会话必须更新同一行，不能每轮插一条");
        let total: i64 = c
            .query_row("SELECT COUNT(*) FROM cc_sessions", [], |r| r.get(0))
            .expect("计数");
        assert_eq!(total, 1);
    }

    /// 会话 id 在 `init` 到达后回填：插入时是 NULL，更新后才填上。
    #[test]
    fn session_id_is_backfilled_after_init() {
        let c = conn();
        let mut s = snap(vec![user("hi")]);
        s.session_id = None;
        s.resume_id = None;
        let id = save(&c, None, &s).expect("插入");
        s.session_id = Some("s-9".into());
        s.resume_id = Some("s-9".into());
        save(&c, Some(id), &s).expect("更新");
        let got = latest(&c).expect("读").expect("有值");
        assert_eq!(got.session_id.as_deref(), Some("s-9"));
        assert_eq!(got.resume_id.as_deref(), Some("s-9"));
    }

    #[test]
    fn latest_picks_most_recent() {
        let c = conn();
        let mut a = snap(vec![user("旧")]);
        a.session_id = Some("a".into());
        save(&c, None, &a).expect("插 a");
        // 让 b 明显更晚：直接改 last_active_at，避免测试依赖同秒内的时间戳。
        let mut b = snap(vec![user("新")]);
        b.session_id = Some("b".into());
        let id = save(&c, None, &b).expect("插 b");
        c.execute(
            "UPDATE cc_sessions SET last_active_at = 100 WHERE id = ?1",
            params![id],
        )
        .expect("抬高");
        c.execute("UPDATE cc_sessions SET last_active_at = 50", [])
            .expect("压低其余");
        let got = latest(&c).expect("读").expect("有值");
        assert_eq!(got.session_id.as_deref(), Some("b"));
    }

    /// 列表必须按最后活跃倒序，且**第一行就是 `latest` 会给的那条** ——
    /// 两个口径不一致时，用户看到「列表最上面那条」和「自动恢复打开的那条」
    /// 不是同一个，很容易以为恢复错了。
    #[test]
    fn list_matches_latest_order() {
        let c = conn();
        let mut a = snap(vec![user("旧")]);
        a.session_id = Some("a".into());
        let id_a = save(&c, None, &a).expect("插 a");
        let mut b = snap(vec![user("新")]);
        b.session_id = Some("b".into());
        let id_b = save(&c, None, &b).expect("插 b");
        c.execute(
            "UPDATE cc_sessions SET last_active_at = 100 WHERE id = ?1",
            params![id_b],
        )
        .expect("抬高");
        c.execute(
            "UPDATE cc_sessions SET last_active_at = 50 WHERE id = ?1",
            params![id_a],
        )
        .expect("压低");

        let rows = list(&c, 10, false).expect("列");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].row_id, id_b);
        assert_eq!(rows[0].session_id.as_deref(), Some("b"));
        assert_eq!(rows[1].row_id, id_a);
        assert_eq!(
            latest(&c).expect("读").expect("有值").row_id,
            rows[0].row_id,
            "第一行必须与 latest 一致"
        );
    }

    /// `limit` 生效：侧栏只摆最近几十条，不能把 100 条全拉给前端。
    #[test]
    fn list_respects_limit() {
        let c = conn();
        for i in 0..5 {
            let mut s = snap(vec![user(&format!("第{i}条"))]);
            s.session_id = Some(format!("s-{i}"));
            save(&c, None, &s).expect("插入");
        }
        assert_eq!(list(&c, 3, false).expect("列").len(), 3);
    }

    /// 按行号取要能拿到正文（侧栏点历史靠它载入）；行不在时是 `None` 而不是报错。
    #[test]
    fn by_row_id_reads_events_and_tolerates_missing() {
        let c = conn();
        let events = vec![user("历史里的问题"), text("历史里的回答")];
        let id = save(&c, None, &snap(events.clone())).expect("写");
        let got = by_row_id(&c, id).expect("读").expect("有值");
        assert_eq!(got.events, events);
        assert_eq!(got.title.as_deref(), Some("历史里的问题"));
        assert!(
            by_row_id(&c, id + 999).expect("查").is_none(),
            "行不存在应是 None"
        );
    }

    /// 行被 prune 掉之后仍要能落盘，不能因为 row_id 失效就把这一轮丢了。
    #[test]
    fn stale_row_id_falls_back_to_insert() {
        let c = conn();
        let id = save(&c, None, &snap(vec![user("x")])).expect("插入");
        c.execute("DELETE FROM cc_sessions", []).expect("清空");
        let id2 = save(&c, Some(id), &snap(vec![user("x")])).expect("应退回插入");
        assert_ne!(id, id2);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM cc_sessions", [], |r| r
                .get::<_, i64>(0))
                .expect("计数"),
            1
        );
    }

    #[test]
    fn title_preview_count() {
        let events = vec![user("  第一条\n  消息 "), text("回复正文"), user("第二条")];
        assert_eq!(derive_title(&events).as_deref(), Some("第一条 消息"));
        assert_eq!(derive_preview(&events).as_deref(), Some("回复正文"));
        assert_eq!(count_user_messages(&events), 2);
    }

    /// 中文标题必须按字符截，不能按字节 —— 按字节切会产出乱码。
    #[test]
    fn title_truncates_by_char_not_byte() {
        let long = "中".repeat(200);
        let title = derive_title(&[user(&long)]).expect("有标题");
        assert_eq!(title.chars().count(), 81, "80 字 + 省略号");
        assert!(title.ends_with('…'));
    }

    /// 纯图片消息没有文字，但必须有标题 —— 否则这条会话在列表里是无名行。
    #[test]
    fn title_of_image_only_message() {
        let only_img = CcEvent::UserMessage {
            text: String::new(),
            images: vec![
                "data:image/jpeg;base64,AAA".into(),
                "data:image/jpeg;base64,BBB".into(),
            ],
        };
        assert_eq!(derive_title(&[only_img]).as_deref(), Some("[2 张图片]"));
    }

    /// 有空文字的用户消息排在前面时，标题要接着往后找，而不是定格在空串上。
    #[test]
    fn title_skips_empty_user_message() {
        let events = vec![user("   "), user("真正的问题")];
        assert_eq!(derive_title(&events).as_deref(), Some("真正的问题"));
    }

    /// 🔴 缩略图要能原样落盘再读回来。
    ///
    /// 这条链上有两个 serde 属性（`default` + `skip_serializing_if`），配错了
    /// 表现分别是「老流水整箱读不出」和「新流水读回来图没了」，都不会报错。
    #[test]
    fn user_message_images_roundtrip() {
        let e = CcEvent::UserMessage {
            text: "看图".into(),
            images: vec!["data:image/jpeg;base64,AAA".into()],
        };
        let json = serde_json::to_string(&e).expect("序列化");
        assert!(
            json.contains("data:image/jpeg"),
            "缩略图必须进 JSON：{json}"
        );
        let back: CcEvent = serde_json::from_str(&json).expect("反序列化");
        assert_eq!(back, e);
    }

    /// 2026-10-26 之前落盘的事件没有 `images` 字段，读回来必须是空数组而不是报错。
    #[test]
    fn old_user_message_without_images_still_parses() {
        let back: CcEvent = serde_json::from_str(r#"{"kind":"userMessage","text":"老消息"}"#)
            .expect("老流水要能读");
        assert_eq!(
            back,
            CcEvent::UserMessage {
                text: "老消息".into(),
                images: Vec::new()
            }
        );
    }

    /// 超限时从头丢，且必须落在一条用户消息上。
    #[test]
    fn trim_starts_at_user_message_boundary() {
        let big = "x".repeat(2000);
        let events = vec![
            user("一"),
            CcEvent::ToolResult {
                tool_use_id: "t1".into(),
                content: big.clone(),
                is_error: false,
            },
            user("二"),
            text(&big),
        ];
        // 上限卡在「只装得下最后两条」的位置：text(≈2.1KB) + user(≈33B)。
        let (kept, dropped) = trim_events(&events, 2500);
        assert!(dropped > 0, "应当丢掉开头");
        assert!(
            matches!(kept.first(), Some(CcEvent::UserMessage { text, .. }) if text == "二"),
            "开头必须是完整用户消息：{:?}",
            kept.first()
        );
        assert_eq!(dropped as usize, 2);
    }

    /// 没超限就一条都不动（否则正常会话会被莫名其妙裁掉）。
    #[test]
    fn trim_keeps_everything_under_limit() {
        let events = vec![user("一"), text("二")];
        let (kept, dropped) = trim_events(&events, MAX_EVENTS_BYTES);
        assert_eq!(kept.len(), 2);
        assert_eq!(dropped, 0);
    }

    /// 落盘再读回，事件必须逐条相等（前端靠这个重放）。
    #[test]
    fn events_roundtrip_through_db() {
        let c = conn();
        let events = vec![
            user("你好"),
            CcEvent::ToolUse {
                tool_use_id: "t1".into(),
                name: "Bash".into(),
                input: json!({"command": "ls"}),
            },
            text("好"),
        ];
        save(&c, None, &snap(events.clone())).expect("写");
        let got = latest(&c).expect("读").expect("有值");
        assert_eq!(got.events, events, "事件必须原样往返");
    }

    #[test]
    fn prune_keeps_newest() {
        let c = conn();
        for i in 0..5 {
            let mut s = snap(vec![user(&format!("会话{i}"))]);
            s.session_id = Some(format!("s-{i}"));
            let id = save(&c, None, &s).expect("插");
            c.execute(
                "UPDATE cc_sessions SET last_active_at = ?1 WHERE id = ?2",
                params![i as i64, id],
            )
            .expect("改时间");
        }
        let removed = prune(&c, 2).expect("清理");
        assert_eq!(removed, 3);
        let got = latest(&c).expect("读").expect("有值");
        assert_eq!(got.session_id.as_deref(), Some("s-4"), "留下最新的");
    }

    /// 空库不能报错 —— 首次启动就是这个状态。
    #[test]
    fn latest_on_empty_db_is_none() {
        assert!(latest(&conn()).expect("读").is_none());
    }

    fn ask(id: &str) -> CcEvent {
        CcEvent::PermissionAsk {
            request_id: id.into(),
            tool_name: "Bash".into(),
            input: json!({"command": "ls"}),
            tool_use_id: None,
            reason: None,
        }
    }

    /// 真机上必现：用户拒了审批、进程退出，事件流里那条 ask 没有结局。
    /// 不补 cancel，恢复出来就是一张点不动的僵尸卡。
    #[test]
    fn unsettled_ask_gets_a_cancel_event() {
        let events = vec![user("跑测试"), ask("r1"), CcEvent::Exit { code: None }];
        let out = settle_pending(&events);
        assert_eq!(out.len(), 4, "{out:?}");
        assert!(
            matches!(out.last(), Some(CcEvent::PermissionCancel { request_id }) if request_id == "r1"),
            "{out:?}"
        );
    }

    /// 已经有结局的（用户点过 / CLI 撤回）不能重复补。
    #[test]
    fn settled_ask_is_left_alone() {
        let events = vec![
            ask("r1"),
            CcEvent::PermissionResolved {
                request_id: "r1".into(),
                decision: "deny".into(),
                auto: false,
            },
            ask("r2"),
            CcEvent::PermissionCancel {
                request_id: "r2".into(),
            },
        ];
        assert_eq!(settle_pending(&events), events, "不能多也不能少");
    }

    /// 提问与审批同构，同样会被挂死。
    #[test]
    fn unsettled_question_also_gets_cancelled() {
        let events = vec![CcEvent::Question {
            request_id: "q1".into(),
            tool_use_id: None,
            input: json!({"questions": []}),
        }];
        let out = settle_pending(&events);
        assert!(
            matches!(out.last(), Some(CcEvent::PermissionCancel { request_id }) if request_id == "q1"),
            "{out:?}"
        );
    }

    // ---- 改名 / 归档（3-1d） ----

    /// 🔴 改名必须扛得住下一次落盘。
    ///
    /// `save` 每次都用首条用户消息重算标题 —— 没有 `title_locked` 的话，用户改完
    /// 名字发下一句就变回自动标题，而且没有任何提示，看起来像「改名没生效」。
    #[test]
    fn rename_survives_next_save() {
        let c = conn();
        let id = save(&c, None, &snap(vec![user("原来的自动标题")])).expect("插入");
        let title = rename(&c, id, "  客户 A · 发票导出  ").expect("改名");
        assert_eq!(title, "客户 A · 发票导出", "首尾空白要被压掉");
        // 再落一次盘（内容还变了）。
        save(
            &c,
            Some(id),
            &snap(vec![user("原来的自动标题"), text("新回复")]),
        )
        .expect("更新");
        let got = by_row_id(&c, id).expect("读").expect("有值");
        assert_eq!(
            got.title.as_deref(),
            Some("客户 A · 发票导出"),
            "手写标题不能被覆盖"
        );
        assert!(got.title_locked);
    }

    /// 没改过名的会话照旧跟着首条消息走（不然行为变了没人发现）。
    #[test]
    fn auto_title_still_follows_first_message() {
        let c = conn();
        let id = save(&c, None, &snap(vec![user("第一版")])).expect("插入");
        save(&c, Some(id), &snap(vec![user("第二版")])).expect("更新");
        let got = by_row_id(&c, id).expect("读").expect("有值");
        assert_eq!(got.title.as_deref(), Some("第二版"));
        assert!(!got.title_locked);
    }

    /// 空白标题必须拒绝：一行没有标题的会话，用户再也认不出它是什么。
    #[test]
    fn blank_rename_is_rejected() {
        let c = conn();
        let id = save(&c, None, &snap(vec![user("x")])).expect("插入");
        assert!(rename(&c, id, "   \n ").is_err());
        assert!(rename(&c, id, "").is_err());
        // 行不存在时给一句能懂的话，而不是 `Ok` 让界面显示改成功了。
        let err = rename(&c, id + 99, "新名字").expect_err("必须报错");
        assert!(err.contains("不在库里"), "{err}");
    }

    /// 超长标题按**字符**截断（中文按字节切会出乱码）。
    #[test]
    fn long_rename_truncates_by_char() {
        let c = conn();
        let id = save(&c, None, &snap(vec![user("x")])).expect("插入");
        let long = "中".repeat(MAX_TITLE_CHARS + 50);
        let title = rename(&c, id, &long).expect("改名");
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS + 1, "上限 + 省略号");
        assert!(title.ends_with('…'));
    }

    /// 归档 = 从默认列表与「自动恢复」里消失，而不是删掉。
    #[test]
    fn archived_hides_from_list_and_latest() {
        let c = conn();
        let mut s = snap(vec![user("要归档的")]);
        s.session_id = Some("s-old".into());
        let old = save(&c, None, &s).expect("插 old");
        let mut s = snap(vec![user("还留着的")]);
        s.session_id = Some("s-new".into());
        let new = save(&c, None, &s).expect("插 new");
        c.execute(
            "UPDATE cc_sessions SET last_active_at = last_active_at + 100 WHERE id = ?1",
            params![old],
        )
        .expect("抬高");

        assert_eq!(latest(&c).expect("读").expect("有值").row_id, old);
        set_archived(&c, old, true).expect("归档");

        let rows = list(&c, 10, false).expect("列");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].row_id, new, "归档的不摆");
        assert_eq!(
            latest(&c).expect("读").expect("有值").row_id,
            new,
            "自动恢复必须跳过归档的"
        );

        // 「显示已归档」能把它捞回来，且带归档标记。
        let all = list(&c, 10, true).expect("列");
        assert_eq!(all.len(), 2);
        let got = all.iter().find(|r| r.row_id == old).expect("有它");
        assert!(got.archived_at.is_some());

        // 归档不删内容：点开还能看。
        assert_eq!(
            by_row_id(&c, old).expect("读").expect("有值").events.len(),
            1
        );

        // 取消归档回到默认列表。
        set_archived(&c, old, false).expect("取消归档");
        assert_eq!(list(&c, 10, false).expect("列").len(), 2);
        assert!(by_row_id(&c, old)
            .expect("读")
            .expect("有值")
            .archived_at
            .is_none());
    }

    /// 老库（没有这两列）要能就地补上，不能一启动就报错。
    ///
    /// 这是升级路径的回归：`CREATE TABLE IF NOT EXISTS` 对已存在的表什么都不做。
    #[test]
    fn old_table_gets_new_columns() {
        let c = Connection::open_in_memory().expect("内存库");
        c.execute_batch(
            "CREATE TABLE cc_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                connection_id TEXT NOT NULL DEFAULT '',
                session_id TEXT, resume_id TEXT, cwd TEXT, claude_path TEXT,
                model TEXT, permission_mode TEXT, title TEXT, preview TEXT,
                message_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                last_active_at INTEGER NOT NULL, file_size INTEGER,
                file_mtime_ms INTEGER, source TEXT NOT NULL DEFAULT 'local',
                dropped INTEGER NOT NULL DEFAULT 0, events_json TEXT
            );",
        )
        .expect("老表");
        ensure_table(&c).expect("补列");
        // 补完就能用新语义（默认值 = 没改名、没归档）。
        let id = save(&c, None, &snap(vec![user("老会话")])).expect("插入");
        let got = by_row_id(&c, id).expect("读").expect("有值");
        assert!(!got.title_locked);
        assert!(got.archived_at.is_none());
        rename(&c, id, "补列之后仍能改名").expect("改名");
    }
}
