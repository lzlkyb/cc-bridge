//! MCP 工具：change_sets。列出保留期内变更日志里出现过的变更集（名字 · 文件数 · 最后改动）。
//!
//! 用途：调用方开工前先看有没有可沿用的名字，避免同一个需求被拆成两个近似名。
//! 输出刻意做成紧凑纯文本（每行一条），默认最多 20 条，控制 token。

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::journal::{self, ChangeSetSummary, DEFAULT_LIST_LIMIT};
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct ChangeSetsArgs {
    /// 只看改过此路径前缀下文件的变更集（如项目根目录）。
    #[serde(default, rename = "pathPrefix")]
    pub path_prefix: Option<String>,
    /// 最多返回条数，默认 20。
    #[serde(default)]
    pub limit: Option<usize>,
}

pub async fn handle(args: ChangeSetsArgs, state: &Arc<AppState>) -> Result<Value, String> {
    if !state.config.read().await.journal_enabled {
        return Ok(text("变更日志未开启（设置页可打开）。"));
    }
    let data_dir = state.data_dir.clone();
    let prefix = args.path_prefix.clone();
    // 扫描是同步文件读取，放到阻塞线程池里，不占 async 工作线程。
    let all = tokio::task::spawn_blocking(move || {
        journal::scan_change_sets(&data_dir, prefix.as_deref())
    })
    .await
    .map_err(|e| format!("扫描变更日志失败: {e}"))?;
    let limit = args.limit.unwrap_or(DEFAULT_LIST_LIMIT).max(1);
    Ok(text(&render(&all, limit)))
}

fn text(s: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": s }] })
}

/// 每行「名字 · N 个文件 · 最后改动」；时间只保留到分钟。
fn render(all: &[ChangeSetSummary], limit: usize) -> String {
    if all.is_empty() {
        return "保留期内没有带变更集名的改动。".into();
    }
    let mut out: Vec<String> = all
        .iter()
        .take(limit)
        .map(|s| {
            let at: String = s
                .last_at
                .chars()
                .take(16)
                .collect::<String>()
                .replace('T', " ");
            format!("{} · {} 个文件 · {}", s.name, s.files, at)
        })
        .collect();
    if all.len() > limit {
        out.push(format!(
            "…另有 {} 个（加 limit 或 pathPrefix）",
            all.len() - limit
        ));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(name: &str, files: usize, at: &str) -> ChangeSetSummary {
        ChangeSetSummary {
            name: name.into(),
            files,
            last_at: at.into(),
        }
    }

    #[test]
    fn render_compact_and_truncated() {
        assert_eq!(render(&[], 20), "保留期内没有带变更集名的改动。");
        let list = vec![
            s("7691_退库锁库存", 3, "2026-11-12T10:05:33.123+08:00"),
            s("借出借入改造", 12, "2026-11-06T09:00:00.000+08:00"),
        ];
        assert_eq!(
            render(&list, 20),
            "7691_退库锁库存 · 3 个文件 · 2026-11-12 10:05\n借出借入改造 · 12 个文件 · 2026-11-06 09:00"
        );
        let r = render(&list, 1);
        assert!(r.ends_with("…另有 1 个（加 limit 或 pathPrefix）"), "{r}");
    }
}
