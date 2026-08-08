//! 工具清单（manifest）的抓取与持久化。
//!
//! 🔴 **为何非落盘不可**（方案 §3 / §7.3）：
//!
//! 1. **N 个 server 下的发现成本**。若“要列工具就先握手”，首次调用就会冷启动全部 server。
//!    本机已有 3 个（两个 Node、一个 Python），十几秒起步——而那还只是模型“想看看有什么工具”。
//! 2. **第二步扁平化的硬前提**。`all_tools()` 不接任何参数且是同步的，`WRITE_SET` 的
//!    `OnceLock` 在进程内只算一次。要把外挂工具列进 `tools/list`，就必须有一份
//!    **启动时能同步读到、不依赖任何子进程活着**的清单。
//!
//! 本模块**不启进程**：抓取接一个已握手的 `Client`，所以连抓取都能用内存管道单测。

use std::time::Duration;

use rusqlite::{params, Connection};
use serde_json::Value;

use super::client::Client;
use super::config::ExternalMcpServer;

/// 一份已缓存的工具清单。
#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub server: String,
    pub fingerprint: String,
    pub server_info: Value,
    pub instructions: Option<String>,
    /// `tools` 数组原文，含完整 `inputSchema`。
    pub tools: Value,
    /// Unix 秒。只用于展示“什么时候抓的”，**不做过期判定**——方案明确不做定期刷新。
    pub fetched_at: i64,
}

impl Manifest {
    pub fn tool_count(&self) -> usize {
        self.tools.as_array().map(|a| a.len()).unwrap_or(0)
    }

    /// 配置变了吗？变了就该重抓。
    pub fn is_stale_for(&self, spec: &ExternalMcpServer) -> bool {
        self.fingerprint != spec.fingerprint()
    }
}

/// 建表。由 `db::init_database` 调用。
///
/// 与配置分开存：它是**可重建的缓存**，删了只是要重抓一次，不应跟用户配置混在一张表里。
pub fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mcp_manifest (
            server       TEXT PRIMARY KEY NOT NULL,
            fingerprint  TEXT NOT NULL,
            server_info  TEXT NOT NULL,
            instructions TEXT,
            tools        TEXT NOT NULL,
            fetched_at   INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("创建 mcp_manifest 表失败：{e}"))
}

/// 从一个**已握手**的连接上抓取清单。
///
/// 握手已经拿到了 `serverInfo` 与 `instructions`，这里只需再要一次 `tools/list`。
pub fn capture(
    client: &mut Client,
    spec: &ExternalMcpServer,
    timeout: Duration,
    now: i64,
) -> Result<Manifest, String> {
    let tools = client.list_tools(timeout)?;
    Ok(Manifest {
        server: spec.name.clone(),
        fingerprint: spec.fingerprint(),
        server_info: client.server_info().clone(),
        instructions: client.instructions().map(|s| s.to_string()),
        tools,
        fetched_at: now,
    })
}

pub fn save(conn: &Connection, m: &Manifest) -> Result<(), String> {
    conn.execute(
        "INSERT INTO mcp_manifest (server, fingerprint, server_info, instructions, tools, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(server) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            server_info = excluded.server_info,
            instructions = excluded.instructions,
            tools = excluded.tools,
            fetched_at = excluded.fetched_at",
        params![
            m.server,
            m.fingerprint,
            m.server_info.to_string(),
            m.instructions,
            m.tools.to_string(),
            m.fetched_at,
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("写入 mcp_manifest 失败：{e}"))
}

/// 读一份清单。**不启任何进程**。
///
/// 行损坏（tools 存的不是合法 JSON）时返回 `Ok(None)` 而不是 `Err`：
/// 对调用方而言“缓存不可用”与“没有缓存”是同一件事——都是重抓，不该报错阻断列表。
pub fn load(conn: &Connection, server: &str) -> Result<Option<Manifest>, String> {
    let row = conn
        .query_row(
            "SELECT fingerprint, server_info, instructions, tools, fetched_at
             FROM mcp_manifest WHERE server = ?1",
            params![server],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("读取 mcp_manifest 失败：{other}")),
        })?;

    let Some((fingerprint, info, instructions, tools, fetched_at)) = row else {
        return Ok(None);
    };
    let Ok(tools) = serde_json::from_str::<Value>(&tools) else {
        log::warn!("mcp_manifest[{server}] 的 tools 字段不是合法 JSON，当作无缓存处理");
        return Ok(None);
    };
    Ok(Some(Manifest {
        server: server.to_string(),
        fingerprint,
        server_info: serde_json::from_str(&info).unwrap_or(Value::Null),
        instructions,
        tools,
        fetched_at,
    }))
}

pub fn delete(conn: &Connection, server: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM mcp_manifest WHERE server = ?1",
        params![server],
    )
    .map(|_| ())
    .map_err(|e| format!("删除 mcp_manifest 失败：{e}"))
}

/// 孤儿 manifest 的保留期。它只是垃圾回收，取值不敏感。
pub const ORPHAN_TTL_SECS: i64 = 7 * 24 * 3600;

/// 删掉「不在配置里」且「早于 `before`」的 manifest 行。
///
/// 导入向导里可以对**还没导入**的候选点「运行一下」，结果就写在这张表里
/// （这样导入后设置页不用再探一次）。用户看完不导入时，那行就成了孤儿。
///
/// 它本身是**惰性无害**的（`describe()` 只查配置里存在的 server，
/// 且 `is_stale_for` 会比指纹，日后同名但不同配置不会误用旧数据），
/// 所以不开定时器，只在扫描时顺手扫一遍——与 `sweep_idle` 同一个思路。
pub fn purge_orphans(conn: &Connection, keep: &[String], before: i64) -> Result<usize, String> {
    // 没有任何已配置的 server 时，`NOT IN ()` 不是合法 SQL，得把那一段去掉。
    if keep.is_empty() {
        return conn
            .execute("DELETE FROM mcp_manifest WHERE fetched_at < ?1", [before])
            .map_err(|e| e.to_string());
    }
    // rusqlite 不能把 `Vec` 直接绑成 IN 列表，手工拼占位符。
    // `keep` 来自本机配置里的 server 名（已过 `validate_name`），不是外部输入；
    // 即便如此也只拼占位符、值走绑定，不拼字符串。
    let holes = vec!["?"; keep.len()].join(",");
    let sql = format!("DELETE FROM mcp_manifest WHERE fetched_at < ? AND server NOT IN ({holes})");
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(keep.len() + 1);
    params.push(&before);
    for k in keep {
        params.push(k);
    }
    conn.execute(&sql, params.as_slice())
        .map_err(|e| e.to_string())
}

/// 紧凑索引：只给工具名 + 一句话描述，**不带 `inputSchema`**。
///
/// 🔴 N 个 server × 每个十几个工具的完整 schema 是很大一坨，而它是工具**返回值**——
/// 客户端不会像 `tools/list` 那样缓存，每次新会话都得重新灼进上下文。
/// 完整 schema 由调用方按需带 `server` / `tool` 参数再取。
pub fn compact_index(tools: &Value) -> Value {
    let items: Vec<Value> = tools
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .map(|t| {
            let name = t.get("name").cloned().unwrap_or(Value::Null);
            let summary = t
                .get("description")
                .and_then(|d| d.as_str())
                .map(first_sentence)
                .unwrap_or_default();
            serde_json::json!({ "name": name, "summary": summary })
        })
        .collect();
    Value::Array(items)
}

/// 取描述的第一句（或前 120 字符）。
///
/// 按**字符**而不是字节截断：描述里有中文时按字节切会切在 UTF-8 码点中间 panic。
fn first_sentence(d: &str) -> String {
    let d = d.trim();
    let end = d
        .find(['.', '\u{3002}', '\n'])
        .map(|i| i + d[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1));
    let head = match end {
        Some(i) => &d[..i],
        None => d,
    };
    if head.chars().count() <= 120 {
        head.to_string()
    } else {
        head.chars().take(120).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn db() -> Connection {
        let c = Connection::open_in_memory().expect("in-mem db");
        ensure_table(&c).expect("建表");
        c
    }

    fn row(server: &str, fetched_at: i64) -> Manifest {
        Manifest {
            server: server.into(),
            fingerprint: "fp".into(),
            server_info: json!({}),
            instructions: None,
            tools: json!([]),
            fetched_at,
        }
    }

    /// 孤儿清理只删「不在配置里」**且**「够旧」的。
    ///
    /// 三种组合都要钉，因为写错哪一条的后果都是**静默**的：
    /// 删多了 = 用户下次打开设置页发现工具清单莫名没了；删少了 = 垃圾永远留着。
    #[test]
    fn purge_orphans_only_removes_old_and_unconfigured() {
        let conn = db();
        save(&conn, &row("已配置且旧", 100)).expect("1");
        save(&conn, &row("未配置但新", 900)).expect("2");
        save(&conn, &row("未配置且旧", 100)).expect("3");

        let keep = vec!["已配置且旧".to_string()];
        let n = purge_orphans(&conn, &keep, 500).expect("清理");

        assert_eq!(n, 1, "只该删「未配置且旧」那一条");
        assert!(load(&conn, "已配置且旧").unwrap().is_some(), "配置里的多旧都不能删");
        assert!(load(&conn, "未配置但新").unwrap().is_some(), "还在保留期内的不能删");
        assert!(load(&conn, "未配置且旧").unwrap().is_none());
    }

    /// 一个 server 都没配置时，`NOT IN ()` 不是合法 SQL——走的是另一条分支。
    #[test]
    fn purge_orphans_handles_empty_keep_list() {
        let conn = db();
        save(&conn, &row("a", 100)).expect("1");
        save(&conn, &row("b", 900)).expect("2");
        let n = purge_orphans(&conn, &[], 500).expect("不能因为空列表报 SQL 错");
        assert_eq!(n, 1);
        assert!(load(&conn, "b").unwrap().is_some());
    }

    fn spec(args: &[&str]) -> ExternalMcpServer {
        ExternalMcpServer {
            name: "codegraph".into(),
            transport: "stdio".into(),
            command: "codegraph".into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: vec![],
            cwd: None,
            enabled: true,
            allow_remote_cwd: false,
        }
    }

    /// 拿内存管道造一个已握手的 client——**全程不启任何进程**。
    fn fake_client(tools: &str) -> Client {
        let init = concat!(
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","#,
            r#""capabilities":{"tools":{}},"serverInfo":{"name":"codegraph","version":"0.9.9"},"#,
            // 必须用 r##：下面这段内容里有 `"#`（Markdown 标题的一部分），
            // 它会把 r#"…"# 提前结束掉。
            r##""instructions":"# Codegraph"}}"##
        );
        let list = format!(r#"{{"jsonrpc":"2.0","id":2,"result":{{"tools":{tools}}}}}"#);
        Client::handshake(
            Cursor::new(format!("{init}\n{list}\n")),
            std::io::sink(),
            Duration::from_secs(5),
        )
        .expect("握手")
    }

    /// B9：抓取 → 存库 → 读回。读那一步只碰 SQLite，不碰进程也不碰协议。
    #[test]
    fn capture_then_persist_then_load_without_any_process() {
        let conn = db();
        let s = spec(&["serve", "--mcp"]);
        let tools = r#"[{"name":"codegraph_search","description":"Quick symbol search. Returns locations only.","inputSchema":{"type":"object"}}]"#;

        let m = capture(
            &mut fake_client(tools),
            &s,
            Duration::from_secs(5),
            1_700_000_000,
        )
        .expect("抓取");
        assert_eq!(m.tool_count(), 1);
        assert_eq!(m.server_info["name"], "codegraph");
        assert_eq!(m.instructions.as_deref(), Some("# Codegraph"));

        save(&conn, &m).expect("存库");

        let back = load(&conn, "codegraph").expect("读库").expect("应有记录");
        assert_eq!(back, m, "存进去与读回来必须逐字相同");
        assert!(!back.is_stale_for(&s));
    }

    /// B10：改了 args → 已存的清单失效。
    #[test]
    fn manifest_goes_stale_when_config_changes() {
        let conn = db();
        let old = spec(&["serve", "--mcp"]);
        let m = capture(&mut fake_client("[]"), &old, Duration::from_secs(5), 1).expect("抓取");
        save(&conn, &m).expect("存库");

        let changed = spec(&["serve", "--mcp", "--no-watch"]);
        let back = load(&conn, "codegraph").expect("读库").expect("应有");
        assert!(back.is_stale_for(&changed), "改了 args 就必须失效");
        assert!(!back.is_stale_for(&old));
    }

    /// 重复存同一个 server 是覆盖，不是报错也不是追加。
    #[test]
    fn save_is_upsert() {
        let conn = db();
        let s = spec(&[]);
        let a = capture(&mut fake_client("[]"), &s, Duration::from_secs(5), 1).expect("1");
        save(&conn, &a).expect("第一次");
        let b = capture(
            &mut fake_client(r#"[{"name":"x"}]"#),
            &s,
            Duration::from_secs(5),
            2,
        )
        .expect("2");
        save(&conn, &b).expect("第二次应该覆盖");

        let back = load(&conn, "codegraph").expect("读").expect("应有");
        assert_eq!(back.tool_count(), 1);
        assert_eq!(back.fetched_at, 2);
    }

    #[test]
    fn load_missing_server_is_none_not_error() {
        assert!(load(&db(), "nobody").expect("不该报错").is_none());
    }

    /// 行损坏（tools 不是合法 JSON）→ 当作没缓存，而不是把整个列表报错阻断。
    #[test]
    fn corrupt_row_degrades_to_none() {
        let conn = db();
        conn.execute(
            "INSERT INTO mcp_manifest VALUES ('bad', 'fp', '{}', NULL, '这不是JSON', 1)",
            [],
        )
        .expect("造一行脏数据");
        assert!(load(&conn, "bad").expect("不该报错").is_none());
    }

    #[test]
    fn delete_removes_the_row() {
        let conn = db();
        let s = spec(&[]);
        let m = capture(&mut fake_client("[]"), &s, Duration::from_secs(5), 1).expect("抓取");
        save(&conn, &m).expect("存");
        delete(&conn, "codegraph").expect("删");
        assert!(load(&conn, "codegraph").expect("读").is_none());
    }

    /// 紧凑索引：**不能带 inputSchema**，描述只取第一句。
    #[test]
    fn compact_index_drops_schema_and_shortens_description() {
        let tools = json!([{
            "name": "codegraph_search",
            "description": "Quick symbol search by name. Returns locations only (no code). Use codegraph_explore instead.",
            "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } } }
        }]);
        let idx = compact_index(&tools);
        let s = idx.to_string();
        assert!(!s.contains("inputSchema"), "紧凑索引里不能出现 schema：{s}");
        assert!(!s.contains("properties"));
        assert_eq!(idx[0]["name"], "codegraph_search");
        assert_eq!(idx[0]["summary"], "Quick symbol search by name.");
    }

    /// 中文描述不能在 UTF-8 码点中间切断而 panic。
    #[test]
    fn chinese_description_is_truncated_by_chars_not_bytes() {
        let long: String = "中".repeat(500);
        let tools = json!([{ "name": "t", "description": long }]);
        let idx = compact_index(&tools);
        let summary = idx[0]["summary"].as_str().expect("有值");
        assert_eq!(summary.chars().count(), 121, "120 字 + 省略号");
    }

    /// 没有 description 的工具不能把索引弄崩。
    #[test]
    fn tool_without_description_is_fine() {
        let idx = compact_index(&json!([{ "name": "t" }]));
        assert_eq!(idx[0]["summary"], "");
    }
}
