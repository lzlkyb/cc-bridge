import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { SshConnection } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { useSshSessions } from "./useSshSessions";
import { defaultSplitDirection, type SplitDirection } from "../../lib/terminalSplitLayout";
import { useViewActive } from "../../lib/viewActivity";

/** One host tab owns two panes. A collapsed secondary becomes an ordinary tab. */
export interface SplitInfo {
  dir: SplitDirection;
  ratio: number;
  secTabId: string | null;
  zoomedTabId?: string | null;
}
type Ssh = ReturnType<typeof useSshSessions>;

export function useTerminalSplit({ ssh, activeSession, areaRef }: { ssh: Ssh; activeSession: SshSessionRef | null; areaRef?: RefObject<HTMLElement | null> }) {
  const [splits, setSplits] = useState<Record<string, SplitInfo>>({});
  const viewActive = useViewActive();
  const sshRef = useRef(ssh);
  sshRef.current = ssh;
  const splitsRef = useRef(splits);
  const pending = useRef(new Map<string, symbol>());
  const preferredDir = useRef<SplitDirection | null>(null);
  const hostTabId = activeSession?.tabId ?? null;
  const split = hostTabId ? (splits[hostTabId] ?? null) : null;
  const patch = useCallback((fn: (prev: Record<string, SplitInfo>) => Record<string, SplitInfo>) => {
    splitsRef.current = fn(splitsRef.current);
    setSplits(splitsRef.current);
  }, []);

  const closeSplit = useCallback((host: string) => {
    pending.current.delete(host);
    const secondary = splitsRef.current[host]?.secTabId;
    if (secondary) sshRef.current.releaseSplit(secondary);
    patch(prev => {
      if (!(host in prev)) return prev;
      const { [host]: _drop, ...rest } = prev;
      return rest;
    });
  }, [patch]);

  const openSplit = useCallback(async (conn: SshConnection, dir: SplitDirection) => {
    if (!hostTabId || pending.current.has(hostTabId) || splitsRef.current[hostTabId]?.secTabId) return;
    const request = Symbol();
    pending.current.set(hostTabId, request);
    patch(prev => ({ ...prev, [hostTabId]: { dir, ratio: 50, secTabId: null } }));
    const tabId = await sshRef.current.connect(conn, { forSplit: true });
    // A late SSH response must not resurrect a collapsed/replaced split or hide a live orphan.
    if (pending.current.get(hostTabId) !== request || !sshRef.current.sessions.some(s => s.tabId === hostTabId)) {
      if (tabId) sshRef.current.releaseSplit(tabId);
      return;
    }
    pending.current.delete(hostTabId);
    patch(prev => prev[hostTabId] ? { ...prev, [hostTabId]: { ...prev[hostTabId], secTabId: tabId } } : prev);
  }, [hostTabId, patch]);

  const toggleSplit = useCallback(() => {
    if (!hostTabId || !activeSession) return;
    if (splitsRef.current[hostTabId]) closeSplit(hostTabId);
    else void openSplit(activeSession.conn, preferredDir.current ?? defaultSplitDirection(areaRef?.current?.clientWidth ?? 0));
  }, [hostTabId, activeSession, closeSplit, openSplit, areaRef]);

  const setDirection = useCallback((dir: SplitDirection) => {
    preferredDir.current = dir;
    patch(prev => hostTabId && prev[hostTabId] ? { ...prev, [hostTabId]: { ...prev[hostTabId], dir } } : prev);
  }, [hostTabId, patch]);
  const toggleDir = () => setDirection(split?.dir === "h" ? "v" : "h");
  const setRatio = useCallback((ratio: number) => {
    patch(prev => hostTabId && prev[hostTabId] ? { ...prev, [hostTabId]: { ...prev[hostTabId], ratio: Math.min(80, Math.max(20, ratio)) } } : prev);
  }, [hostTabId, patch]);
  const toggleZoom = (tabId: string) => {
    patch(prev => hostTabId && prev[hostTabId] ? { ...prev, [hostTabId]: { ...prev[hostTabId], zoomedTabId: prev[hostTabId].zoomedTabId === tabId ? null : tabId } } : prev);
  };

  useEffect(() => {
    const ids = new Set(ssh.sessions.map(s => s.tabId));
    for (const [host, info] of Object.entries(splitsRef.current)) {
      if (!ids.has(host) || (info.secTabId && !ids.has(info.secTabId))) closeSplit(host);
    }
  }, [ssh.sessions, closeSplit]);

  const toggleRef = useRef(toggleSplit);
  toggleRef.current = toggleSplit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Fixed fullscreen elements have no offsetParent, but still have a rendered rectangle.
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "d" && viewActive && (!areaRef?.current || areaRef.current.getClientRects().length > 0)) {
        e.preventDefault(); e.stopPropagation(); toggleRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [areaRef, viewActive]);
  return { split, openSplit, closeSplit, toggleSplit, toggleDir, setDirection, setRatio, toggleZoom };
}
