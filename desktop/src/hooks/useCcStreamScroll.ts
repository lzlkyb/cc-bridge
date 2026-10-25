import { useCallback, useEffect, type RefObject } from "react";
import type { CcMessage } from "../lib/ccGuiTypes";

/** 高亮持续多久（与设置页深链的 `anchor-highlight` 同一档）。 */
const HIGHLIGHT_MS = 2000;

/**
 * 对话流的两个滚动行为：**贴底**与**跳到某条工具卡**。
 *
 * 它们必须共用同一个滚动节点（pane 持有的 `scrollRef`），所以放同一个 hook：
 * - 贴底是「有新内容就滚到底」—— 长任务的流式输出全靠它，不然用户得一直追着滚；
 * - 跳转来自变更集面板（点击「本轮改了哪些文件」里的条目）。
 *
 * 2026-10-25 从 `CcPane` 拆出（3-3 之后 pane 又顶到体量门限）：两块都是对同一个
 * DOM 节点的操作，与消息渲染无关，搬到这里之后 pane 只剩接线。
 */
export function useCcStreamScroll(
  scrollRef: RefObject<HTMLDivElement>,
  deps: { messages: CcMessage[]; resolved: unknown },
) {
  // 新内容贴底。ref 稳定，不进依赖。
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [scrollRef, deps.messages, deps.resolved]);

  /**
   * 跳到流里第一处 diff：锚点是 ToolCard 根节点的 `data-cc-tool`。高亮复用设置页
   * 深链的 `anchor-highlight`（主题色脉冲 2s），不新造一套动效。
   */
  return useCallback(
    (messageId: string) => {
      const node = scrollRef.current?.querySelector<HTMLElement>(
        `[data-cc-tool="${CSS.escape(messageId)}"]`,
      );
      if (!node) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("anchor-highlight");
      window.setTimeout(() => node.classList.remove("anchor-highlight"), HIGHLIGHT_MS);
    },
    [scrollRef],
  );
}
