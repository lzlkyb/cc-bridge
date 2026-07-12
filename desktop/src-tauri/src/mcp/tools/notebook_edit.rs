use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::security;
use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct NotebookEditArgs {
    /// 目标 .ipynb 文件路径（需在白名单根内、且扩展名被允许）。
    pub path: String,
    /// 单元格索引（从 0 开始）。
    pub cell: usize,
    /// 新的单元格源码（replace / insert 模式使用）。
    #[serde(default, rename = "newSource")]
    pub new_source: String,
    /// 操作模式：replace（默认，替换现有 cell）| insert（在 cell 索引处插入）| delete（删除该 cell）。
    #[serde(rename = "mode", default = "default_mode")]
    pub mode: String,
    /// 插入新单元格时的类型：code（默认）| markdown | raw。仅 insert 模式使用。
    #[serde(rename = "cellType", default = "default_cell_type")]
    pub cell_type: String,
}

fn default_mode() -> String {
    "replace".into()
}

fn default_cell_type() -> String {
    "code".into()
}

pub async fn handle(args: NotebookEditArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;
    let resolved = security::path::resolve_safe_path(
        &args.path,
        &config.allowed_roots,
        config.whitelist_enabled,
    )?;
    security::extension::assert_extension_allowed(&resolved, &config.allowed_extensions)?;
    drop(config);

    // 读 .ipynb（JSON）。
    let content = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| format!("读取失败: {e}"))?;
    let mut notebook: Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析 .ipynb 失败（非合法 JSON）: {e}"))?;

    let cells = notebook
        .get_mut("cells")
        .and_then(|c| c.as_array_mut())
        .ok_or_else(|| "notebook 缺少 cells 数组（不是合法的 .ipynb？）".to_string())?;

    match args.mode.as_str() {
        "replace" => {
            let cell_count = cells.len();
            let cell = cells
                .get_mut(args.cell)
                .ok_or_else(|| format!("cell 索引 {} 越界（共 {} 个）", args.cell, cell_count))?;
            cell["source"] = source_to_json(&args.new_source);
        }
        "insert" => {
            if args.cell > cells.len() {
                return Err(format!(
                    "insert 索引 {} 越界（共 {} 个，合法范围 0..={}）",
                    args.cell,
                    cells.len(),
                    cells.len()
                ));
            }
            let new_cell = json!({
                "cell_type": args.cell_type,
                "metadata": {},
                "source": source_to_json(&args.new_source),
            });
            cells.insert(args.cell, new_cell);
        }
        "delete" => {
            if args.cell >= cells.len() {
                return Err(format!(
                    "delete 索引 {} 越界（共 {} 个）",
                    args.cell,
                    cells.len()
                ));
            }
            cells.remove(args.cell);
        }
        other => {
            return Err(format!(
                "未知 mode: {other}（应为 replace | insert | delete）"
            ))
        }
    }

    // 写回，保留其余字段（metadata / nbformat 等）。
    let out = serde_json::to_string_pretty(&notebook).map_err(|e| format!("序列化失败: {e}"))?;
    tokio::fs::write(&resolved, out)
        .await
        .map_err(|e| format!("写入失败: {e}"))?;

    Ok(json!({ "content": [{ "type": "text", "text": "ok" }] }))
}

/// ipynb 的 `source` 字段允许是字符串或字符串数组；这里统一存为单行字符串（合法 nbformat）。
fn source_to_json(src: &str) -> Value {
    json!(src)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BridgeConfig;
    use crate::db;
    use crate::state::AppState;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn unique_subdir(label: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cc-bridge-nb-test-{label}-{}-{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tempdir create");
        dir
    }

    fn make_state(f: impl FnOnce(&mut BridgeConfig)) -> (Arc<AppState>, std::path::PathBuf) {
        let dir = unique_subdir("nb");
        let conn = db::init_database(Path::new(&dir)).expect("init db");
        let mut cfg = BridgeConfig::default();
        f(&mut cfg);
        // 测试固定：把白名单根设为该临时目录，避免 "not within any allowed root"。
        cfg.allowed_roots = vec![dir.to_string_lossy().into_owned()];
        let state = Arc::new(AppState::new(conn, cfg, dir.clone()));
        (state, dir)
    }

    /// 最小合法 ipynb（nbformat 4）。
    fn sample_nb() -> Value {
        json!({
            "cells": [
                {"cell_type": "code", "metadata": {}, "source": "print(1)"},
                {"cell_type": "markdown", "metadata": {}, "source": "# title"}
            ],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5
        })
    }

    #[tokio::test]
    async fn replace_cell_source() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions = vec![".ipynb".to_string()];
            c.whitelist_enabled = true;
        });
        let p = dir.join("n.ipynb");
        std::fs::write(&p, serde_json::to_string_pretty(&sample_nb()).unwrap()).unwrap();

        handle(
            NotebookEditArgs {
                path: p.to_string_lossy().into_owned(),
                cell: 0,
                new_source: "print(42)".into(),
                mode: "replace".into(),
                cell_type: "code".into(),
            },
            &state,
        )
        .await
        .expect("replace should succeed");

        let written: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(written["cells"][0]["source"].as_str().unwrap(), "print(42)");
        // 其余字段保留
        assert_eq!(written["nbformat"], 4);
        assert_eq!(written["cells"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn insert_cell() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions = vec![".ipynb".to_string()];
            c.whitelist_enabled = true;
        });
        let p = dir.join("n.ipynb");
        std::fs::write(&p, serde_json::to_string_pretty(&sample_nb()).unwrap()).unwrap();

        handle(
            NotebookEditArgs {
                path: p.to_string_lossy().into_owned(),
                cell: 1,
                new_source: "new cell body".into(),
                mode: "insert".into(),
                cell_type: "markdown".into(),
            },
            &state,
        )
        .await
        .expect("insert should succeed");

        let written: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        let cells = written["cells"].as_array().unwrap();
        assert_eq!(cells.len(), 3);
        assert_eq!(cells[1]["source"].as_str().unwrap(), "new cell body");
        assert_eq!(cells[1]["cell_type"].as_str().unwrap(), "markdown");
    }

    #[tokio::test]
    async fn delete_cell() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions = vec![".ipynb".to_string()];
            c.whitelist_enabled = true;
        });
        let p = dir.join("n.ipynb");
        std::fs::write(&p, serde_json::to_string_pretty(&sample_nb()).unwrap()).unwrap();

        handle(
            NotebookEditArgs {
                path: p.to_string_lossy().into_owned(),
                cell: 0,
                new_source: String::new(),
                mode: "delete".into(),
                cell_type: "code".into(),
            },
            &state,
        )
        .await
        .expect("delete should succeed");

        let written: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(written["cells"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn out_of_bounds_rejected() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions = vec![".ipynb".to_string()];
            c.whitelist_enabled = true;
        });
        let p = dir.join("n.ipynb");
        std::fs::write(&p, serde_json::to_string_pretty(&sample_nb()).unwrap()).unwrap();

        let r = handle(
            NotebookEditArgs {
                path: p.to_string_lossy().into_owned(),
                cell: 99,
                new_source: String::new(),
                mode: "replace".into(),
                cell_type: "code".into(),
            },
            &state,
        )
        .await;
        assert!(r.is_err(), "越界索引必须 Err");
    }

    #[tokio::test]
    async fn missing_cells_rejected() {
        let (state, dir) = make_state(|c| {
            c.allowed_extensions = vec![".ipynb".to_string()];
            c.whitelist_enabled = true;
        });
        let p = dir.join("n.ipynb");
        std::fs::write(
            &p,
            serde_json::json!({ "metadata": {}, "nbformat": 4 }).to_string(),
        )
        .unwrap();

        let r = handle(
            NotebookEditArgs {
                path: p.to_string_lossy().into_owned(),
                cell: 0,
                new_source: String::new(),
                mode: "replace".into(),
                cell_type: "code".into(),
            },
            &state,
        )
        .await;
        assert!(r.is_err(), "缺 cells 数组必须 Err");
    }
}
