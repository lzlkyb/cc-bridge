import { useCallback, useState } from "react";
import { MESSAGE_WINDOW, windowStart } from "../lib/ccWindow";

/**
 * 长会话渲染窗口的 React 外壳（纯计算在 `lib/ccWindow.ts`）。
 *
 * 状态刻意放在**滚动容器的主人**（`ConversationStream`）身上：加载更早时要
 * 「记住旧 scrollHeight、在下一帧补 scrollTop」，只有拿着 `scrollRef` 的地方
 * 做得到。`MessageList` 只收 `start` 去 slice，不持有任何窗口状态。
 *
 * `sessionKey`：切会话（或切 pane 里的另一条记录）时把窗口复位成首屏大小。
 * 不复位的话，在一条 800 轮的会话里翻到全量、再切到另一条 800 轮的会话，
 * 新的那条会直接全量渲染 —— 用户没要求过。
 */
export function useMessageWindow(
  total: number,
  sessionKey: string,
): { start: number; loadEarlier: () => void; expandAll: () => boolean } {
  const [state, setState] = useState({ key: sessionKey, size: MESSAGE_WINDOW });
  // 会话变了就在**渲染期**复位（React 的 derive-state-from-props 写法）：
  // 用 effect 复位会先白渲染一帧旧窗口，长会话下那一帧就是卡顿本身。
  if (state.key !== sessionKey) setState({ key: sessionKey, size: MESSAGE_WINDOW });

  const size = state.key === sessionKey ? state.size : MESSAGE_WINDOW;
  const start = windowStart(total, size);

  const loadEarlier = useCallback(() => {
    setState((s) => ({ ...s, size: s.size + MESSAGE_WINDOW }));
  }, []);

  /**
   * 一次放到全量（搜索命中在窗口外时用）。返回**是否真的扩了** —— 调用方靠它
   * 判断要不要再定位一次，不然会在「本来就全量」时反复重试。
   */
  const expandAll = useCallback(() => {
    if (start === 0) return false;
    setState((s) => ({ ...s, size: total }));
    return true;
  }, [start, total]);

  return { start, loadEarlier, expandAll };
}
