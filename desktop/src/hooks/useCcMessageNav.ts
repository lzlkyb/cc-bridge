import { useCallback, type RefObject } from "react";

/**
 * 在「我的提问」之间跳。
 *
 * ## 为什么不复用 Ctrl+F
 *
 * 搜索找的是**字**，导航找的是**轮**（「我记得第三轮问过这个」）。几十轮的会话里
 * 靠滚轮回到某个提问要滑很久，而且滑的过程中很容易超过。
 *
 * ## 为什么读布局而不是从 state 算下标
 *
 * 消息的最终位置由布局决定：搜索把命中的那条滚进视口、工具卡展开/收起改变高度、
 * 图片缩放改变高度。只有 `getBoundingClientRect` 能回答「用户此刻看到哪儿」。
 * 锚点 `[data-cc-user]` 由 `MessageList` 挂在用户气泡上。
 *
 * ## 边界的处理
 *
 * 到头了就不动（不弹 toast、不禁用）：一次点击无反应比「撞墙提示」安静，
 * 而用户立刻能看出已经到最上面那条了。
 *
 * ## ⚠️ 已知不精确的地方（未在真窗口验证）
 *
 * `.cc-msgcol > *` 是 `content-visibility: auto` + `contain-intrinsic-size: auto 80px`：
 * 从没进过视口的元素按 80px 占位。刚打开一条长历史（直接跳到底，中间没滚过）时，
 * 上方那些消息的高度就是占位值 ⇒ 这里算出来的位置是近似的，「上一条」可能少跳
 * 或跳过一条。用户手动滚过之后（每个都渲染过一次）就准了。
 *
 * 要彻底解决得在跳之前逼一次全量布局（临时关掉 content-visibility），代价是长会话
 * 每次点击都卡一帧。**目前在真窗口里没条件验证到底多严重，所以先不动**，
 * 只把这个前提记下来 —— 下次有人反馈「跳的位置不对」，先看这条。
 */
export function useCcMessageNav(scrollRef: RefObject<HTMLDivElement>): {
  prev: () => void;
  next: () => void;
} {
  const jump = useCallback(
    (dir: 1 | -1) => {
      const root = scrollRef.current;
      if (!root) return;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-cc-user]"));
      if (nodes.length === 0) return;
      const top = root.getBoundingClientRect().top;
      // 视口顶部**已经滚过去**的最后一条；-1 = 一条都还没滚过去。
      let cur = -1;
      nodes.forEach((n, i) => {
        if (n.getBoundingClientRect().top - top <= 8) cur = i;
      });
      const target = Math.min(nodes.length - 1, Math.max(0, cur + dir));
      nodes[target].scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [scrollRef],
  );

  return {
    prev: useCallback(() => jump(-1), [jump]),
    next: useCallback(() => jump(1), [jump]),
  };
}
