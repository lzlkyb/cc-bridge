import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { CcMessage } from "../lib/ccGuiTypes";

/** 高亮持续多久（与设置页深链的 `anchor-highlight` 同一档）。 */
const HIGHLIGHT_MS = 2000;
/** 距底多近仍算「贴着底」。再大就开始把普通阅读位置误判成贴底，再小滚轮一格就脱钉。 */
const STICK_GAP = 32;

/**
 * 对话流的两个滚动行为：**贴底**与**跳到某条工具卡**。
 *
 * 它们必须共用同一个滚动节点（pane 持有的 `scrollRef`），所以放同一个 hook：
 * - 贴底是「有新内容就滚到底」—— 但只在用户**本来就在底部附近**时才追：
 *   生成期间上滚回看是最常见的动作，每个流式碎片都把人拽回底部等于不许阅读。
 *   脱钉/回钉全由滚动位置决定，`jumpTo` 的锚点滚动也走同一条路（跳到半中间的
 *   ToolCard 自然脱钉，正是想要的）。
 * - 跳转来自变更集面板（点击「本轮改了哪些文件」里的条目）。
 *
 * 2026-10-25 从 `CcPane` 拆出（3-3 之后 pane 又顶到体量门限）：两块都是对同一个
 * DOM 节点的操作，与消息渲染无关，搬到这里之后 pane 只剩接线。
 *
 * `active`（本 pane 是否可见）必须参与：隐藏用 `display:none`，浏览器会把
 * `scrollTop` 归零 —— 切回来时贴底的要补一次贴底，没贴底的要还原到离开时的位置
 * （位置在可见期间的 scroll 事件里持续记录，隐藏期间的归零不记）。
 */
export function useCcStreamScroll(
  scrollRef: RefObject<HTMLDivElement>,
  deps: { active: boolean; messages: CcMessage[]; resolved: unknown },
) {
  /** 用户是否贴在底部。 */
  const pinnedRef = useRef(true);
  /** 最后一次**可见时**的滚动位置。 */
  const lastTopRef = useRef(0);
  const readingUntilRef = useRef(0);
  const activeRef = useRef(deps.active);
  activeRef.current = deps.active;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    let height = node.clientHeight;
    let contentHeight = node.scrollHeight;
    const rememberSize = () => { height = node.clientHeight; contentHeight = node.scrollHeight; };
    const readingJump = () => {
      pinnedRef.current = false;
      // Disclosure transitions can resize the transcript after a deliberate jump.
      // Keep that resize from reclaiming the user's reading position.
      readingUntilRef.current = Date.now() + 700;
    };
    const onScroll = () => {
      // 隐藏期间浏览器可能把 scrollTop 归零，那不是用户的滚动，别记。
      if (!activeRef.current) return;
      if (Date.now() < readingUntilRef.current) {
        pinnedRef.current = false; lastTopRef.current = node.scrollTop; rememberSize(); return;
      }
      const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
      const resized = height !== node.clientHeight || contentHeight !== node.scrollHeight;
      // 队列展开会缩短视口，浏览器也会发 scroll；它不代表用户上翻。
      // 真正离开底部时 scrollTop 会减小，仍立即停止追随。
      if (pinnedRef.current && resized && node.scrollTop >= lastTopRef.current) node.scrollTop = node.scrollHeight;
      else pinnedRef.current = gap <= STICK_GAP;
      lastTopRef.current = node.scrollTop;
      rememberSize();
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("cc-reading-jump", readingJump);
    const observer = new ResizeObserver(() => {
      if (activeRef.current && pinnedRef.current) node.scrollTop = node.scrollHeight;
      rememberSize();
    });
    observer.observe(node);
    // 折叠过程、延迟排版也会改变正文高度，而滚动容器本身不一定变大。
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => { node.removeEventListener("scroll", onScroll); node.removeEventListener("cc-reading-jump", readingJump); observer.disconnect(); };
  }, [scrollRef]);

  // 新内容贴底：只有「可见 && 贴着底」才追。隐藏 pane 上 scrollHeight 是 0，写了也无意义。
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !deps.active || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [scrollRef, deps.active, deps.messages, deps.resolved]);

  // 切回 pane 的那一次：贴底的回底，没贴底的还原离开时的位置。
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !deps.active) return;
    node.scrollTop = pinnedRef.current ? node.scrollHeight : lastTopRef.current;
  }, [scrollRef, deps.active]);

  /**
   * 跳到流里第一处 diff：锚点是 ToolCard 根节点的 data-cc-tool。高亮复用设置页
   * 深链的 anchor-highlight（主题色脉冲 2s），不新造一套动效。
   */
  return useCallback(
    (messageId: string) => {
      const node = scrollRef.current?.querySelector<HTMLElement>(
        `[data-cc-tool="${CSS.escape(messageId)}"]`,
      );
      if (!node) return;
      scrollRef.current?.dispatchEvent(new Event("cc-reading-jump"));
      let detail = node.closest("details");
      while (detail) { detail.open = true; detail = detail.parentElement?.closest("details") ?? null; }
      node.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      node.classList.add("anchor-highlight");
      window.setTimeout(() => node.classList.remove("anchor-highlight"), HIGHLIGHT_MS);
    },
    [scrollRef],
  );
}
