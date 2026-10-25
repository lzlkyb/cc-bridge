import { useCallback, useEffect, useState } from "react";
import type { SshSessionRef } from "./TerminalConnectionItem";

/**
 * 各会话的远端 cwd（OSC 7 探测，见 hooks/useTerminalOsc.ts）登记表。
 * 拖拽上传拿它当目标目录，省掉「每次拖文件都问传到哪」。
 *
 * 从 TerminalTab 内联状态抽出（规则 7）：抽出时补上**对账清理**——会话移除
 * （关标签 / 删连接）与重连换新 sessionId 后同步删掉旧 key。只增不减的旧版
 * 在长开的工作区里会攒下几百条永远用不到的死映射。
 */
export function useTerminalCwds(sessions: SshSessionRef[], activeId: string | null) {
  const [cwdBySession, setCwdBySession] = useState<Record<string, string | null>>({});

  const onCwd = useCallback((sessionId: string, cwd: string | null) => {
    setCwdBySession((m) => (m[sessionId] === cwd ? m : { ...m, [sessionId]: cwd }));
  }, []);

  useEffect(() => {
    setCwdBySession((m) => {
      const live = new Set(sessions.map((s) => s.sessionId));
      if (Object.keys(m).every((k) => live.has(k))) return m;
      const next: Record<string, string | null> = {};
      for (const k of Object.keys(m)) if (live.has(k)) next[k] = m[k];
      return next;
    });
  }, [sessions]);

  const activeCwd = activeId ? (cwdBySession[activeId] ?? null) : null;
  return { onCwd, activeCwd };
}
