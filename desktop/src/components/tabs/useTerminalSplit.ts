import { useCallback, useEffect, useRef, useState } from "react";
import type { SshConnection } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { useSshSessions } from "./useSshSessions";

/** 轻量双栏（方案 A）的宿主标签分屏信息。 */
export interface SplitInfo {
  /** "h" = 左右并排；"v" = 上下堆叠。 */
  dir: "h" | "v";
  /** 主格占比（%），拖拽分割条更新；夹在 [20, 80]。 */
  ratio: number;
  /** 副格会话的 tabId；null = 连接选择中（还没选连接）。 */
  secTabId: string | null;
}

type Ssh = ReturnType<typeof useSshSessions>;

/** 主格占比边界：再小两边都放不下一个可用的终端。 */
const RATIO_MIN = 20;
const RATIO_MAX = 80;
const RATIO_DEFAULT = 58;

/**
 * 终端轻量双栏（方案 A）的全部状态：每宿主标签最多一个副格。
 *
 * 设计要点：
 * - 副格会话带 `splitOnly` 标记，**不出现在标签栏**——分屏是「一个标签显示两个会话」，
 *   不是两个标签。宿主标签关闭 / 副格关闭 / 连接被删时自动回收（见下面的清理 effect）。
 * - 副格用 `forSplit` 连接：不抢 activeId（主视图停在宿主标签）。
 * - `sessions` 本就支持多会话并存，这里零后端改动。
 */
export function useTerminalSplit({ ssh, activeSession }: { ssh: Ssh; activeSession: SshSessionRef | null }) {
  const [splits, setSplits] = useState<Record<string, SplitInfo>>({});
  const sshRef = useRef(ssh);
  sshRef.current = ssh;
  // 闭包回调里要读「当下」的 splits（state 可能是旧渲染的），统一走 ref。
  const splitsRef = useRef(splits);
  splitsRef.current = splits;

  const hostTabId = activeSession?.tabId ?? null;
  const split = hostTabId ? (splits[hostTabId] ?? null) : null;

  /** 关闭某宿主标签的分屏：断开并移除副格会话，清掉分屏记录。 */
  const closeSplit = useCallback((hostTabId: string) => {
    const secTabId = splitsRef.current[hostTabId]?.secTabId;
    const info = secTabId ? sshRef.current.sessions.find((s) => s.tabId === secTabId) : undefined;
    if (info) {
      // 先杀进程再移除记录项；断开是异步的，closeTab 只动前端数组，顺序无所谓。
      if (!info.closedReason) void sshRef.current.disconnect(info.sessionId);
      sshRef.current.closeTab(info.sessionId);
    }
    setSplits((m) => {
      if (!(hostTabId in m)) return m;
      const { [hostTabId]: _drop, ...rest } = m;
      return rest;
    });
  }, []);

  /** 打开分屏：先落选择态（副格显示连接选择器），连上后回填 secTabId。 */
  const openSplit = useCallback(
    async (conn: SshConnection, dir: "h" | "v") => {
      if (!hostTabId) return;
      setSplits((m) => ({ ...m, [hostTabId]: { dir, ratio: RATIO_DEFAULT, secTabId: null } }));
      const tabId = await sshRef.current.connect(conn, { forSplit: true });
      // 连接失败 / 用户已把分屏关掉（记录已不在或已换成别的 secTabId）就不回填。
      setSplits((m) =>
        m[hostTabId] && m[hostTabId].secTabId === null ? { ...m, [hostTabId]: { ...m[hostTabId], secTabId: tabId } } : m,
      );
    },
    [hostTabId],
  );

  /** 对宿主标签当前的连接直接开分屏（Ctrl+Shift+D 快捷路径：同连接再开一个会话）。 */
  const toggleSplit = useCallback(() => {
    if (!hostTabId || !activeSession) return;
    if (splitsRef.current[hostTabId]) {
      closeSplit(hostTabId);
    } else {
      void openSplit(activeSession.conn, "h");
    }
  }, [hostTabId, activeSession, openSplit, closeSplit]);

  const toggleDir = useCallback(() => {
    setSplits((m) =>
      hostTabId && m[hostTabId]
        ? { ...m, [hostTabId]: { ...m[hostTabId], dir: m[hostTabId].dir === "h" ? "v" : "h" } }
        : m,
    );
  }, [hostTabId]);

  const setRatio = useCallback(
    (ratio: number) => {
      const clamped = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));
      setSplits((m) => (hostTabId && m[hostTabId] ? { ...m, [hostTabId]: { ...m[hostTabId], ratio: clamped } } : m));
    },
    [hostTabId],
  );

  // 回收：宿主标签没了 / 副格会话没了（连接被删、被单独关掉）→ 清掉对应记录。
  // 副格会话在 sessions 里被别的路径移除时，记录悬空会导致渲染层找不到会话。
  useEffect(() => {
    const tabIds = new Set(ssh.sessions.map((s) => s.tabId));
    setSplits((m) => {
      const next: Record<string, SplitInfo> = {};
      let changed = false;
      for (const [tabId, info] of Object.entries(m)) {
        if (tabIds.has(tabId) && (info.secTabId === null || tabIds.has(info.secTabId))) {
          next[tabId] = info;
        } else {
          changed = true;
        }
      }
      return changed ? next : m;
    });
  }, [ssh.sessions]);

  // Ctrl+Shift+D：对当前标签开/关分屏（同连接再开一个会话）。
  const toggleRef = useRef(toggleSplit);
  toggleRef.current = toggleSplit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        e.stopPropagation();
        toggleRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return { split, openSplit, closeSplit, toggleSplit, toggleDir, setRatio };
}
