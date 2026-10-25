import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { invoke, listen } from "../lib/tauri";
import {
  CC_EVENT_NAME,
  type CcEventPayload,
  type CcRestore,
  type CcRestoreReq,
  type CcSnapshot,
} from "../lib/ccEventTypes";
import type { CcAction } from "../lib/ccReducer";

/**
 * 对话事件流：**先铸发 id → 订阅 → 再拉快照 → 用序号补漏**。
 *
 * 四件事必须按这个顺序做，否则会漏事件：
 * 1. 先铸发（`cc_new_session`）—— 它是「这一路对话」的内部身份，后面每一步
 *    都按它寻址。纯本地操作（内存表插入），不涉及 IO，也还没有任何事件；
 * 2. 先订阅 —— 订阅之前发生的事件一条都收不到；
 * 3. 再拉快照 —— 它包含**订阅那一刻之前**的全部事件，与第 2 步必然重叠；
 * 4. 最后用序号把重叠部分丢掉（`seq < nextSeq` 的都已在快照里）。
 *
 * 反过来（先快照再订阅）会丢掉两者之间的那一段，而它恰好包含「刚发出的那句话」
 * 和「刚回来的第一条流式碎片」—— 表现是偶发、只在慢机器上出现的丢头。
 *
 * 2026-10-24 从 `useCcSession` 拆出：整套订阅生命周期自成一个关注点，与命令类
 * 回调（start / respond / interrupt…）不共用任何状态，除了 `dispatch`。
 * 拆完两边都回到门禁之内（宿主 335 → ~280 行）。
 *
 * 2026-10-25 多会话化（3-1a）：铸发一步挪到最前，事件按 `sessionId` 分流。
 * 3-1a 期前端只持有自己这一条，别路事件原样忽略 —— 行为与单例期逐字节一致。
 *
 * 🔴 StrictMode 下 effect 双跑会铸发两条：先跑的那条没有任何命令指向它，
 * 没有进程、没有事件、退出时 `persist_all` 对空 ring 直接跳过 —— 一条查得到、
 * 但谁也不占的哑会话。双跑只发生在开发模式，不值得为它加锁。
 *
 * `restored` 只负责**报告**「这条是恢复来的」：应用目标信息（connectionId /
 * cwd / model）是页面的职责，那些字段还牵着 localStorage 与探测。
 *
 * 2026-10-25（3-1c）：载入哪一条由调用方以 `restore` **ref** 指定，三态见
 * [`CcRestoreReq`]。用 ref 而不是普通参数：它决定的是「首帧那一刻的意图」，
 * 之后无论如何变都不该重订阅（重订阅会清空 `seqRef` 与 `restored`）。
 */
export function useCcEventStream(
  dispatch: (action: CcAction) => void,
  restore: MutableRefObject<CcRestoreReq>,
) {
  /** 已消化的最大序号 + 1。快照与实时事件的去重全靠它。 */
  const seqRef = useRef(0);
  /** 快照与补漏都吃完了。这之前实时事件只进缓冲，不进 reducer。 */
  const [ready, setReady] = useState(false);
  /** 上次进程留下的会话（`cc_restore` 的返回）。`null` = 这次是全新开始。 */
  const [restored, setRestored] = useState<CcRestore | null>(null);
  /** 打开一条历史后要清掉它：当前会话已经就是那条历史了，再弹恢复提示纯属噪音。 */
  const clearRestored = useCallback(() => setRestored(null), []);
  /**
   * 本路对话的内部 id（`cc_new_session` 铸发）。命令类回调（start / respond /
   * interrupt / reset / openHistory）全部带它寻址；`null` = 还没铸发完。
   */
  const sessionIdRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const buffered: CcEventPayload[] = [];
    let readyToApply = false;
    /** 缺口自愈的防抖句柄：seq 跳号 ⇒ 中间有事件没送到（webview 重载 / 事件丢失）。 */
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
    /** 本路会话的内部 id；铸发完成后供 `reconcile` 寻址。 */
    let sidVal: number | null = null;

    /** 拉一次快照、从空态重放：缺口前后的事件状态都由它重建，游标对到最新。 */
    const reconcile = async () => {
      reconcileTimer = undefined;
      if (sidVal === null) return;
      try {
        const snap = await invoke<CcSnapshot>("cc_snapshot", { sessionId: sidVal });
        if (!alive || !readyToApply) return;
        seqRef.current = snap.nextSeq;
        dispatch({
          type: "replay",
          events: snap.events,
          dropped: snap.dropped,
          running: snap.running,
        });
      } catch {
        // 拉不动就作罢：下一条实时事件来时若仍有缺口会再排一次。
      }
    };

    const apply = (p: CcEventPayload) => {
      if (p.seq < seqRef.current) return; // 快照里已经有了
      // 跳号 ⇒ 传输层丢了事件。本条照常应用，稍后拉快照把缺口补齐。
      // （emit 与 seq 的顺序在 Rust 侧有锁保证一致，缺口只可能来自传输层。）
      if (p.seq > seqRef.current && reconcileTimer === undefined) {
        reconcileTimer = setTimeout(() => void reconcile(), 300);
      }
      seqRef.current = p.seq + 1;
      dispatch({ type: "event", event: p.event });
    };

    void (async () => {
      try {
        // 1. 铸发。之后每一步都按这个 id 寻址。
        const sid = await invoke<number>("cc_new_session");
        if (!alive) return;
        sidVal = sid;
        sessionIdRef.current = sid;
        // 2. 订阅。只收自己这条：多会话并存时别路事件对本界面只是噪音。
        unlisten = await listen<CcEventPayload>(CC_EVENT_NAME, (p) => {
          if (p.sessionId !== sid) return;
          if (!readyToApply) {
            buffered.push(p);
            return;
          }
          apply(p);
        });
        if (!alive) {
          // cleanup 在 `await listen` 期间已经跑过（`unlisten?.()` 那时还是 undefined）。
          // 此刻必须亲手摘掉刚挂上的监听 —— 否则它收着**所有会话**的每条事件、
          // 永不回收，快速开关 pane 几次就攒一堆。
          unlisten();
          return;
        }
        const snap = await invoke<CcSnapshot>("cc_snapshot", { sessionId: sid });
        if (!alive) return;
        seqRef.current = snap.nextSeq;
        // 只有「这个进程一个事件都还没产生」才去读落盘的会话。
        // 切页回来 / 前端热重载时 ring 里就是当前会话，它一定不比库里的旧 ——
        // 混用会让界面闪回上一次运行的内容。
        let fromDb: CcRestore | null = null;
        const plan = restore.current;
        // `seed`（分叉出来的新会话）**不读库**：它是一条全新会话，库里没有它，
        // 读「最近那条」反而会把源会话的内容灌进来。
        if (snap.nextSeq === 0 && (plan.kind === "latest" || plan.kind === "row")) {
          try {
            fromDb = await invoke<CcRestore | null>("cc_restore", {
              sessionId: sid,
              // `latest` 传 null：后端按「最近那条」取（重启恢复）。
              rowId: plan.kind === "row" ? plan.rowId : null,
            });
          } catch {
            // 恢复是锦上添花：库读不出来就空白起步，不能因此挡住整个对话。
            fromDb = null;
          }
          if (!alive) return;
          // 读库期间如果已经来了实时事件，说明真正在用这个进程的是「刚刚」，
          // 不是「上次」。让旧内容插到前面只会得到一份前后接不上的记录。
          if (buffered.length > 0) fromDb = null;
        }
        dispatch({
          type: "replay",
          events: fromDb?.events ?? snap.events,
          dropped: fromDb ? fromDb.dropped : snap.dropped,
          running: snap.running,
        });
        if (fromDb) setRestored(fromDb);
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
      sessionIdRef.current = null;
      if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
      unlisten?.();
    };
  }, [dispatch, restore]);

  return { ready, restored, clearRestored, seqRef, sessionIdRef };
}
