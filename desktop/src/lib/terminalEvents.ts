/**
 * 终端输出事件名（纯函数，便于单测）。
 *
 * WHY 每个会话一个事件名，而不是共用 `ssh_output`：
 * Tauri 的事件是**广播**——共用名字时，N 个开着的终端就有 N 个监听器，
 * 每一条输出都要在每个监听器上反序列化一遍，再被其中 N-1 个按 sessionId 丢掉。
 * 刷日志时这是白烧的 N 倍开销。
 */

/**
 * 把 sessionId 映成它专属的输出事件名。
 *
 * 🔴 必须与 Rust 端的 `ssh_output_event()` 逐字一致（`commands/ssh_cmds.rs`）。
 * 两边都有一条用同一个 uuid 对照的字面量断言，改一边忘了另一边会被测试拿住。
 *
 * 只保留字母数字（uuid 里的 `-` 被剔掉），是为了稳当地落在 Tauri 的
 * 事件名字符集里，不去赌它到底收不收连字符。
 */
export function sshOutputEvent(sessionId: string): string {
  return `ssh_output_${sessionId.replace(/[^a-zA-Z0-9]/g, "")}`;
}
