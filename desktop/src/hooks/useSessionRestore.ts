import { useEffect, useRef, useState } from "react";
import { loadRestoreSnapshot, saveRestoreSnapshot } from "../lib/terminalSessionRestore";
import type { SshConnection } from "../lib/types";
import type { useSshSessions } from "../components/tabs/useSshSessions";

type Ssh = ReturnType<typeof useSshSessions>;

/**
 * 终端会话恢复（方案 A：骨架恢复 + 手动重连）。
 *
 * - **恢复**：connections 列表就绪后执行一次——按快照把上次的主格标签重建为
 *   「未连接」占位（closedReason: "restored"），不自动发起任何 SSH 连接；
 *   重连由用户点占位卡/横幅按钮（走 intoTab，复用「重连保留标签」路径）。
 * - **写快照**：恢复完成之后，主格序列或活动标签变化时 debounce 落盘。
 *   🔴 gate 在恢复完成之后：否则启动瞬间（sessions 还是空的）就会把快照覆盖成空。
 */
export function useSessionRestore({
  ssh,
  connections,
  ready,
}: {
  ssh: Ssh;
  connections: SshConnection[];
  /** 连接列表已从后端拿到（恢复的前置数据）。 */
  ready: boolean;
}) {
  const sshRef = useRef(ssh);
  sshRef.current = ssh;
  const [phase, setPhase] = useState<"idle" | "done">("idle");

  // 恢复：一次。connections 变化（增删连接）不重放——那是 dropConnection 的职责。
  useEffect(() => {
    if (!ready) return;
    const snap = loadRestoreSnapshot();
    setPhase("done");
    if (!snap || snap.tabs.length === 0) return;
    const byId = new Map(connections.map((c) => [c.id, c]));
    const tabIds: string[] = [];
    for (const t of snap.tabs) {
      const conn = byId.get(t.connId);
      if (!conn) continue; // 连接已被删除：静默跳过该标签
      tabIds.push(sshRef.current.addRestoredTab(conn));
    }
    if (tabIds.length > 0) {
      const idx = Math.min(Math.max(snap.active, 0), tabIds.length - 1);
      sshRef.current.setActiveId(`restore:${tabIds[idx]}`);
    }
    // 只在 ready 翻转（列表首次就绪）时执行；connections 的引用随 query 稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖扩到 connections 会在每次增删连接时重放恢复
  }, [ready]);

  // 写快照：恢复完成后，主格序列/活动标签变化 debounce 600ms 落盘。
  // 副格（splitOnly）不入快照——分屏形状每次自己开，快照只管标签组。
  useEffect(() => {
    if (phase !== "done") return;
    const id = setTimeout(() => {
      const cur = sshRef.current;
      const tabs = cur.sessions.filter((s) => !s.splitOnly);
      const active = Math.max(tabs.findIndex((s) => s.sessionId === cur.activeId), 0);
      saveRestoreSnapshot(tabs.map((s) => ({ connId: s.conn.id })), active);
    }, 600);
    return () => clearTimeout(id);
  }, [phase, ssh.sessions, ssh.activeId]);
}
