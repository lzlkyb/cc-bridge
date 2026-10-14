import type { Terminal } from "@xterm/xterm";

/**
 * 终端实例注册表：`sessionId → Terminal`（模块级）。
 *
 * WHY 模块级 Map 而不是 React state / context：
 * - 终端实例由 `useSshTerminalSession` 在 effect 里 new 出来，生命周期跟着会话走、
 *   跟组件渲染无关；塞进 React 只会多一层「实例与 state 不同步」的风险。
 * - 跨标签搜索要遍历**所有**会话的缓冲区。`TerminalTab.tsx` 把所有会话都挂载、
 *   只用 `display:none` 切标签（后台会话要继续收输出），所以后台实例是活的、
 *   可以扫——但这份清单任何单个组件都拿不到（每个 SshTerminal 只知道自己）。
 *
 * 注销由注册方负责（返回的 disposer 必须挂在 effect cleanup 上）：会话关闭、
 * 重连换 sessionId 时自动收敛，不留悬空项。
 */
const TERMS = new Map<string, Terminal>();

/** 登记一个已挂载的终端；返回注销函数（幂等）。 */
export function registerTerminal(sessionId: string, term: Terminal): () => void {
  TERMS.set(sessionId, term);
  return () => {
    // 只在仍是自己时删：同一实例可能先后登记在两个 sessionId 上（重连），
    // 无条件 delete 会把新条目一起带走。
    if (TERMS.get(sessionId) === term) TERMS.delete(sessionId);
  };
}

export function getTerminal(sessionId: string): Terminal | null {
  return TERMS.get(sessionId) ?? null;
}

/** 当前已挂载的全部终端（含后台标签），顺序 = 登记顺序。 */
export function listTerminals(): Array<{ sessionId: string; term: Terminal }> {
  return [...TERMS.entries()].map(([sessionId, term]) => ({ sessionId, term }));
}
