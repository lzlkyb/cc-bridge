import type { CcMessage } from "../../lib/ccGuiTypes";
import type { CcRetryInfo } from "../../lib/ccEventTypes";
import { useNowTick } from "../../hooks/useNowTick";
import { MessageNav } from "./MessageNav";
import { ScrollToBottom } from "./ScrollToBottom";
import { activityLine } from "./TurnActivity";

/**
 * 消息流底部那条浮条：「按轮导航」+「回到底部 / 本轮状态」。
 *
 * 拆成独立组件（2026-11）有两个理由：
 * 1. 它需要的「现在」每秒变一次 —— 留在 `ConversationStream` 里会让整个消息流
 *    跟着每秒 reconcile；收进来之后 tick 只重渲染这一条浮条。
 * 2. 停滞提示（「N 秒无新记录」）只有这里有位置放：原子组件 `<TurnActivity>`
 *    从未被挂载过，而它想给的信息正好是这条浮条的文案。
 *
 * 定位由父级负责（`absolute inset-x-0 bottom-2`）：它必须相对**滚动区**定位，
 * 而不是相对整个 pane —— 否则会浮到 Clawd dock 身上。
 */
export function StreamHud({
  messages,
  startIndex,
  resolved,
  running,
  sending,
  retry,
  stopState,
  pending,
  onPrev,
  onNext,
  onBottom,
}: {
  messages: CcMessage[];
  startIndex?: number;
  resolved: Record<string, unknown>;
  running: boolean;
  sending: boolean;
  retry: CcRetryInfo | null;
  stopState: "stopping" | "unconfirmed" | null;
  /** 待裁决条数（已按 Clawd 姿态过滤：审批/提问在场时浮条已高亮，不再重复计数）。 */
  pending: number;
  onPrev: () => void;
  onNext: () => void;
  onBottom: () => void;
}) {
  const stopping = stopState === "stopping";
  // 停止中也要走秒：正在杀进程的那几秒同样是最难熬的静默。
  const now = useNowTick(running || stopping);
  const activity = stopping
    ? "正在停止本轮"
    : retry
      ? `正在重试 ${retry.attempt}/${retry.max}`
      : activityLine(messages, running, sending, startIndex, resolved, now);
  return (
    <>
      <MessageNav onPrev={onPrev} onNext={onNext} />
      <ScrollToBottom pending={pending} running={running || stopping} activity={activity} onClick={onBottom} />
    </>
  );
}
