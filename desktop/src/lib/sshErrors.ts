/**
 * 前后端的**错误前缀协议**。与 `src-tauri/src/commands/ssh_cmds.rs` 里的常量
 * 一一对应，**改一边必须改另一边**。
 *
 * 🔴 用前缀而不是匹配中文文案：文案会改，前缀不会。
 * 「取消」「超时」「失败」在 UI 上必须可区分，靠字串包含去猜必然跑偏。
 *
 * 单独成一个文件而不是塞在 `useSshTransfer.ts` 里：它是一份**跳语言边界的契约**，
 * 与传输编排无关；按规则 11，这类共用的纯东西归 `lib/`。
 */

/** 用户主动取消。 */
export const ERR_CANCELLED = "CCB_CANCELLED";

/** 目标已存在且未授权覆盖（后端拒绝，前端据此弹覆盖确认而不是报错）。 */
export const ERR_TARGET_EXISTS = "CCB_TARGET_EXISTS";

/** 这次失败是不是「用户主动取消」。批量上传要靠它决定要不要继续排队。 */
export function isCancelled(raw: unknown): boolean {
  return String(raw ?? "").includes(ERR_CANCELLED);
}

/** 目标已存在的判定。 */
export function isTargetExists(raw: unknown): boolean {
  return String(raw ?? "").includes(ERR_TARGET_EXISTS);
}
