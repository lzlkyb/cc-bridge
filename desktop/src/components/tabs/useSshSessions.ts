import { useCallback, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import type { SshConnection } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";

/** 新建会话的初始 PTY 尺寸；终端挂载后会立即用真实尺寸 resize 一次。 */
const INITIAL_ROWS = 30;
const INITIAL_COLS = 100;

/**
 * 终端会话集合的全部状态转移：连接 / 断开 / 重连 / 关标签。
 *
 * 核心设定：**断开不等于移除**。会话断开后只是被打上 `closedReason`，终端仍挂着，
 * 历史输出可读可复制，并能原地重连。以前的做法是直接从数组里删掉，后果是：
 * `term.write("[连接失败] …")` 写完组件就卸载了（xterm 的 write 攒到 rAF 才刷），
 * 那行原因**从来没机会渲染**，用户只看到标签凭空消失。
 */
export function useSshSessions() {
  const [sessions, setSessions] = useState<SshSessionRef[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // 连接进行中：列表项灰显「连接中…」+ 按钮 loading（纯前端态，无后端依赖）。
  const [connectingId, setConnectingId] = useState<string | null>(null);

  // 事件回调（ssh_closed / ssh_connect_failed）需要读到**当下**的会话列表来去重，
  // 而它们是稳定回调、拿不到最新的 state。所有写入都走 patch，ref 与 state 始终同步。
  const sessionsRef = useRef<SshSessionRef[]>([]);
  const patch = useCallback((fn: (prev: SshSessionRef[]) => SshSessionRef[]) => {
    sessionsRef.current = fn(sessionsRef.current);
    setSessions(sessionsRef.current);
  }, []);

  /**
   * 会话被远端结束（断开 / 连接失败）。已经是断开态就直接忽略：
   * 一次失败往往会先发 connect_failed（带具体原因）再发 closed（只有笼统描述），
   * 不守住就会把具体原因覆盖掉、并多弹一条 toast。
   */
  const markClosed = useCallback(
    (sessionId: string, reason: string) => {
      const cur = sessionsRef.current.find((s) => s.sessionId === sessionId);
      if (!cur || cur.closedReason) return;
      patch((prev) =>
        prev.map((s) => (s.sessionId === sessionId ? { ...s, closedReason: reason } : s)),
      );
      toast(`${cur.conn.name || cur.conn.host}：${reason}`, "error");
    },
    [patch],
  );

  /**
   * 连接。已有活着的会话则直接切过去；若该连接残留一个已断开的标签，
   * 新会话**原位替换**它（而不是追加），避免标签栏堆一排死标签、且保持位置不跳。
   */
  const connect = useCallback(
    async (conn: SshConnection) => {
      const live = sessionsRef.current.find((s) => s.conn.id === conn.id && !s.closedReason);
      if (live) {
        setActiveId(live.sessionId);
        return;
      }
      setConnectingId(conn.id);
      try {
        const sessionId = await invoke<string>("ssh_connect", {
          args: { connectionId: conn.id, rows: INITIAL_ROWS, cols: INITIAL_COLS },
        });
        const fresh: SshSessionRef = { sessionId, conn, closedReason: null };
        patch((prev) => {
          const idx = prev.findIndex((s) => s.conn.id === conn.id && s.closedReason);
          if (idx < 0) return [...prev, fresh];
          const next = [...prev];
          next[idx] = fresh;
          return next;
        });
        setActiveId(sessionId);
        // 前台可见的连接成功提示（注意：进程起来不等于认证成功，
        // 宽限期内失败会由 ssh_connect_failed 补一条带原因的错误提示）。
        toast(`SSH 已连接 ${conn.username}@${conn.host}:${conn.port}`, "success");
      } catch (e) {
        toast(`连接失败：${e}`, "error");
      } finally {
        setConnectingId(null);
      }
    },
    [patch],
  );

  /** 用户主动断开：杀进程，但**保留标签**。 */
  const disconnect = useCallback(
    async (sessionId: string) => {
      // 先置断开态：随后到达的 ssh_closed 会被 markClosed 的守卫吃掉，不再多弹一条 toast
      // （用户自己点的断开，没必要再告知一遍）。
      patch((prev) =>
        prev.map((s) =>
          s.sessionId === sessionId ? { ...s, closedReason: s.closedReason ?? "已手动断开" } : s,
        ),
      );
      try {
        await invoke("ssh_disconnect", { sessionId });
      } catch {
        /* 已断开也继续保持 UI 一致 */
      }
    },
    [patch],
  );

  /** 真正移除标签（已断开的会话）。 */
  const closeTab = useCallback(
    (sessionId: string) => {
      const prev = sessionsRef.current;
      const idx = prev.findIndex((s) => s.sessionId === sessionId);
      const next = prev.filter((s) => s.sessionId !== sessionId);
      patch(() => next);
      // 关掉当前标签后激活相邻会话（优先右邻、没有则左邻），而不是掉进空面板——
      // 以前直接置 null，于是标签栏上明明还剩几个会话，右边却显示「从左侧选择一个连接开始」。
      setActiveId((cur) =>
        cur === sessionId
          ? next.length
            ? next[Math.min(idx, next.length - 1)].sessionId
            : null
          : cur,
      );
    },
    [patch],
  );

  /** 连接被删除：断掉它的全部会话并移除标签（连接都没了，留着死标签无意义）。 */
  const dropConnection = useCallback(
    (connId: string) => {
      const linked = sessionsRef.current.filter((s) => s.conn.id === connId);
      for (const s of linked) {
        void invoke("ssh_disconnect", { sessionId: s.sessionId }).catch(() => {});
      }
      const next = sessionsRef.current.filter((s) => s.conn.id !== connId);
      patch(() => next);
      setActiveId((cur) =>
        linked.some((s) => s.sessionId === cur) ? (next[0]?.sessionId ?? null) : cur,
      );
    },
    [patch],
  );

  return {
    sessions,
    activeId,
    connectingId,
    setActiveId,
    connect,
    disconnect,
    closeTab,
    markClosed,
    dropConnection,
  };
}
