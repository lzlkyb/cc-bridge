use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

/// 无参数。serde 默认忽略多余字段，`{}` 或带字段都能反序列化。
#[derive(Debug, Deserialize)]
pub struct ListAllowedRootsArgs {}

/// 返回当前服务端的访问白名单，让远程 Claude Code 无需盲猜即可发现可用目录。
pub async fn handle(_args: ListAllowedRootsArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await;

    let info = json!({
        "allowedRoots": config.allowed_roots,
        "allowedExtensions": config.allowed_extensions,
        "maxFileSizeBytes": config.max_file_size_bytes,
        "note": if config.allowed_roots.is_empty() {
            "白名单为空，所有文件操作都会被拒绝。请在 cc-bridge 面板『安全』页添加根目录。"
        } else {
            "只能访问以上根目录及其子目录。allowedExtensions 为空表示不限扩展名。"
        }
    });

    Ok(json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&info).unwrap() }]
    }))
}
