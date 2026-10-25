//! 会话用量账的 IPC 命令层。
//!
//! ## 这个命令为什么存在
//!
//! 「两套账」此前后端对不上：对话账（CC CLI 上报的真实 token / 成本）只活在
//! 内存里，工具账（`get_token_usage`，按 4 字节 ≈ 1 token 估算）另有一套。
//! 用户看到的是「界面说花了 0、账单说花了钱」，也说不清某条对话到底费了多少。
//!
//! 本命令把对话账按 session id 读出来，前端把它与 `TokenUsageReport.sessions`
//! （工具账按同一 session id 归属）并排摆在一张表里。
//!
//! 🔴 **两套账不是相加关系**：工具账估的是「经桥交互的上下文增量」，
//! 它大体是对话账里由工具结果贡献的那一部分（子集），加在一起会重复计。
//! 口径写在前端的 tooltip 里，改一处要连另一边一起改。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use crate::cc_session::usage::{self, SessionUsage};
use crate::state::AppState;

/// 一条会话的用量行（对话账 + 标题）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSessionUsageRow {
    #[serde(flatten)]
    pub usage: SessionUsage,
    /// 历史索引里的标题。远端会话、或索引还没扫过时是 `None`（界面退回显示 id）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// 会话用量账：最近的会话，新的在前。
///
/// 上限 200 条：会话数只跟「新开过几次对话」有关，正常一年也就几百条，
/// 全量返回没有意义；界面也只展示最近若干条。
#[tauri::command]
pub async fn cc_session_usage(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<CcSessionUsageRow>, String> {
    let st = Arc::clone(&*state);
    let t0 = Instant::now();
    let rows: Vec<CcSessionUsageRow> = tauri::async_runtime::spawn_blocking(move || {
        let conn = st.db.blocking_lock();
        let rows = usage::recent(&conn, 200)?;
        // 标题从历史索引来：`scan_local` 是增量扫描（签名没变的文件不打开），
        // 且它会把结果 upsert 进索引，顺带保持索引新鲜。远端会话扫不到 ⇒ None。
        // 索引里的 title 可能是空串（转录第一条用户消息是空的），按无标题处理。
        let titles: HashMap<String, String> = crate::cc_history::scan_local(&conn)
            .map(|s| {
                s.rows
                    .into_iter()
                    .filter(|r| !r.title.trim().is_empty())
                    .map(|r| (r.session_id, r.title))
                    .collect()
            })
            .unwrap_or_default();
        Ok::<_, String>(
            rows.into_iter()
                .map(|u| {
                    let title = titles.get(&u.session_id).cloned();
                    CcSessionUsageRow { usage: u, title }
                })
                .collect(),
        )
    })
    .await
    .map_err(|e| format!("任务加入失败：{e}"))??;
    log::debug!(
        "会话用量查询 {} 条，{}ms",
        rows.len(),
        t0.elapsed().as_millis()
    );
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cc_session::usage::CcUsage;

    /// 落库 → 读回 → 拼标题的整条链路（标题那半边在无 `~/.claude` 的
    /// 测试机上是 None，所以只锁「读得回来、字段没丢」）。
    #[test]
    fn row_shape_roundtrips() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::cc_session::usage::ensure_table(&conn).unwrap();
        usage::record(
            &conn,
            "s-1",
            "",
            &CcUsage {
                input_tokens: 100,
                output_tokens: 20,
                cost_usd: 0.5,
                turns: 3,
            },
        )
        .unwrap();
        let got = usage::recent(&conn, 10).unwrap();
        assert_eq!(got.len(), 1);
        let row = CcSessionUsageRow {
            usage: got[0].clone(),
            title: None,
        };
        let json = serde_json::to_value(&row).unwrap();
        // camelCase 是给前端的契约：改名必须连前端类型一起改。
        assert_eq!(json["sessionId"], "s-1");
        assert_eq!(json["inputTokens"], 100);
        assert_eq!(json["outputTokens"], 20);
        assert_eq!(json["turns"], 3);
        assert!((json["costUsd"].as_f64().unwrap() - 0.5).abs() < 1e-9);
        assert!(json.get("title").is_none(), "None 的标题不该出现在 JSON 里");
    }
}
