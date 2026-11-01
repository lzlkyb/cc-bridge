import { useEffect, useRef, type RefObject } from "react";
import { MOTION } from "../lib/motion";
import type { useCcConvSearch } from "./useCcConvSearch";

/**
 * 把会话内搜索接到浏览器上：唤起、命中滚进视口、以及「命中在渲染窗口外」时的扩窗。
 *
 * 从 `ConversationStream` 拆出（2026-11）。那个组件本来只有「结构 + 布局」，
 * 这三段是纯副作用（`window` 监听、`scrollIntoView`、rAF），留着会把它顶过体量门限，
 * 也不该跟布局混在一起读。
 *
 * 🔴 两个「不跟着走」的讲究，改之前先看：
 *    1. 唤起只让**可见** pane 响应。多 pane 各挂一个 window 监听，隐藏 pane 是
 *       `display:none`（`offsetParent` 为 null），拿它当可见性判据，不用为此
 *       再往 `CcPane` 穿一条 props。
 *    2. 滚动只在「查询词 / 当前命中序号」变化时做，**不跟着 `hits` 引用走**：
 *       流式期间 `hits` 每个 tick 都重算，跟着它滚会把正在翻阅的视口反复拉回命中处。
 */
export function useCcFindReveal({
  scrollRef,
  findRequest,
  search,
  expandAll,
}: {
  scrollRef: RefObject<HTMLDivElement>;
  /** 外部请求唤起搜索的计数器（顶栏的「查找」按钮、快捷键）。 */
  findRequest: number;
  search: ReturnType<typeof useCcConvSearch>;
  /** 把渲染窗口放到全量；返回是否真的扩了（见 `hooks/useMessageWindow`）。 */
  expandAll: () => boolean;
}): void {
  const { hits, occ, openSearch, query } = search;

  useEffect(() => {
    if (findRequest > 0) openSearch();
  }, [findRequest, openSearch]);

  const scrolledKeyRef = useRef("");
  useEffect(() => {
    if (hits.length === 0) {
      scrolledKeyRef.current = "";
      return;
    }
    const key = `${query}\u0000${occ}`;
    if (scrolledKeyRef.current === key) return;
    scrolledKeyRef.current = key;
    const reveal = (retried = false) => {
      const root = scrollRef.current;
      if (!root) return;
      root.dispatchEvent(new Event("cc-reading-jump"));
      const hit = root.querySelector("[data-cc-hit-cur]");
      if (hit) {
        hit.scrollIntoView({ block: "nearest" });
        return;
      }
      // 命中在渲染窗口外（P0-5）：索引仍覆盖全量，所以命中一定存在，只是这一帧还没画。
      // 先把窗口放到全量，下一帧再定位。`retried` 防住「本来就全量却找不到」时的死循环 ——
      // 那种情况交给下面 settled 那次兜底。
      if (!retried && expandAll()) {
        requestAnimationFrame(() => reveal(true));
      }
    };
    reveal();
    // 搜索可能展开一个带入场动画的执行分组，等高度落定再对齐一次。
    const settled = window.setTimeout(reveal, MOTION.enter + 20);
    return () => window.clearTimeout(settled);
  }, [scrollRef, hits, occ, query, expandAll]);
}
