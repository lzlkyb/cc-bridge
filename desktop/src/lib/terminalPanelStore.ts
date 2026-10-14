import { useSyncExternalStore } from "react";

/**
 * 命令历史面板的开关（模块级，全局唯一）。
 *
 * WHY 不放 `SshTerminal` 的 useState：
 * - 触发按钮在**每个会话自己的工具栏**上（`SshTerminalToolbar`），面板本体挂在**会话容器**
 *   （`SshTerminal` 内、`containerRef` 同级）；两端不在同一棵子树里，靠 props 串要多穿一层。
 * - 语义上它就该是「跟着活动标签走」：标签切换后面板显示新标签的命令。断开（标签保留）
 *   时面板继续可用；标签被**移除**时由 `TerminalTabsBar` 顺手收起，避免它在相邻标签上
 *   自己打开（用户没点过任何东西）。
 */
let open = false;
const listeners = new Set<() => void>();

export function isCmdPanelOpen(): boolean {
  return open;
}

export function setCmdPanelOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}

export function subscribeCmdPanel(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 面板开关的 React 视图。 */
export function useCmdPanelOpen(): boolean {
  return useSyncExternalStore(subscribeCmdPanel, isCmdPanelOpen);
}
