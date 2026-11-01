import { useCallback, useEffect, useRef, useState } from "react";
import type { CcImage } from "../lib/ccImage";

/** 待发队列里的一条。**图跟着文字一起排队**：分开存会让「排队的图」失去归属。 */
export type QueuedMessage = { id: string; text: string; images: CcImage[] };

/**
 * 待发队列（「运行中继续打字」的落点）。
 *
 * 两条 ref 与一份 state 并存：state 给界面显示条数，ref 给 `start` 与 flush
 * 读取最新值 —— `start` 是 `useCallback`，把 state 塞进依赖会让它每次
 * 渲染都换身份，而它是 `CcGuiTab` 探测 effect 的依赖，重订阅的代价白付。
 * 所以这里对外暴露的操作函数都是稳定引用。
 *
 * `paused`：暂停自动冲刷。两种情况会置上：
 *  1. 队首那条发送失败 —— 不暂停的话：失败 ⇒ `running` 回 false ⇒ flush 立刻发下一条，
 *     在 CLI 没装 / 模型名不对这类「每条都会失败」的情形下把整队消息逐条发错、逐条丢掉；
 *  2. 用户点了中断 —— 队列**不丢**（中断是「停这一轮」，不是「把我想好的下一句也扔掉」），
 *     但也不能放任自动冲刷，否则「中断」会变成「跳过这一轮、马上开始下一轮」。
 *
 * 恢复条件：用户点「继续」/ 清空队列，或者下一条消息真的发出去了（说明故障已排除）。
 */
export function useCcSendQueue() {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef<QueuedMessage[]>([]);
  const nextId = useRef(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  const enqueue = useCallback((m: Omit<QueuedMessage, "id">) => {
    queueRef.current = [...queueRef.current, { ...m, id: `queued-${++nextId.current}` }];
    setQueue(queueRef.current);
  }, []);
  /** 清空队列，同时解除暂停。 */
  const clear = useCallback(() => {
    queueRef.current = [];
    setQueue(queueRef.current);
    pausedRef.current = false;
    setPaused(false);
  }, []);
  const resume = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
  }, []);
  /** 暂停自动冲刷（中断用）。队列原样保留。 */
  const pause = useCallback(() => {
    pausedRef.current = true;
    setPaused(true);
  }, []);
  const hasPausedItems = useCallback(() => pausedRef.current && queueRef.current.length > 0, []);
  // Edit by identity: an automatic dequeue must not redirect a pending edit to the next message.
  const edit = useCallback((id: string, text: string): boolean => {
    const item = queueRef.current.find((m) => m.id === id);
    const trimmed = text.trim();
    if (!item || (!trimmed && item.images.length === 0)) return false;
    queueRef.current = queueRef.current.map((m) => m.id === id ? { ...m, text: trimmed } : m);
    setQueue(queueRef.current);
    return true;
  }, []);
  const remove = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((m) => m.id !== id);
    setQueue(queueRef.current);
  }, []);
  const move = useCallback((id: string, direction: -1 | 1) => {
    const index = queueRef.current.findIndex(item => item.id === id), next = index + direction;
    if (index < 0 || next < 0 || next >= queueRef.current.length) return;
    const items = [...queueRef.current]; [items[index], items[next]] = [items[next], items[index]];
    queueRef.current = items; setQueue(items);
  }, []);
  /** 取走队首（出队）。队空返回 `undefined`，不动状态。 */
  const take = useCallback((): QueuedMessage | undefined => {
    const next = queueRef.current[0];
    if (next === undefined) return undefined;
    queueRef.current = queueRef.current.slice(1);
    setQueue(queueRef.current);
    return next;
  }, []);
  /** 队首发送失败：放回队首并暂停自动发送，草稿不丢。 */
  const putBack = useCallback((m: QueuedMessage) => {
    queueRef.current = [m, ...queueRef.current];
    setQueue(queueRef.current);
    pausedRef.current = true;
    setPaused(true);
  }, []);

  return { queue, paused, enqueue, clear, resume, pause, take, putBack, edit, remove, move, hasPausedItems };
}

/**
 * 本轮一结束就把队首发出去。
 *
 * 判据是 `running` 由 true 转 false：那是 `TurnEnd` / `Exit` 落定的时刻，也是后端
 * `turn_active` 被清掉的时刻 —— 两个条件必须同时满足，而它们恰好在同一个事件里
 * 发生（`bookkeep` 先清 busy 再推事件）。
 *
 * `ready` 之前不动：重放历史时 running 也会从 true 翻到 false，那时队列必然是空的，
 * 但把这道闸加上更直白。
 */
export function useCcQueueFlush(
  q: Pick<ReturnType<typeof useCcSendQueue>, "paused" | "take" | "putBack" | "pause">,
  deps: {
    ready: boolean;
    running: boolean;
    busy: boolean;
    failed?: boolean;
    start: (text: string, images: CcImage[]) => Promise<boolean>;
  },
) {
  const { paused, take, putBack, pause } = q;
  const { ready, running, busy, start, failed } = deps;
  const failureSeen = useRef(false);
  useEffect(() => {
    // A lost connection must not silently launch the next task before the user reviews uncertain inputs.
    if (failed && !failureSeen.current) { failureSeen.current = true; pause(); return; }
    if (!failed) failureSeen.current = false;
    if (!ready || running || busy || paused) return;
    const next = take();
    if (next === undefined) return;
    void start(next.text, next.images).then((ok) => {
      // 发失败（错误横幅 `start` 已经报了）：放回队首并暂停，草稿不丢。
      if (!ok) putBack(next);
    });
  }, [ready, running, busy, paused, take, putBack, start, failed, pause]);
}
