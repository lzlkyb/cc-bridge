use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct StopCommandArgs {
    pub handle: String,
}

/// 终止一个后台命令的整个进程树，并从注册表中移除。
/// 故意不受 shell_enabled/readonly_mode 限制——即使事后关闭了命令执行开关，
/// 仍应能终止一个已在跑的失控后台进程。
///
/// 整树终止不再依赖 taskkill，也不依赖 JobObject 的 kill-on-close（process-wrap 的 std
/// JobObject 默认不 kill-on-close，drop 不会杀进程）：这里显式调用 child.start_kill()，
/// 它底层走 TerminateJobObject，会终止曾挂靠在 Job 下的所有进程（不管嵌套几层子孙）。
/// entry 在离开作用域时 drop，顺带关闭 Job 句柄（无害，因为进程已先被杀）。
pub async fn handle(args: StopCommandArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let entry = state
        .running_commands
        .remove(&args.handle)
        .ok_or_else(|| format!("未知的 handle: {}", args.handle))?;

    let pid = entry.1.pid;
    // 显式杀整树（含孙进程）。start_kill 走 TerminateJobObject，不依赖 drop。
    let _ = entry.1.child.lock().unwrap().start_kill();
    drop(entry);

    Ok(json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&json!({
            "handle": args.handle,
            "pid": pid,
            "killed": true,
        })).unwrap() }]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::state::AppState;
    use std::path::Path;
    use std::sync::atomic::AtomicU64;

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 用 std::env::temp_dir() 而非 tempfile crate——cc-bridge 没有 dev-deps 段。
    /// 每个 case 走 unique_subdir 保证并发跑不出错。
    fn unique_subdir(label: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cc-bridge-mcp-test-{label}-{}-{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tempdir create");
        dir
    }

    fn make_state() -> Arc<AppState> {
        let dir = unique_subdir("stop_cmd");
        let conn = db::init_database(Path::new(&dir)).expect("init db");
        Arc::new(AppState::new(conn, Default::default(), dir))
    }

    #[tokio::test]
    async fn unknown_handle_returns_error() {
        // stop_command 一定不能对未知 handle 静默成功——若返回 ok 但注册表没动，
        // 客户端会以为"已停止"再去 get_command_output 仍拿到旧输出，状态机错乱。
        let state = make_state();
        let result = handle(
            StopCommandArgs {
                handle: "cmd_does_not_exist".to_string(),
            },
            &state,
        )
        .await;
        let err = result.expect_err("unknown handle must Err");
        assert!(
            err.contains("未知") || err.contains("cmd_does_not_exist"),
            "错误信息应指明 unknown handle，实际：{err}"
        );

        // 注册表应保持空（不能因为 stop 失败把别的清掉）。
        assert!(state.running_commands.is_empty());
    }
}
