//! 会话用量账：把 CLI 每轮上报的累计 token / 成本**按 session id 落库**。
//!
//! ## 为什么需要它
//!
//! 对话 GUI 的「两套账」里，对话账此前只活在内存与事件快照里：
//! `TurnEnd` 的用量进了前端 reducer，关掉 app 就没了，也没法按会话回看。
//! 工具账那边（`audit.rs` 的 `get_token_usage`）早就能按天/按工具查。
//! 两套账数字对不上、也关不上，用户看到的是「界面说花了 0、账单说花了钱」。
//!
//! 本模块把对话账按 `session_id` 落成可查的一行，前端才能把它与工具账
//! **并排**摆在同一张表里（见 `cc_usage_report`）。
//!
//! ## 🔴 数据源为什么是 `modelUsage` 而不是 `usage`
//!
//! 批 0 探针（`docs/CC对话协议探针报告-2026-10-24.md`）在本机实测：
//! 走中转站时 `result.usage` 里的 token **全是 0**，而 `result.modelUsage.<model>`
//! 有真实值（`inputTokens: 40779`、`costUSD: 0.233884`）。
//! 更关键的是语义：`modelUsage` 给的是**该模型累计值**（余量条口径就是
//! `inputTokens + outputTokens`，见 `lib/ccContextUsage.ts`），所以这里
//! **覆盖写**而不是累加 —— 拿累计值再累加会翻倍。
//!
//! 与之相对，`result.usage` 是每轮增量（前端 reducer 就是累加它的）。
//! 两个口径不能混用：本模块只用 `modelUsage`。
//!
//! ## 与上下文余量条同源
//!
//! 「已用」一律 = `inputTokens + outputTokens` 跨模型求和，与 `ccContextUsage.ts`
//! 的 `contextBar` 完全一致（`inputTokens` **已含** cache read，探针实测
//! `inputTokens: 40779` 而 `cacheReadInputTokens: 40778`，再叠加一次会虚高）。

use rusqlite::{params, Connection};
use serde::Serialize;

/// 一条会话的累计用量。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct CcUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    /// 轮次数。用 CLI 上报的 `num_turns`（累计值），缺失时由调用方本地递增。
    pub turns: u64,
}

/// 库里读出来的一条会话用量（按最近活跃倒序）。
#[derive(Debug, Clone, Serialize)]
pub struct SessionUsage {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
    pub turns: u64,
    /// 秒级时间戳（毫秒会超出 i64 舒适区，且这里只需要排序与展示）。
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

/// 建表。只在 `init_database` 里调一次。
pub fn ensure_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cc_session_usage (
            session_id    TEXT PRIMARY KEY,
            connection_id TEXT    NOT NULL DEFAULT '',
            input_tokens  INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd      REAL    NOT NULL DEFAULT 0,
            turns         INTEGER NOT NULL DEFAULT 0,
            updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cc_session_usage_recent
            ON cc_session_usage(updated_at DESC);",
    )
    .map_err(|e| format!("建 cc_session_usage 表失败：{e}"))
}

/// 从 `result.modelUsage` 累计值求和。**纯函数**，可脱离数据库测。
///
/// 逐字段判型而不整个信任：协议版本间还在加键，读不出来的归零。
/// 只有连值都不是对象的模型条目才跳过（与 `readModelUsage` 同一判据）。
pub fn from_model_usage(model_usage: &serde_json::Value) -> CcUsage {
    let mut out = CcUsage::default();
    let Some(map) = model_usage.as_object() else {
        return out;
    };
    for v in map.values() {
        let Some(m) = v.as_object() else { continue };
        out.input_tokens += pos(m.get("inputTokens"));
        out.output_tokens += pos(m.get("outputTokens"));
        out.cost_usd += pos_f64(m.get("costUSD"));
    }
    out
}

/// 只收正有限数。CLI 会给 `null`、字符串、乃至负数，一律按 0（同 `posNum`）。
fn pos(v: Option<&serde_json::Value>) -> u64 {
    match v.and_then(serde_json::Value::as_u64) {
        Some(n) if n > 0 => n,
        _ => 0,
    }
}

fn pos_f64(v: Option<&serde_json::Value>) -> f64 {
    match v.and_then(serde_json::Value::as_f64) {
        Some(n) if n.is_finite() && n > 0.0 => n,
        _ => 0.0,
    }
}

/// 覆盖写入一条会话的累计用量。
///
/// 🔴 覆盖而不是累加：入参 `usage` 已是累计值（见模块文档）。
/// `turns` 由调用方决定（CLI 的 `num_turns` 优先），这里不自己加。
pub fn record(
    conn: &Connection,
    session_id: &str,
    connection_id: &str,
    usage: &CcUsage,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO cc_session_usage
            (session_id, connection_id, input_tokens, output_tokens, cost_usd, turns, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(session_id) DO UPDATE SET
            connection_id = excluded.connection_id,
            input_tokens  = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cost_usd      = excluded.cost_usd,
            turns         = excluded.turns,
            updated_at    = excluded.updated_at",
        params![
            session_id,
            connection_id,
            usage.input_tokens as i64,
            usage.output_tokens as i64,
            usage.cost_usd,
            usage.turns as i64,
            now_secs(),
        ],
    )
    .map_err(|e| format!("写会话用量失败：{e}"))?;
    Ok(())
}

/// 最近 `limit` 条会话用量（按 `updated_at` 倒序）。
pub fn recent(conn: &Connection, limit: usize) -> Result<Vec<SessionUsage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT session_id, connection_id, input_tokens, output_tokens, cost_usd,
                    turns, updated_at
             FROM cc_session_usage
             ORDER BY updated_at DESC, session_id DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("准备读会话用量失败：{e}"))?;
    let rows = stmt
        .query_map(params![limit as i64], |r| {
            Ok(SessionUsage {
                session_id: r.get(0)?,
                connection_id: r.get(1)?,
                input_tokens: r.get::<_, i64>(2)?.max(0) as u64,
                output_tokens: r.get::<_, i64>(3)?.max(0) as u64,
                cost_usd: r.get(4)?,
                turns: r.get::<_, i64>(5)?.max(0) as u64,
                updated_at: r.get(6)?,
            })
        })
        .map_err(|e| format!("读会话用量失败：{e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 秒级时间戳。与 `store.rs` 同一来源，便于两表对账。
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        ensure_table(&c).unwrap();
        c
    }

    /// 批 0 探针实测形状（见模块文档）：inputTokens 已含 cacheRead。
    fn probe_model_usage() -> serde_json::Value {
        serde_json::json!({
            "claude-opus-5": {
                "inputTokens": 40779,
                "outputTokens": 384,
                "cacheReadInputTokens": 40778,
                "cacheCreationInputTokens": 0,
                "webSearchRequests": 0,
                "costUSD": 0.233884,
                "contextWindow": 1000000,
                "maxOutputTokens": 64000,
                "thinkingTokens": 0,
                "canonicalModel": "claude-opus-5",
                "provider": "firstParty",
                "costBasis": "list"
            }
        })
    }

    #[test]
    fn from_model_usage_sums_models_and_keeps_cost() {
        let u = from_model_usage(&probe_model_usage());
        // inputTokens 已含 cacheRead：不能再加一次 cacheReadInputTokens。
        assert_eq!(u.input_tokens, 40779);
        assert_eq!(u.output_tokens, 384);
        assert!((u.cost_usd - 0.233884).abs() < 1e-9);
    }

    #[test]
    fn from_model_usage_multi_model_sums() {
        let raw = serde_json::json!({
            "opus": { "inputTokens": 100, "outputTokens": 10, "costUSD": 0.5 },
            "haiku": { "inputTokens": 20, "outputTokens": 2, "costUSD": 0.1 }
        });
        let u = from_model_usage(&raw);
        assert_eq!((u.input_tokens, u.output_tokens), (120, 12));
        assert!((u.cost_usd - 0.6).abs() < 1e-9);
    }

    #[test]
    fn from_model_usage_tolerates_junk() {
        // 中转站给 0、null、字符串、负数、以及非对象条目——一律按 0，不能 panic。
        let raw = serde_json::json!({
            "a": { "inputTokens": 0, "outputTokens": null, "costUSD": "x" },
            "b": { "inputTokens": -5, "outputTokens": -3, "costUSD": -1.0 },
            "c": "not an object",
            "d": { "inputTokens": 7, "outputTokens": 1, "costUSD": 0.25 }
        });
        let u = from_model_usage(&raw);
        assert_eq!((u.input_tokens, u.output_tokens), (7, 1));
        assert!((u.cost_usd - 0.25).abs() < 1e-9);
    }

    #[test]
    fn from_model_usage_rejects_non_object() {
        assert_eq!(
            from_model_usage(&serde_json::json!(null)),
            CcUsage::default()
        );
        assert_eq!(
            from_model_usage(&serde_json::json!([1, 2])),
            CcUsage::default()
        );
    }

    #[test]
    fn record_overwrites_cumulative_values() {
        let c = db();
        record(
            &c,
            "s-1",
            "",
            &CcUsage {
                input_tokens: 100,
                output_tokens: 10,
                cost_usd: 0.1,
                turns: 1,
            },
        )
        .unwrap();
        // 同一会话第二轮：累计值变大 ⇒ 覆盖，不能累加成 200。
        record(
            &c,
            "s-1",
            "",
            &CcUsage {
                input_tokens: 250,
                output_tokens: 20,
                cost_usd: 0.3,
                turns: 2,
            },
        )
        .unwrap();
        let rows = recent(&c, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].input_tokens, rows[0].output_tokens), (250, 20));
        assert_eq!(rows[0].turns, 2);
    }

    #[test]
    fn recent_orders_by_updated_at_desc() {
        let c = db();
        let u = CcUsage {
            input_tokens: 1,
            output_tokens: 1,
            cost_usd: 0.0,
            turns: 1,
        };
        record(&c, "old", "", &u).unwrap();
        // 手动把旧那条的时间戳压过去，避免依赖真实时钟顺序。
        c.execute(
            "UPDATE cc_session_usage SET updated_at = 1 WHERE session_id = 'old'",
            [],
        )
        .unwrap();
        record(&c, "new", "", &u).unwrap();
        let rows = recent(&c, 10).unwrap();
        assert_eq!(rows[0].session_id, "new");
        assert_eq!(recent(&c, 1).unwrap().len(), 1, "limit 生效");
    }

    #[test]
    fn record_switches_connection_id() {
        let c = db();
        record(&c, "s-9", "", &CcUsage::default()).unwrap();
        record(&c, "s-9", "conn-2", &CcUsage::default()).unwrap();
        assert_eq!(recent(&c, 10).unwrap()[0].connection_id, "conn-2");
    }
}
