//! MCP 工具：push_notification。向用户桌面推送 Windows toast 通知。
//!
//! 受 `notify_task_complete` 配置开关控制：关闭时静默忽略（返回 pushed: false），不推通知、
//! 不报错，避免骚扰。AppHandle 由 main.rs 启动时注入 state，供 MCP 层调用 Tauri 插件。

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct PushNotificationArgs {
    /// 通知标题，如「任务完成」「编译结束」。
    #[serde(default = "default_title")]
    pub title: String,
    /// 通知正文，一句话描述完成了什么。
    #[serde(default)]
    pub body: String,
}

fn default_title() -> String {
    "cc-bridge".into()
}

pub async fn handle(
    args: PushNotificationArgs,
    state: &Arc<AppState>,
) -> Result<Value, String> {
    // 开关检查：关闭时静默忽略，不推通知也不报错。
    let enabled = state.config.read().await.notify_task_complete;
    if !enabled {
        return Ok(json!({"pushed": false, "reason": "notify_task_complete 已关闭"}));
    }

    let handle = state.app_handle.lock().unwrap().clone();
    match handle {
        Some(h) => {
            use tauri_plugin_notification::NotificationExt;
            let _ = h
                .notification()
                .builder()
                .title(&args.title)
                .body(&args.body)
                .show();
            Ok(json!({"pushed": true}))
        }
        None => Err("AppHandle 未初始化".into()),
    }
}
