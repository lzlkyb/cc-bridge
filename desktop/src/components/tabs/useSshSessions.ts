import { useCallback, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import type { SshConnection } from "../../lib/types";
import { EMPTY_TAB_META, type TermTabMeta } from "../../lib/terminalTabMeta";
import type { SshSessionRef } from "./TerminalConnectionItem";

/** 新建会话的初始 PTY 尺寸；终端挂载后会立即用真实尺寸 resize 一次。 */
const INITIAL_ROWS = 30;
const INITIAL_COLS = 100;

/** 标签身份的递增计数。不用 crypto.randomUUID：只要在本次运行内唯一就够了。 */
let tabSeq = 0;
const nextTabId = () => `tab-${++tabSeq}`;

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
  // 标签 meta（OSC 标题 / 进度 / 铃），由 SshTerminal 经 patchMeta 上报，标签栏展示。
  // 按 sessionId 存：重连换 sessionId，旧 key 随 closeTab / dropConnection 清理。
  const [metaBySession, setMetaBySession] = useState<Record<string, TermTabMeta>>({});

  // 事件回调（ssh_closed / ssh_connect_failed）需要读到**当下**的会话列表来去重，
  // 而它们是稳定回调、拿不到最新的 state。所有写入都走 patch，ref 与 state 始终同步。
  const sessionsRef = useRef<SshSessionRef[]>([]);
  const patch = useCallback((fn: (prev: SshSessionRef[]) => SshSessionRef[]) => {
    sessionsRef.current = fn(sessionsRef.current);
    setSessions(sessionsRef.current);
  }, []);

  /** 上报/修改某会话的标签 meta（标题、进度、铃）。浅合并，只写传入的字段。 */
  const patchMeta = useCallback((sessionId: string, p: Partial<TermTabMeta>) => {
    setMetaBySession((m) => {
      const cur = m[sessionId] ?? EMPTY_TAB_META;
      const next: TermTabMeta = { ...cur, ...p };
      // 值没变就不产生新对象，避免标签栏无谓重渲染。
      // 🔴 progress 要按值比（state/value）而不是比引用：addon 每次 onChange 都造新对象，
      // 有的程序（如 rsync 包装器）会周期性重发同一进度值。
      const progressSame =
        next.progress === cur.progress ||
        (next.progress != null &&
          cur.progress != null &&
          next.progress.state === cur.progress.state &&
          next.progress.value === cur.progress.value);
      if (next.title === cur.title && progressSame && next.bellAt === cur.bellAt) {
        return m;
      }
      return { ...m, [sessionId]: next };
    });
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
   * 连接。三种落点，优先级从上到下：
   *
   * - `intoTab`：重连指定标签。**保留 tabId**，只换 sessionId——React 不重挂，
   *   xterm 实例和它的历史输出都活着。
   * - `newTab`：强制另开一个。以前同一台机器只能开一个终端，
   *   想一边 `tail -f` 一边敲命令就得开两个 app。
   * - 都没传：有活着的就切过去；否则原位复用该连接残留的已断开标签（位置不跳）；
   *   再否则追加。
   */
  const connect = useCallback(
    async (conn: SshConnection, opts?: { newTab?: boolean; intoTab?: string; forSplit?: boolean }) => {
      if (!opts?.newTab && !opts?.intoTab && !opts?.forSplit) {
        const live = sessionsRef.current.find((s) => s.conn.id === conn.id && !s.closedReason && !s.splitOnly);
        if (live) {
          setActiveId(live.sessionId);
          return null;
        }
      }
      setConnectingId(conn.id);
      try {
        const sessionId = await invoke<string>("ssh_connect", {
          args: { connectionId: conn.id, rows: INITIAL_ROWS, cols: INITIAL_COLS },
        });
        let createdTabId: string | null = null;
        patch((prev) => {
          // 找要复用的标签：指定了就找它，否则找本连接第一个已断开的；newTab 不复用。
          const idx = opts?.intoTab
            ? prev.findIndex((s) => s.tabId === opts.intoTab)
            : opts?.newTab || opts?.forSplit
              ? -1
              : prev.findIndex((s) => s.conn.id === conn.id && s.closedReason && !s.splitOnly);
          if (idx < 0) {
            createdTabId = nextTabId();
            return [
              ...prev,
              { tabId: createdTabId, sessionId, conn, closedReason: null, splitOnly: opts?.forSplit || undefined },
            ];
          }
          const next = [...prev];
          // 展开旧项以**保留 tabId**，这正是历史输出能活下来的原因。
          next[idx] = { ...next[idx], sessionId, conn, closedReason: null };
          return next;
        });
        // 分屏会话不抢焦点：主视图仍停在宿主标签（forSplit 语义，见 SshSessionRef.splitOnly）。
        if (!opts?.forSplit) setActiveId(sessionId);
        // 前台可见的连接成功提示（注意：进程起来不等于认证成功，
        // 宽限期内失败会由 ssh_connect_failed 补一条带原因的错误提示）。
        toast(`SSH 已连接 ${conn.username}@${conn.host}:${conn.port}`, "success");
        return createdTabId;
      } catch (e) {
        toast(`连接失败：${e}`, "error");
        return null;
      } finally {
        setConnectingId(null);
      }
    },
    [patch],
  );

  /**
   * 会话恢复（lib/terminalSessionRestore）：按快照重建「未连接」占位标签。
   *
   * 占位项用假 sessionId（`restore:` 前缀）+ `closedReason: "restored"` 哨兵：
   * 渲染层（TerminalPanes）见到 restored 哨兵就不挂 SshTerminal，改挂恢复占位卡。
   * 用户点「恢复连接」走 intoTab —— connect 按 tabId 展开旧项换真 sessionId，
   * 占位转正，正是「重连保留标签」的现成路径。
   */
  const addRestoredTab = useCallback(
    (conn: SshConnection): string => {
      const tabId = nextTabId();
      patch((prev) => [
        ...prev,
        { tabId, sessionId: `restore:${tabId}`, conn, closedReason: "restored" },
      ]);
      return tabId;
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
      setMetaBySession((m) => {
        if (!(sessionId in m)) return m;
        const { [sessionId]: _drop, ...rest } = m;
        return rest;
      });
      // 关掉当前标签后激活相邻会话（优先右邻、没有则左邻），而不是掉进空面板——
      // 以前直接置 null，于是标签栏上明明还剩几个会话，右边却显示「从左侧选择一个连接开始」。
      // 🔴 跳过 splitOnly：那是别的标签分屏里的会话，激活它主视图会落到一个不存在的标签上。
      setActiveId((cur) =>
        cur === sessionId
          ? (() => {
              const visible = next.filter((s) => !s.splitOnly);
              return visible.length ? visible[Math.min(idx, visible.length - 1)].sessionId : null;
            })()
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
      setMetaBySession((m) => {
        const drop = new Set(linked.map((s) => s.sessionId));
        let changed = false;
        const rest: Record<string, TermTabMeta> = {};
        for (const k of Object.keys(m)) {
          if (drop.has(k)) {
            changed = true;
          } else {
            rest[k] = m[k];
          }
        }
        return changed ? rest : m;
      });
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
    metaBySession,
    setActiveId,
    connect,
    disconnect,
    closeTab,
    markClosed,
    dropConnection,
    patchMeta,
    addRestoredTab,
  };
}
