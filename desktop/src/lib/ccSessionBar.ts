/**
 * 会话条（`SessionBar`）要展示的那份 DTO 的组装。**纯函数**，不碰 React、不碰 IPC。
 *
 * 从 `CcGuiTab` 抽出来的（2026-10-25）：多会话后每个 pane 都要拼一次，留在渲染
 * 组件里会把 pane 顶到体量门禁，而它本身只是「把七八处状态凑成一个对象」——
 * 纯计算，正好符合「纯计算 → lib/」那条拆分线。
 */

import type { CcPermissionMode, CcSession } from "./ccGuiTypes";
import type { CcView } from "./ccReducer";
import { collectChangeset } from "./ccChangeset";

export function toBarSession(input: {
  /** 目标显示名（本机 / 连接名）。 */
  connectionLabel: string;
  /** 输入框里的工作目录（未 trim 前的原样）。 */
  cwd: string;
  /** 用户为本轮选定的模型。空串 = 跟随 CLI 默认。 */
  model: string;
  permissionMode: CcPermissionMode;
  view: CcView;
}): CcSession {
  const { connectionLabel, cwd, model, permissionMode, view } = input;
  return {
    connection: connectionLabel,
    cwd: cwd.trim(),
    // 分支名这一版不显示：远端未必是 git 仓库，查一次要一次 SSH 往返，
    // 而它在会话条上只占一个 chip 的位置。
    branch: "",
    // CC 自己的 session id：上下文构成面板（批 4-1）要拿它去审计里对账。
    sessionId: view.sessionId,
    model,
    activeModel: view.model,
    permissionMode,
    inputTokens: view.inputTokens,
    outputTokens: view.outputTokens,
    costUsd: view.costUsd,
    modelUsage: view.modelUsage,
    running: view.running,
    changeset: collectChangeset(view.messages),
    messages: [],
  };
}
