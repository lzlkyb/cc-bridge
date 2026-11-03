import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import type { SshSessionRef } from "./TerminalConnectionItem";

/**
 * 撤销窗口：关掉一个**还活着**的标签后，连接先留着，这段时间内可以撤回。
 *
 * WHY 延迟断开，而不是「立即断开 + 撤销时重连」：
 * 重连要把 ssh 整个过程再走一遍（跳板机、凭据、重连后 shell 里 cd 过的目录、正在跑的后台任务
 * 全部重来），而误关标签的代价不该这么高。窗口期内连接还在，撤销就只是把标签塞回列表——
 * 远端 shell 原封不动。代价是屏幕上的历史输出看不到了（后端没有回放缓冲），
 * 用户按一下回车就能确认它活着。
 *
 * 🔴 到点必须真的断开：`state.rs::gc_ssh_sessions` 明确「不杀活跃会话」，
 * 漏掉这一步连接就一直挂着——不只是本机内存，服务器端 `MaxSessions`（默认 10）会被占满。
 *
 * 已断开的会话**不进这个窗口**（调用方判断 `closedReason`）：它后端早没连接了，
 * 撤销一个死标签没有意义，真要它回来是「重连」，走恢复路径。
 */
const UNDO_MS = 8000;

interface Pending {
  session: SshSessionRef;
  /** 原位置：撤回来时要回到原来的地方，扔到末尾会让人找不到它。 */
  index: number;
  timer: number;
}

export function useTabCloseUndo(
  patch: (fn: (prev: SshSessionRef[]) => SshSessionRef[]) => void,
  setActiveId: Dispatch<SetStateAction<string | null>>,
) {
  const pending = useRef(new Map<string, Pending>());

  const undo = useCallback(
    (sessionId: string) => {
      const entry = pending.current.get(sessionId);
      if (!entry) return;
      window.clearTimeout(entry.timer);
      pending.current.delete(sessionId);
      patch((prev) => {
        // 幂等：同一条通知连点两次，或撤回后又立刻关掉，都不该出现两个同名标签。
        if (prev.some((s) => s.sessionId === entry.session.sessionId)) return prev;
        const next = [...prev];
        next.splice(Math.min(entry.index, next.length), 0, entry.session);
        return next;
      });
      setActiveId(entry.session.sessionId);
    },
    [patch, setActiveId],
  );

  /** 排进撤销窗口并发一条带「撤销」的通知。通知驻留与窗口等长，否则窗口还开着却没有入口了。 */
  const schedule = useCallback(
    (session: SshSessionRef, index: number) => {
      const id = session.sessionId;
      const timer = window.setTimeout(() => {
        pending.current.delete(id);
        void invoke("ssh_disconnect", { sessionId: id }).catch(() => {});
      }, UNDO_MS);
      pending.current.set(id, { session, index, timer });
      const name = session.label || session.conn.name || session.conn.host;
      toast(`已关闭 ${name}`, "info", { label: "撤销", onClick: () => undo(id) }, UNDO_MS);
    },
    [undo],
  );

  // 卸载时窗口还没走完：立刻断开。留着定时器不管的话，宿主组件一销毁它就再也没人执行，
  // 连接便永久泄漏。应用整体退出另有 `kill_all_ssh_sessions` 兜底，这两条不冲突。
  useEffect(() => {
    const map = pending.current;
    return () => {
      for (const [id, entry] of map) {
        window.clearTimeout(entry.timer);
        void invoke("ssh_disconnect", { sessionId: id }).catch(() => {});
      }
      map.clear();
    };
  }, []);

  return useMemo(() => ({ schedule, undo }), [schedule, undo]);
}
