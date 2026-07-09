use std::os::windows::process::CommandExt;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct StopCommandArgs {
    pub handle: String,
}

/// 终止一个后台命令的整个进程树（taskkill /T），并从注册表中移除。
/// 故意不受 shell_enabled/readonly_mode 限制——即使事后关闭了命令执行开关，
/// 仍应能终止一个已在跑的失控后台进程。
pub async fn handle(args: StopCommandArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let entry = state
        .running_commands
        .remove(&args.handle)
        .ok_or_else(|| format!("未知的 handle: {}", args.handle))?;

    let pid = entry.1.pid;
    let output = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(0x0800_0200) // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP，避免 Ctrl+C 信号串到其他命令
        .output();

    let killed = matches!(output, Ok(o) if o.status.success());

    Ok(json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&json!({
            "handle": args.handle,
            "pid": pid,
            "killed": killed,
        })).unwrap() }]
    }))
}
