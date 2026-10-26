import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * 距底多远算「离开了底部」。
 *
 * 比 `useCcStreamScroll` 的贴底判据（32px）宽松：贴底判据要尽量灵敏地「脱钉」，
 * 这里是决定要不要弹按钮，读到底部附近时按钮不该一闪一闪。
 */
const AWAY_GAP = 120;

/**
 * 对话流「是否离开了底部」。给「回到底部」按钮用。
 *
 * 为什么需要它：用户上滚回看后会脱钉，之后流式输出与新弹出的审批卡都不会进入视野。
 * 审批卡有 60s 超时（到点自动拒绝），弹在视口外又没有任何提示，等于悄悄让任务失败。
 *
 * 只读滚动节点，不改滚动行为（贴底逻辑仍在 `useCcStreamScroll`）。隐藏的 pane
 * （`display:none`）三个量都是 0，算出来是「没离开」，不会误弹。
 */
export function useCcScrollAway(scrollRef: RefObject<HTMLDivElement>) {
  const [away, setAway] = useState(false);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      const next = node.scrollHeight - node.scrollTop - node.clientHeight > AWAY_GAP;
      setAway((prev) => (prev === next ? prev : next));
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => node.removeEventListener("scroll", onScroll);
  }, [scrollRef]);

  const toBottom = useCallback(() => {
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [scrollRef]);

  return { away, toBottom };
}
