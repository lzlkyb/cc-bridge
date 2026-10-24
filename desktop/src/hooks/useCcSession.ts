import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { invoke, listen } from "../lib/tauri";
import {
  CC_EVENT_NAME,
  type CcEventPayload,
  type CcProbe,
  type CcSnapshot,
} from "../lib/ccEventTypes";
import { ccReducer, initialCcView, pendingApprovals } from "../lib/ccReducer";
import type { CcPermissionMode } from "../lib/ccGuiTypes";

/** 起一轮要传给后端的东西。 */
export type CcTarget = {
  /** `null` = 本机跑（探针与日常自测的必需路径）。 */
  connectionId: string | null;
  cwd: string | null;
  /** 探测得到的 claude 绝对路径。远端模式下必须给，否则非登录 shell 找不到它。 */
  claudePath: string | null;
  model: string | null;
  permissionMode: CcPermissionMode;
};

/**
 * 对话状态机（React 侧的门面）。
 *
 * ## 为什么先订阅、再拉快照、最后补漏
 *
 * 三件事必须按这个顺序做，否则会漏事件：
 * 1. 先订阅 —— 订阅之前发生的事件一条都收不到；
 * 2. 再拉快照 —— 它包含**订阅那一刻之前**的全部事件，与第 1 步必然重叠；
 * 3. 最后用序号把重叠部分丢掉（`seq < snapshot.nextSeq` 的都已在快照里）。
 *
 * 反过来（先快照再订阅）会丢掉两者之间的那一段，而它恰好包含「刚发出的那句话」
 * 和「刚回来的第一条流式碎片」—— 表现是偶发、只在慢机器上出现的丢头。
 *
 * ## 为什么这里的错误不弹 toast
 *
 * 对话页的错误（CLI 没装、模型名不对、远端路径找不到）是**内容**而不是打扰：
 * 它就长在对话流里，用户要能回头看到。toast 三秒后就没了。
 */
export function useCcSession(target: CcTarget) {
  const [view, dispatch] = useReducer(ccReducer, initialCcView);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<CcProbe | null>(null);
  const [ready, setReady] = useState(false);
  /** 已消化的最大序号 + 1。快照与实时事件的去重全靠它。 */
  const seqRef = useRef(0);
  /** 起一轮时读最新配置，避免把 target 塞进依赖导致反复重订阅。 */
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const buffered: CcEventPayload[] = [];
    let readyToApply = false;

    const apply = (p: CcEventPayload) => {
      if (p.seq < seqRef.current) return; // 快照里已经有了
      seqRef.current = p.seq + 1;
      dispatch({ type: "event", event: p.event });
    };

    void (async () => {
      try {
        unlisten = await listen<CcEventPayload>(CC_EVENT_NAME, (p) => {
          if (!readyToApply) {
            buffered.push(p);
            return;
          }
          apply(p);
        });
        if (!alive) return;
        const snap = await invoke<CcSnapshot>("cc_snapshot");
        if (!alive) return;
        seqRef.current = snap.nextSeq;
        dispatch({
          type: "replay",
          events: snap.events,
          dropped: snap.dropped,
          running: snap.running,
        });
        readyToApply = true;
        for (const p of buffered) apply(p);
        buffered.length = 0;
        setReady(true);
      } catch (e) {
        if (alive) dispatch({ type: "error", message: `订阅对话事件失败：${e}` });
      }
    })();

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  /** 探测 claude 是否可用。进页面、换连接、点「重试」时调。 */
  const runProbe = useCallback(async (): Promise<CcProbe | null> => {
    const t = targetRef.current;
    try {
      const res = await invoke<CcProbe>("cc_probe", {
        connectionId: t.connectionId,
        claudePath: t.claudePath,
      });
      setProbe(res);
      if (!res.found) dispatch({ type: "error", message: res.message });
      return res;
    } catch (e) {
      const msg = String(e);
      setProbe({ found: false, path: "", version: null, message: msg, target: "" });
      dispatch({ type: "error", message: msg });
      return null;
    }
  }, []);

  const start = useCallback(async (text: string) => {
    const t = targetRef.current;
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    dispatch({ type: "sending" });
    try {
      await invoke<void>("cc_start", {
        req: {
          connectionId: t.connectionId,
          cwd: t.cwd,
          model: t.model,
          permissionMode: t.permissionMode,
          claudePath: t.claudePath,
          text: trimmed,
        },
      });
    } catch (e) {
      // 后端已经把进程收尸了（`cc_start` 里的 interrupt），这里只负责说清楚。
      dispatch({ type: "error", message: String(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  const respond = useCallback(async (requestId: string, decision: "allow" | "deny", message?: string) => {
    try {
      await invoke<void>("cc_respond", { requestId, decision, message });
    } catch (e) {
      // 常见原因：这一轮已经结束（60s 超时 / 用户中断），请求 id 随之失效。
      dispatch({ type: "error", message: String(e) });
    }
  }, []);

  const interrupt = useCallback(async () => {
    try {
      await invoke<boolean>("cc_interrupt");
    } catch (e) {
      dispatch({ type: "error", message: String(e) });
    }
  }, []);

  const reset = useCallback(async () => {
    try {
      await invoke<void>("cc_reset");
      dispatch({ type: "reset" });
      setProbe(null);
    } catch (e) {
      dispatch({ type: "error", message: String(e) });
    }
  }, []);

  const clearError = useCallback(() => dispatch({ type: "error", message: null }), []);

  return {
    view,
    ready,
    busy,
    probe,
    runProbe,
    start,
    respond,
    interrupt,
    reset,
    clearError,
    /** 还卡着等用户决定的审批 id。 */
    pending: pendingApprovals(view),
  };
}
