/**
 * 长会话的渲染窗口。
 *
 * 为什么不是虚拟化：虚拟化要同时重做滚动锚点、会话内搜索的定位
 * （`querySelector("[data-cc-hit-cur]")` 只能命中真实存在的节点）以及
 * `data-cc-user` 的布局导航（`useCcMessageNav` 靠 `offsetTop` 找位置）。
 * 分页能拿到绝大部分收益，成本是虚拟化的三分之一。
 *
 * 🔴 窗口只影响**渲染**：搜索索引、导出、分叉切点都必须继续遍历全量 `messages`
 *    （见 `ccExport` / `ccFork` 的入参）。跟着窗口缩小 = 静默丢内容。
 *
 * 回退：把 `MESSAGE_WINDOW` 设成 `Infinity` 即回到「全量渲染」，一个常量搞定。
 */

/** 首屏渲染的消息条数（≈ 一个中等长度会话的四分之三）。 */
export const MESSAGE_WINDOW = 200;

/**
 * 窗口起点（全量数组下标）。`total` 条消息、窗口容量 `size` ⇒ 起点。
 *
 * 至少保留一条：`size` 传 0 或负数时不能切出空窗口 —— 界面会变成一片空白，
 * 而空白没有任何可解释的理由（用户没做任何操作）。
 */
export function windowStart(total: number, size: number): number {
  if (!Number.isFinite(size)) return 0;
  return Math.max(0, total - Math.max(1, Math.floor(size)));
}
