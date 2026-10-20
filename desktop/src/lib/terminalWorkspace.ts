import type { SshSessionRef } from "../components/tabs/TerminalConnectionItem";
import type { SplitInfo } from "../components/tabs/useTerminalSplit";

/** Focus may outlive a split or a tab; actions must never target a hidden session. */
export function focusedTerminalSession(sessions: SshSessionRef[], activeId: string | null, split: SplitInfo | null, focusedTabId: string | null): SshSessionRef | null {
  const primary = sessions.find(s => s.sessionId === activeId) ?? null;
  if (!primary) return null;
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
