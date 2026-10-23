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
/// JobObject 默认不 kill-on-close，drop 不会杀进程）：这里显式调用 child.start_kill()。
/// 它的底层实现按平台分（见 Cargo.toml 的分 target feature）：
/// - Windows：TerminateJobObject，终止曾挂靠在 Job 下的所有进程；
/// - Unix / macOS：子进程 spawn 时已 setpgid 成为组长，信号发给整个进程组。
///
/// 两者都能连子孙进程一起杀（不管嵌套几层）。
/// entry 在离开作用域时 drop，顺带关闭 Job 句柄（无害，因为进程已先被杀）。
pub async fn handle(args: StopCommandArgs, state: &Arc<AppState>) -> Result<Value, String> {
    // 先取出 pid / child 句柄 / exit_code（克隆 Arc 后立刻释放 DashMap 的 Ref，
    // 不在持有 Ref 期间跑 kill，也不再一上来就 `remove`）。
    let (pid, child, exit_code) = {
        let entry = state
            .running_commands
            .get(&args.handle)
            .ok_or_else(|| format!("未知的 handle: {}", args.handle))?;
        (entry.pid, entry.child.clone(), entry.exit_code.clone())
    };

    // 🔴 **先杀、杀成功再摘注册表**（审查 P2）。原来是「先 `remove` 再
    // `let _ = start_kill()`」：杀失败时进程变成孤儿，而模型与面板都拿到
    // `killed: true`、注册表里也查不到它了——之后谁都没有手段再管这个进程。
    // 已经跑完的命令不需要 kill（对已退出的进程调 start_kill 在部分平台会报错，
    // 而用户此时只想把它从列表里清掉），所以先看 exit_code。
    let already_done = exit_code.lock().await.is_some();
    if !already_done {
        // 只有前台命令留给「翻页取回」的快照条目没有 child，而它们的 exit_code 必然已是
        // Some（进程早结束），所以走到这里的条目一定拿得到句柄。
        let child = child.ok_or_else(|| {
            format!("进程 {pid} 的句柄已释放，无法终止；它可能已经结束，请刷新运行列表。")
        })?;
        let mut guard = child.lock().map_err(|_| {
            format!("终止进程 {pid} 失败：无法获取进程句柄锁。该命令仍在运行列表中。")
        })?;
        if let Err(e) = guard.start_kill() {
            return Err(format!(
                "终止进程 {pid} 失败：{e}。该命令仍在运行列表中，可稍后重试或手动结束。"
            ));
        }
    }

    state.running_commands.remove(&args.handle);

    Ok(crate::mcp::tools::text_result(&json!({
        "handle": args.handle,
        "pid": pid,
        "killed": true,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::testutil::make_state_default;

    #[tokio::test]
    async fn unknown_handle_returns_error() {
        // stop_command 一定不能对未知 handle 静默成功——若返回 ok 但注册表没动，
        // 客户端会以为"已停止"再去 get_command_output 仍拿到旧输出，状态机错乱。
        let state = make_state_default();
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
