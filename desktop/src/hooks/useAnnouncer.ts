import { useEffect, useRef, useState } from "react";
import { initialAnnounceState, nextAnnouncement, type Announcement } from "../lib/ccAnnounce";
import type { CcView } from "../lib/ccReducer";

/**
 * 把 `lib/ccAnnounce` 的纯计算接到 React 上：只负责「什么时候算」。
 *
 * 🔴 依赖刻意只放**标量**（运行态 / 消息条数 / 尾消息状态签名 / 待批准数）。
 *    把 `view` 或 `messages` 放进依赖，等于让流式期间每个碎片都算一遍播报；
 *    而播报要的只是「有没有新东西值得说一句」。
 *
 * 返回最近一条播报（`null` = 还没说过话）。同一份状态重复计算不会再产出播报，
 * 去重账本在 `stateRef` 里。
 */
export function useAnnouncer(view: CcView, pending: number): Announcement | null {
  const [said, setSaid] = useState<Announcement | null>(null);
  const stateRef = useRef(initialAnnounceState(view.running));

  // 最近一次渲染的 view：下面的 effect 要读整条消息列表，但消息列表不能进依赖
  // （流式期间引用每 tick 都变）。这个 effect 无依赖数组 ⇒ 每次提交都会先更新它，
  // 且声明在前 ⇒ 播报 effect 拿到的永远是本次渲染的 view。
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });

  const count = view.messages.length;
  const tail = count > 0 ? view.messages[count - 1] : null;
  // 尾消息的「状态签名」：工具结果落地时消息条数不变，只有它变。
  const tailSig =
    tail === null
      ? ""
      : tail.kind === "tool"
        ? `${tail.id}:${tail.tool.status}:${tail.tool.isError ? 1 : 0}:${tail.tool.canceled ? 1 : 0}`
        : `${tail.kind}:${tail.id}`;

  useEffect(() => {
    const { state, say } = nextAnnouncement(stateRef.current, viewRef.current, pending, Date.now());
    stateRef.current = state;
    if (say) setSaid(say);
  }, [view.running, count, tailSig, pending]);

  return said;
}
