//! MCP 工具：push_notification。向用户推送系统桌面通知
//! （Windows 上是 toast，macOS 上是通知中心横幅）。
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

pub async fn handle(args: PushNotificationArgs, state: &Arc<AppState>) -> Result<Value, String> {
    // 开关检查：关闭时静默忽略，不推通知也不报错。
    let enabled = state.config.read().await.notify_task_complete;
    if !enabled {
        return Ok(json!({"pushed": false, "reason": "notify_task_complete 已关闭"}));
    }

    let handle = state.app_handle.lock().unwrap().clone();
    match handle {
        Some(h) => {
            use tauri_plugin_notification::NotificationExt;
            match h
                .notification()
                .builder()
                .title(&args.title)
                .body(&args.body)
                .show()
            {
                Ok(()) => Ok(json!({"pushed": true})),
                // 不吞错：工具描述里要求远程 AI「每完成一个任务必推通知」，若推失败仍返回
                // pushed:true，mac 上通知全军覆没也没人知道。回传 reason 让 AI 改用文字告知用户。
                // 仍返回 Ok 而不是 Err：通知推不出去不是调用方的错，不应让 AI 以为自己用错了工具。
                Err(e) => {
                    log::warn!("push_notification 发送失败：{e}");
                    Ok(json!({"pushed": false, "reason": format!("桌面通知发送失败：{e}")}))
                }
            }
        }
        None => Err("AppHandle 未初始化".into()),
    }
}
