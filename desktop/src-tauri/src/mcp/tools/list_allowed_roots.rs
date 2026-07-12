use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

/// 无参数。serde 默认忽略多余字段，`{}` 或带字段都能反序列化。
#[derive(Debug, Deserialize)]
pub struct ListAllowedRootsArgs {}

/// CLAUDE.md 全文内嵌的大小上限（字节）；超过则只给路径提示，避免每次调用都传大文件。
const CLAUDE_MD_INLINE_MAX_BYTES: u64 = 20 * 1024;

/// 返回当前服务端的访问白名单，让远程 Claude Code 无需盲猜即可发现可用目录。
/// 同时探测每个根目录顶层的 CLAUDE.md：存在且不超限则全文内嵌到 projectInstructions，
/// 让远程 Claude Code 一调用本工具（约定中的"连接后第一步"）就自动拿到项目规则，
/// 不必再手动 read_files 一次。
pub async fn handle(_args: ListAllowedRootsArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;

    // E-P0-3: 改用 tokio::fs 异步 I/O，避免阻塞 tokio 工作线程（网络挂载路径可卡数秒）
    let mut project_instructions: Vec<Value> = Vec::new();
    for root in &config.allowed_roots {
        let claude_md_path = Path::new(root).join("CLAUDE.md");
        let metadata = match tokio::fs::metadata(&claude_md_path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }
        let path_str = claude_md_path.to_string_lossy().to_string();

        if metadata.len() > CLAUDE_MD_INLINE_MAX_BYTES {
            project_instructions.push(json!({
                "root": root,
                "path": path_str,
                "truncated": true,
                "note": format!(
                    "CLAUDE.md 超过 {}KB，未内嵌全文；请用 read_files 读取 {}",
                    CLAUDE_MD_INLINE_MAX_BYTES / 1024,
                    path_str
                ),
            }));
        } else {
            let content = match tokio::fs::read_to_string(&claude_md_path).await {
                Ok(c) => c,
                Err(_) => continue,
            };
            project_instructions.push(json!({
                "root": root,
                "path": path_str,
                "truncated": false,
                "content": content,
            }));
        }
    }

    let mut info = json!({
        "allowedRoots": config.allowed_roots,
        "allowedExtensions": config.allowed_extensions,
        "maxFileSizeBytes": config.max_file_size_bytes,
        "note": if config.allowed_roots.is_empty() {
            "白名单为空，所有文件操作都会被拒绝。请在 cc-bridge 面板『安全』页添加根目录。"
        } else {
            "只能访问以上根目录及其子目录。allowedExtensions 为空表示不限扩展名。"
        }
    });

    if !project_instructions.is_empty() {
        info["projectInstructions"] = json!(project_instructions);
    }

    Ok(json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&info).unwrap() }]
    }))
}
