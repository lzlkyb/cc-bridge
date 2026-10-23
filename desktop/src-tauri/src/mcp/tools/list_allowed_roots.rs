use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

/// 无参数。serde 默认忽略多余字段，`{}` 或带字段都能反序列化。
#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct ListAllowedRootsArgs {}

/// 项目规则文件的探测顺序（每个根目录按序取，最多内嵌 [`MAX_RULE_FILES_PER_ROOT`] 份）。
///
/// - `AGENTS.md`：跨工具事实标准（Codex 等），排最前——通用桥的首要受众。
/// - `CLAUDE.md`：Claude Code 约定。
///
/// 桥已面向「任意 MCP 客户端」，所以不能只认一家的规则文件；按序全取、来源不合并，
/// 让每个客户端都能在自己那份里读到对应规则。
const PROJECT_RULE_FILES: &[&str] = &["AGENTS.md", "CLAUDE.md"];

/// 每个根目录最多内嵌的规则文件数（防目录里堆一堆规则文件把响应撑大）。
const MAX_RULE_FILES_PER_ROOT: usize = 3;

/// 单个规则文件全文内嵌的大小上限（字节）；超过则只给路径提示，避免每次调用都传大文件。
const PROJECT_RULES_INLINE_MAX_BYTES: u64 = 20 * 1024;

/// 返回当前服务端的访问白名单，让远程 AI 无需盲猜即可发现可用目录。
/// 同时探测每个根目录顶层的项目规则文件（[`PROJECT_RULE_FILES`]）：存在且不超限则全文内嵌
/// 到 `projectInstructions`，让调用方一调用本工具（约定中的"连接后第一步"）就自动拿到项目
/// 规则，不必再手动 read_files 一次。每条带 `file` 字段标明来源文件名。
pub async fn handle(_args: ListAllowedRootsArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;

    // E-P0-3: 改用 tokio::fs 异步 I/O，避免阻塞 tokio 工作线程（网络挂载路径可卡数秒）
    let mut project_instructions: Vec<Value> = Vec::new();
    for root in &config.allowed_roots {
        let mut taken = 0usize;
        for file_name in PROJECT_RULE_FILES {
            if taken >= MAX_RULE_FILES_PER_ROOT {
                break;
            }
            let rule_path = Path::new(root).join(file_name);
            let metadata = match tokio::fs::metadata(&rule_path).await {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !metadata.is_file() {
                continue;
            }
            let path_str = rule_path.to_string_lossy().to_string();
            taken += 1;

            if metadata.len() > PROJECT_RULES_INLINE_MAX_BYTES {
                project_instructions.push(json!({
                    "root": root,
                    "file": file_name,
                    "path": path_str,
                    "truncated": true,
                    "note": format!(
                        "{} 超过 {}KB，未内嵌全文；请用 read_files 读取 {}",
                        file_name,
                        PROJECT_RULES_INLINE_MAX_BYTES / 1024,
                        path_str
                    ),
                }));
            } else {
                let content = match tokio::fs::read_to_string(&rule_path).await {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                project_instructions.push(json!({
                    "root": root,
                    "file": file_name,
                    "path": path_str,
                    "truncated": false,
                    "content": content,
                }));
            }
        }
    }

    let mut info = json!({
        "allowedRoots": config.allowed_roots,
        "allowedExtensions": config.allowed_extensions,
        "maxFileSizeBytes": config.max_file_size_bytes,
        "note": if config.allowed_roots.is_empty() {
            "白名单为空，所有文件操作都会被拒绝。请在 cc-bridge 面板『安全』页添加根目录。另外，每次为用户完成一个任务后，请调用 push_notification 工具弹出桌面通知告知结果。"
        } else {
            "只能访问以上根目录及其子目录。allowedExtensions 为空表示不限扩展名。另外，每次为用户完成一个任务后，请调用 push_notification 工具弹出桌面通知告知结果。"
        }
    });

    if !project_instructions.is_empty() {
        info["projectInstructions"] = json!(project_instructions);
    }

    Ok(crate::mcp::tools::text_result(&info))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::testutil::{make_state_with_roots as make_state, unique_subdir};

    /// 跑一次工具，返回解析后的 info。
    async fn run(state: &Arc<AppState>) -> Value {
        let v = handle(ListAllowedRootsArgs {}, state)
            .await
            .expect("list_allowed_roots 应成功");
        let text = v["content"][0]["text"].as_str().unwrap();
        serde_json::from_str(text).unwrap()
    }

    /// AGENTS.md 与 CLAUDE.md 同时存在：两份都内嵌，AGENTS.md 排前（优先级）。
    #[tokio::test]
    async fn both_rule_files_inlined_agents_first() {
        let root = unique_subdir("both");
        std::fs::write(root.join("AGENTS.md"), "# agents rules\n").unwrap();
        std::fs::write(root.join("CLAUDE.md"), "# claude rules\n").unwrap();
        let state = make_state(vec![root]);

        let info = run(&state).await;
        let items = info["projectInstructions"].as_array().unwrap();
        assert_eq!(items.len(), 2, "AGENTS.md 与 CLAUDE.md 都应内嵌");
        assert_eq!(
            items[0]["file"].as_str(),
            Some("AGENTS.md"),
            "AGENTS.md 应排前"
        );
        assert_eq!(items[1]["file"].as_str(), Some("CLAUDE.md"));
        assert_eq!(items[0]["content"].as_str(), Some("# agents rules\n"));
        assert_eq!(items[0]["truncated"].as_bool(), Some(false));
    }

    /// 只有 CLAUDE.md（旧行为）：仍能内嵌，向后兼容。
    #[tokio::test]
    async fn claude_md_only_still_works() {
        let root = unique_subdir("claude-only");
        std::fs::write(root.join("CLAUDE.md"), "# claude rules\n").unwrap();
        let state = make_state(vec![root]);

        let info = run(&state).await;
        let items = info["projectInstructions"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["file"].as_str(), Some("CLAUDE.md"));
    }

    /// 超过 20KB：标 truncated=true 且只给路径提示，不内嵌全文。
    #[tokio::test]
    async fn oversized_rule_file_marked_truncated() {
        let root = unique_subdir("oversize");
        let big = "x".repeat((PROJECT_RULES_INLINE_MAX_BYTES + 1) as usize);
        std::fs::write(root.join("AGENTS.md"), big).unwrap();
        let state = make_state(vec![root]);

        let info = run(&state).await;
        let items = info["projectInstructions"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["truncated"].as_bool(), Some(true));
        assert!(items[0].get("content").is_none(), "超限不应内嵌全文");
        assert_eq!(items[0]["file"].as_str(), Some("AGENTS.md"));
    }

    /// 无规则文件：projectInstructions 字段整体不出现（不返回空数组）。
    #[tokio::test]
    async fn no_rule_files_omits_field() {
        let root = unique_subdir("none");
        let state = make_state(vec![root]);

        let info = run(&state).await;
        assert!(
            info.get("projectInstructions").is_none(),
            "无规则文件时不应出现 projectInstructions"
        );
    }

    /// 多根目录：各自探测，互不串味。
    #[tokio::test]
    async fn multiple_roots_scoped_independently() {
        let root_a = unique_subdir("multi-a");
        let root_b = unique_subdir("multi-b");
        std::fs::write(root_a.join("AGENTS.md"), "A rules\n").unwrap();
        std::fs::write(root_b.join("CLAUDE.md"), "B rules\n").unwrap();
        let state = make_state(vec![root_a, root_b]);

        let info = run(&state).await;
        let items = info["projectInstructions"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items
            .iter()
            .any(|i| i["content"].as_str() == Some("A rules\n")));
        assert!(items
            .iter()
            .any(|i| i["content"].as_str() == Some("B rules\n")));
    }
}
