import { useState } from "react";
import { focusedTerminalSession } from "../lib/terminalWorkspace";
import type { SshSessionRef } from "../components/tabs/TerminalConnectionItem";
import type { SplitInfo } from "../components/tabs/useTerminalSplit";

export function useTerminalWorkspace(sessions: SshSessionRef[], activeId: string | null, split: SplitInfo | null) {
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [focusedTabId, setFocusedTabId] = useState<string | null>(null);
  const focusedSession = focusedTerminalSession(sessions, activeId, split, focusedTabId);
  return { toolbarHost, setToolbarHost, focusedTabId, setFocusedTabId, focusedSession };
}
