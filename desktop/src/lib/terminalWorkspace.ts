import type { SshSessionRef } from "../components/tabs/TerminalConnectionItem";
import type { SplitInfo } from "../components/tabs/useTerminalSplit";

/** Visible tabs get the first numbers; split-only sessions follow, so both headers agree. */
export function terminalSessionOrdinal(sessions: SshSessionRef[], session: SshSessionRef): number | null {
  const siblings = sessions.filter(s => s.conn.id === session.conn.id).sort((a, b) => Number(!!a.splitOnly) - Number(!!b.splitOnly));
  return siblings.length > 1 ? siblings.findIndex(s => s.tabId === session.tabId) + 1 : null;
}

/** Focus may outlive a split or a tab; actions must never target a hidden session. */
export function focusedTerminalSession(sessions: SshSessionRef[], activeId: string | null, split: SplitInfo | null, focusedTabId: string | null): SshSessionRef | null {
  const primary = sessions.find(s => s.sessionId === activeId) ?? null;
  if (!primary) return null;
  if (split?.zoomedTabId === primary.tabId) return primary;
  if (split?.zoomedTabId === split?.secTabId && split?.secTabId) return sessions.find(s => s.tabId === split.secTabId) ?? primary;
  if (split?.secTabId && focusedTabId === split.secTabId) {
    return sessions.find(s => s.tabId === split.secTabId) ?? primary;
  }
  return primary;
}

/** Prefer a live session; the first retained/disconnected tab is not the host's connection state. */
export function connectionSessions(sessions: SshSessionRef[], connectionId: string, activeId: string | null) {
  const matches = sessions.filter(s => s.conn.id === connectionId);
  const live = matches.filter(s => !s.closedReason);
  const tabs = matches.filter(s => !s.splitOnly);
  const active = tabs.find(s => s.sessionId === activeId);
  return { session: active && !active.closedReason ? active : tabs.find(s => !s.closedReason) ?? active ?? tabs[0], liveCount: live.length, active: !!active };
}

/**
 * 同时活着的终端会话上限。
 *
 * 软件主动限制为 10，避免无意创建大量本地 SSH 进程；这不是远端服务器的全局配额。
 */
export const MAX_LIVE_SESSIONS = 10;

/**
 * 还能不能再开一个会话。够了就返回一句能执行的话（说清上限与出路），否则 null。
 * 空字符串不返回——调用方用 `if (msg)` 判断，返回 "" 等于没拦住。
 */
export function sessionLimitMessage(liveCount: number): string | null {
  if (liveCount < MAX_LIVE_SESSIONS) return null;
  return `同时连接的终端已达软件上限 ${MAX_LIVE_SESSIONS} 个，先断开不用的标签再开。`;
}
