import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../lib/tauri";
import {
  CC_EVENT_NAME,
  type CcEventPayload,
  type CcRestore,
  type CcSnapshot,
} from "../lib/ccEventTypes";
import type { CcAction } from "../lib/ccReducer";

/**
 * 对话事件流：**先订阅 → 再拉快照 → 用序号补漏**。
 *
 * 三件事必须按这个顺序做，否则会漏事件：
 * 1. 先订阅 —— 订阅之前发生的事件一条都收不到；
 * 2. 再拉快照 —— 它包含**订阅那一刻之前**的全部事件，与第 1 步必然重叠；
 * 3. 最后用序号把重叠部分丢掉（`seq < nextSeq` 的都已在快照里）。
 *
 * 反过来（先快照再订阅）会丢掉两者之间的那一段，而它恰好包含「刚发出的那句话」
 * 和「刚回来的第一条流式碎片」—— 表现是偶发、只在慢机器上出现的丢头。
 *
 * 2026-10-24 从 `useCcSession` 拆出：整套订阅生命周期自成一个关注点，与命令类
 * 回调（start / respond / interrupt…）不共用任何状态，除了 `dispatch`。
 * 拆完两边都回到门禁之内（宿主 335 → ~280 行）。
 *
 * `restored` 只负责**报告**「这条是恢复来的」：应用目标信息（connectionId /
 * cwd / model）是页面的职责，那些字段还牵着 localStorage 与探测。
 */
export function useCcEventStream(dispatch: (action: CcAction) => void) {
  /** 已消化的最大序号 + 1。快照与实时事件的去重全靠它。 */
  const seqRef = useRef(0);
  /** 快照与补漏都吃完了。这之前实时事件只进缓冲，不进 reducer。 */
  const [ready, setReady] = useState(false);
  /** 上次进程留下的会话（`cc_restore` 的返回）。`null` = 这次是全新开始。 */
  const [restored, setRestored] = useState<CcRestore | null>(null);
  /** 打开一条历史后要清掉它：当前会话已经就是那条历史了，再弹恢复提示纯属噪音。 */
  const clearRestored = useCallback(() => setRestored(null), []);

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
        // 只有「这个进程一个事件都还没产生」才去读落盘的会话。
        // 切页回来 / 前端热重载时 ring 里就是当前会话，它一定不比库里的旧 ——
        // 混用会让界面闪回上一次运行的内容。
        let fromDb: CcRestore | null = null;
        if (snap.nextSeq === 0) {
          try {
            fromDb = await invoke<CcRestore | null>("cc_restore");
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
      unlisten?.();
    };
  }, [dispatch]);

  return { ready, restored, clearRestored, seqRef };
}
