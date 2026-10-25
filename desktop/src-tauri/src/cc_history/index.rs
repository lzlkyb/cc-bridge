//! 历史索引：把「扫到的文件」和「解析出来的元信息」落到库里。
//!
//! ## 为什么要有这张表（明明能每次现扫）
//!
//! 1. **两级门禁**需要记住上一次的 `(size, mtime)`，否则每次进对话页都要把
//!    60 个文件（24MB）重新解析一遍。
//! 2. **远端必须缓存**：断网 / 换了网络 / 改了密码之后，那条会话的列表项还得在，
//!    否则用户会说「我的历史没了」—— 而文件还好端端躺在远端。
//! 3. 期三的搜索、重命名、置顶都挂在这张表上（`pinned` / `custom_title` 只是
//!    索引层的字段，**永远不写回 CLI 的 jsonl**）。
//!
//! ## 主键为什么是 `(connection_id, session_id)`
//!
//! 同一个人可能给同一台机器存两条连接（不同 user / port），两台不同的机器也
//! 完全可能有同名 uuid 目录。只按 `session_id` 做主键会让它们互相覆盖 ——
//! 表现是「历史列表里少了一半」，且没有任何报错。
//!
//! 本机的 `connection_id` 是空串。

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// 库里的一条历史会话。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// 空串 = 本机。
    pub connection_id: String,
    pub session_id: String,
    /// 本机绝对路径，或远端路径。打开时用。
    pub path: String,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub title: String,
    pub preview: Option<String>,
    pub message_count: i64,
    pub file_size: i64,
    pub file_mtime_ms: i64,
    /// 最后活跃时间（秒）。列表按它倒序。
    pub last_used_at: i64,
    /// 正文有没有缓存（远端断网时靠它）。本机永远`false` —— 文件就在盘上。
    pub cached: bool,
}

pub fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cc_history (
            connection_id TEXT    NOT NULL DEFAULT '',
            session_id    TEXT    NOT NULL,
            path          TEXT    NOT NULL DEFAULT '',
            cwd           TEXT,
            git_branch    TEXT,
            title         TEXT    NOT NULL DEFAULT '',
            preview       TEXT,
            message_count INTEGER NOT NULL DEFAULT 0,
            file_size     INTEGER NOT NULL DEFAULT 0,
            file_mtime_ms INTEGER NOT NULL DEFAULT 0,
            last_used_at  INTEGER NOT NULL DEFAULT 0,
            scanned_at    INTEGER NOT NULL DEFAULT 0,
            body_json     TEXT,
            PRIMARY KEY (connection_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS cc_history_recent
            ON cc_history(connection_id, last_used_at DESC);",
    )
    .map_err(|e| format!("建 cc_history 表失败：{e}"))
}

/// 上一次扫描留下的 `(size, mtime_ms)`。二级门禁的第一级。
pub fn signatures(conn: &Connection, connection_id: &str) -> HashMap<String, (i64, i64)> {
    let mut out = HashMap::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id, file_size, file_mtime_ms FROM cc_history WHERE connection_id = ?1",
    ) else {
        return out;
    };
    let rows = stmt.query_map(params![connection_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?),
        ))
    });
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            out.insert(row.0, row.1);
        }
    }
    out
}

/// 写入 / 更新一条。不动 `body_json` —— 那是 [`save_body`] 的事，
/// 覆盖元信息时顺手把已缓存的正文抹掉会让「离线也能看」在某次扫描后失效。
pub fn upsert(conn: &Connection, row: &Row) -> Result<(), String> {
    conn.execute(
        "INSERT INTO cc_history(
            connection_id, session_id, path, cwd, git_branch, title, preview,
            message_count, file_size, file_mtime_ms, last_used_at, scanned_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(connection_id, session_id) DO UPDATE SET
            path = excluded.path,
            cwd = excluded.cwd,
            git_branch = excluded.git_branch,
            title = excluded.title,
            preview = excluded.preview,
            message_count = excluded.message_count,
            file_size = excluded.file_size,
            file_mtime_ms = excluded.file_mtime_ms,
            last_used_at = excluded.last_used_at,
            scanned_at = excluded.scanned_at",
        params![
            row.connection_id,
            row.session_id,
            row.path,
            row.cwd,
            row.git_branch,
            row.title,
            row.preview,
            row.message_count,
            row.file_size,
            row.file_mtime_ms,
            row.last_used_at,
            now_secs(),
        ],
    )
    .map_err(|e| format!("写入历史索引失败：{e}"))?;
    Ok(())
}

/// 一个连接下的全部历史，新的在前。
pub fn list(conn: &Connection, connection_id: &str) -> Result<Vec<Row>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT connection_id, session_id, path, cwd, git_branch, title, preview,
                    message_count, file_size, file_mtime_ms, last_used_at,
                    body_json IS NOT NULL
             FROM cc_history
             WHERE connection_id = ?1
             ORDER BY last_used_at DESC, session_id DESC",
        )
        .map_err(|e| format!("查询历史失败：{e}"))?;
    let rows = stmt
        .query_map(params![connection_id], map_row)
        .map_err(|e| format!("查询历史失败：{e}"))?;
    Ok(rows.flatten().collect())
}

/// 按关键词搜历史。命中字段：`title` + `preview`（列表上看得见的两个）。
///
/// ## 为什么只搜这两个字段
///
/// `cwd` / `git_branch` 也能搜，但命中了用户在列表上看不出为什么 —— 高亮只加在
/// 标题和摘要上，搜不可见的字段等于「莫名出现的结果」。
///
/// ## 匹配策略：`<3` 字符整串 LIKE，`≥3` 字符 3 字滑窗 AND
///
/// 中文没有词边界，整串 LIKE 要求完全连续，用户记不清中间的字就搜不到；
/// 3 字滑窗（SQLite FTS5 trigram 的同款思路）把查询拆成互相重叠的 3 字片段，
/// 逐个 LIKE 再 AND：每个窗口都出现就算命中，哪怕它们分别来自标题和摘要、
/// 相隔很远。它是整串 LIKE 的**超集** —— 连续命中的一定照样命中。
/// 代价说清楚：插入正好落在某个 3 字窗口内时会漏（「修复登录页」搜不到
/// 「修复了登录页」）—— 这是 trigram 的固有权衡，`chinese_trigram_tradeoff`
/// 那条测试把它锁着，不是 bug。
/// 短查询（1-2 字符）不拆：整串 LIKE 已经够用，拆开了只会更宽。
///
/// 前端 `lib/ccHighlight.ts` 用同一套切片规则做高亮，两边用同一批例子锁死，
/// 改一边必须同步改另一边。
pub fn search(conn: &Connection, connection_id: &str, query: &str) -> Result<Vec<Row>, String> {
    let q = query.trim();
    if q.is_empty() {
        return list(conn, connection_id);
    }
    let likes: Vec<String> = search_chunks(q)
        .iter()
        .map(|c| format!("%{}%", escape_like(c)))
        .collect();
    let mut sql = String::from(
        "SELECT connection_id, session_id, path, cwd, git_branch, title, preview,
                message_count, file_size, file_mtime_ms, last_used_at,
                body_json IS NOT NULL
         FROM cc_history
         WHERE connection_id = ?1",
    );
    for _ in &likes {
        sql.push_str(" AND (title LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\')");
    }
    sql.push_str(" ORDER BY last_used_at DESC, session_id DESC");

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("查询历史失败：{e}"))?;
    // 参数化：查询文本永远不进 SQL 字符串（注入面为零），`%` / `_` 也已转义成字面量。
    let mut params: Vec<&str> = Vec::with_capacity(1 + likes.len() * 2);
    params.push(connection_id);
    for like in &likes {
        params.push(like);
        params.push(like);
    }
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), map_row)
        .map_err(|e| format!("查询历史失败：{e}"))?;
    Ok(rows.flatten().collect())
}

/// 查询切片：`<3` 字符原样一片，`≥3` 字符按 3 字**滑窗**（互相重叠）拆。
///
/// 按字符不按字节：中文一个字 3 字节，按字节切会把字劈开。
pub fn search_chunks(query: &str) -> Vec<String> {
    let chars: Vec<char> = query.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    if chars.len() < 3 {
        return vec![query.to_string()];
    }
    (0..=chars.len() - 3)
        .map(|i| chars[i..i + 3].iter().collect())
        .collect()
}

/// LIKE 通配符转义：用户搜 `100%` 时它必须是字面量，
/// 否则 `%` 变成「后面随便」—— 搜出来的东西莫名其妙地多。
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 单条。打开一条历史时先取它（拿 `path` / `cwd` 与缓存正文）。
pub fn get(
    conn: &Connection,
    connection_id: &str,
    session_id: &str,
) -> Result<Option<Row>, String> {
    conn.query_row(
        "SELECT connection_id, session_id, path, cwd, git_branch, title, preview,
                message_count, file_size, file_mtime_ms, last_used_at,
                body_json IS NOT NULL
         FROM cc_history
         WHERE connection_id = ?1 AND session_id = ?2",
        params![connection_id, session_id],
        map_row,
    )
    .optional()
    .map_err(|e| format!("读取历史条目失败：{e}"))
}

/// 缓存正文（远端专用）。本机不写 —— 文件就在盘上，缓存只会让「文件变了」
/// 和「缓存旧了」这两件事对不上。
pub fn save_body(
    conn: &Connection,
    connection_id: &str,
    session_id: &str,
    body: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE cc_history SET body_json = ?3 WHERE connection_id = ?1 AND session_id = ?2",
        params![connection_id, session_id, body],
    )
    .map_err(|e| format!("缓存会话正文失败：{e}"))?;
    Ok(())
}

/// 已缓存的正文。
pub fn body(conn: &Connection, connection_id: &str, session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT body_json FROM cc_history WHERE connection_id = ?1 AND session_id = ?2",
        params![connection_id, session_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
}

/// 删掉「这次扫描没看到」的条目。**只对本机调用**。
///
/// 🔴 远端不能用它：远端扫描失败（断网、密码改了、目录被挪走）时 `keep` 会是空的，
/// 一删就把用户全部远端历史清空 —— 而文件在远端好端端的。
pub fn prune_missing(
    conn: &Connection,
    connection_id: &str,
    keep: &[String],
) -> Result<usize, String> {
    let keep: HashSet<&str> = keep.iter().map(String::as_str).collect();
    let existing: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT session_id FROM cc_history WHERE connection_id = ?1")
            .map_err(|e| format!("查询历史失败：{e}"))?;
        let rows = stmt
            .query_map(params![connection_id], |r| r.get::<_, String>(0))
            .map_err(|e| format!("查询历史失败：{e}"))?;
        rows.flatten().collect()
    };
    let mut removed = 0;
    for sid in existing {
        if keep.contains(sid.as_str()) {
            continue;
        }
        removed += conn
            .execute(
                "DELETE FROM cc_history WHERE connection_id = ?1 AND session_id = ?2",
                params![connection_id, sid],
            )
            .map_err(|e| format!("删除失效历史失败：{e}"))?;
    }
    Ok(removed)
}

/// 条目总数。探针与「扫到了几条」的日志用。
pub fn count(conn: &Connection, connection_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM cc_history WHERE connection_id = ?1",
        params![connection_id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        connection_id: row.get(0)?,
        session_id: row.get(1)?,
        path: row.get(2)?,
        cwd: row.get(3)?,
        git_branch: row.get(4)?,
        title: row.get(5)?,
        preview: row.get(6)?,
        message_count: row.get(7)?,
        file_size: row.get(8)?,
        file_mtime_ms: row.get(9)?,
        last_used_at: row.get(10)?,
        cached: row.get(11)?,
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("内存库");
        ensure_table(&c).expect("建表");
        c
    }

    fn row(sid: &str, mtime: i64) -> Row {
        Row {
            connection_id: String::new(),
            session_id: sid.into(),
            path: format!("/p/{sid}.jsonl"),
            cwd: Some("/proj".into()),
            git_branch: Some("main".into()),
            title: format!("标题 {sid}"),
            preview: None,
            message_count: 3,
            file_size: 100,
            file_mtime_ms: mtime,
            last_used_at: mtime / 1000,
            cached: false,
        }
    }

    #[test]
    fn upsert_is_idempotent_and_updates_meta() {
        let c = conn();
        upsert(&c, &row("a", 1000)).expect("插");
        let mut again = row("a", 2000);
        again.title = "改过的标题".into();
        upsert(&c, &again).expect("再插");
        assert_eq!(count(&c, ""), 1, "同主键必须更新而不是插新行");
        let got = get(&c, "", "a").expect("读").expect("有值");
        assert_eq!(got.title, "改过的标题");
        assert_eq!(got.file_mtime_ms, 2000);
    }

    /// 🔴 两个连接上的同名 session id 必须是两条 —— 只按 session_id 做键
    /// 会让历史列表凭空少一半。
    #[test]
    fn same_session_id_on_two_connections_coexist() {
        let c = conn();
        let mut local = row("dup", 1000);
        local.connection_id = String::new();
        let mut remote = row("dup", 2000);
        remote.connection_id = "conn-1".into();
        upsert(&c, &local).expect("插本机");
        upsert(&c, &remote).expect("插远端");
        assert_eq!(count(&c, ""), 1);
        assert_eq!(count(&c, "conn-1"), 1);
        assert_eq!(list(&c, "").expect("列").len(), 1);
    }

    #[test]
    fn list_is_newest_first() {
        let c = conn();
        for (sid, mtime) in [
            ("old", 1_000_000i64),
            ("new", 3_000_000),
            ("mid", 2_000_000),
        ] {
            upsert(&c, &row(sid, mtime)).expect("插");
        }
        let ids: Vec<String> = list(&c, "")
            .expect("列")
            .into_iter()
            .map(|r| r.session_id)
            .collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    /// 搜索用的行：标题和摘要都要能指定。
    fn srow(sid: &str, title: &str, preview: Option<&str>) -> Row {
        Row {
            title: title.into(),
            preview: preview.map(str::to_string),
            ..row(sid, 1000)
        }
    }

    /// 空查询 = 全量（面板刚打开、还没打字就是这个状态）。
    #[test]
    fn search_empty_query_lists_everything() {
        let c = conn();
        upsert(&c, &srow("a", "修复登录页", None)).expect("插");
        upsert(&c, &srow("b", "终端配色", None)).expect("插");
        assert_eq!(search(&c, "", "").expect("搜").len(), 2);
        assert_eq!(
            search(&c, "", "   ").expect("搜").len(),
            2,
            "全空白同空查询"
        );
    }

    /// `<3` 字符走整串 LIKE：必须连续出现，顺序也不能反。
    #[test]
    fn search_short_query_needs_contiguous_match() {
        let c = conn();
        upsert(&c, &srow("a", "修复登录页的样式", None)).expect("插");
        assert_eq!(search(&c, "", "登录").expect("搜").len(), 1);
        assert_eq!(
            search(&c, "", "录登").expect("搜").len(),
            0,
            "顺序反了不算命中"
        );
        // 中间插了字：2 字符查询不做滑窗，搜不到（复与录之间隔着登）。
        assert_eq!(search(&c, "", "复录").expect("搜").len(), 0);
    }

    /// `≥3` 字符按 3 字滑窗 AND：每个窗口出现就算命中，
    /// 哪怕它们一个在标题里、一个在摘要里，相隔很远 —— 整串 LIKE 做不到这个。
    #[test]
    fn search_long_query_matches_across_fields() {
        let c = conn();
        upsert(&c, &srow("a", "修复登录", Some("交互细节见登录页"))).expect("插");
        // 「修复登录页」→ 修复登 / 复登录（标题）/ 登录页（摘要）三片齐全。
        assert_eq!(search(&c, "", "修复登录页").expect("搜").len(), 1);
    }

    /// trigram 的固有权衡：插入落在某个 3 字窗口内就漏。
    /// 这不是 bug 是取舍（`search` 的注释里写着），测试把它锁住，
    /// 防止将来有人「顺手修一下」让行为变得不可预测。
    #[test]
    fn chinese_trigram_tradeoff_is_locked() {
        let c = conn();
        upsert(&c, &srow("a", "修复了登录页", None)).expect("插");
        assert_eq!(search(&c, "", "修复登录页").expect("搜").len(), 0);
    }

    /// 命中的是摘要也算（标题没提，预览里提了）。
    #[test]
    fn search_matches_preview_too() {
        let c = conn();
        upsert(&c, &srow("a", "随便起的标题", Some("第二段：讲讲端口转发"))).expect("插");
        assert_eq!(search(&c, "", "端口转发").expect("搜").len(), 1);
        assert_eq!(search(&c, "", "标题").expect("搜").len(), 1, "标题照样能搜");
    }

    /// ASCII 大小写不敏感（SQLite LIKE 的默认行为，前端高亮同步忽略大小写）。
    #[test]
    fn search_is_case_insensitive_for_ascii() {
        let c = conn();
        upsert(&c, &srow("a", "Fix the Login Bug", None)).expect("插");
        assert_eq!(search(&c, "", "fix the").expect("搜").len(), 1);
        assert_eq!(search(&c, "", "LOGIN").expect("搜").len(), 1);
    }

    /// `%` `_` 必须是字面量：搜 `100%` 不能变成「100 后面随便」。
    #[test]
    fn search_treats_like_wildcards_as_literals() {
        let c = conn();
        upsert(&c, &srow("a", "覆盖率 100% 达成", None)).expect("插");
        upsert(&c, &srow("b", "覆盖率 100 万", None)).expect("插");
        assert_eq!(
            search(&c, "", "100%").expect("搜").len(),
            1,
            "只有带 % 的那条"
        );
        assert_eq!(
            search(&c, "", "100_").expect("搜").len(),
            0,
            "没有字面 100_"
        );
    }

    /// 只搜当前连接：远端的条目不能被本机的查询翻出来。
    #[test]
    fn search_is_scoped_to_connection() {
        let c = conn();
        let mut remote = srow("r", "远端修复登录", None);
        remote.connection_id = "conn-1".into();
        upsert(&c, &remote).expect("插远端");
        assert_eq!(search(&c, "", "修复登录").expect("搜").len(), 0);
        assert_eq!(search(&c, "conn-1", "修复登录").expect("搜").len(), 1);
    }

    /// 切片规则本身：空查询空向量、`<3` 一片、`≥3` 滑窗。
    /// 前端 `ccHighlight.ts` 的 `searchChunks` 必须给出同一批结果。
    #[test]
    fn search_chunks_splits_by_sliding_window() {
        assert!(search_chunks("").is_empty());
        assert_eq!(search_chunks("登"), vec!["登"]);
        assert_eq!(search_chunks("登录"), vec!["登录"]);
        assert_eq!(search_chunks("修复登录"), vec!["修复登", "复登录"]);
        assert_eq!(search_chunks("abcd"), vec!["abc", "bcd"]);
    }

    /// 元信息更新不能把已缓存的正文抹掉：抹了之后断网就看不到那条了。
    #[test]
    fn upsert_keeps_cached_body() {
        let c = conn();
        upsert(&c, &row("a", 1000)).expect("插");
        save_body(&c, "", "a", Some("{\"events\":[]}")).expect("缓存");
        upsert(&c, &row("a", 2000)).expect("再插");
        assert_eq!(body(&c, "", "a").as_deref(), Some("{\"events\":[]}"));
        assert!(get(&c, "", "a").expect("读").expect("有").cached);
    }

    /// 本机删了 jsonl ⇒ 条目跟着消失。
    #[test]
    fn prune_removes_vanished_files() {
        let c = conn();
        for sid in ["a", "b", "c"] {
            upsert(&c, &row(sid, 1000)).expect("插");
        }
        let removed = prune_missing(&c, "", &["a".into()]).expect("清理");
        assert_eq!(removed, 2);
        let ids: Vec<String> = list(&c, "")
            .expect("列")
            .into_iter()
            .map(|r| r.session_id)
            .collect();
        assert_eq!(ids, vec!["a"]);
    }

    /// 只删本机的：远端的条目不能被本机扫描顺手清掉。
    #[test]
    fn prune_does_not_touch_other_connections() {
        let c = conn();
        let mut remote = row("r1", 1000);
        remote.connection_id = "conn-1".into();
        upsert(&c, &remote).expect("插远端");
        prune_missing(&c, "", &[]).expect("清理本机");
        assert_eq!(count(&c, "conn-1"), 1, "远端条目必须还在");
    }

    #[test]
    fn signatures_reflect_stored_state() {
        let c = conn();
        assert!(signatures(&c, "").is_empty());
        upsert(&c, &row("a", 4000)).expect("插");
        let sig = signatures(&c, "");
        assert_eq!(sig.get("a"), Some(&(100, 4000)));
    }

    #[test]
    fn empty_db_is_not_an_error() {
        let c = conn();
        assert!(list(&c, "").expect("列").is_empty());
        assert!(get(&c, "", "nope").expect("读").is_none());
        assert!(body(&c, "", "nope").is_none());
    }
}
