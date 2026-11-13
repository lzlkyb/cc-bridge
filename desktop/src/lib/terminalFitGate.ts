import type { Terminal } from "@xterm/xterm";

/**
 * 终端**尺寸适配闸**：选择手势进行中挂起 fit，手势结束后补跑一次。
 *
 * ## 为什么必须挂起（2026-11-13 报障：拖选时终端抖动 / 选区选不出来）
 *
 * `FitAddon.fit()` 会调 `term.resize()`，而 xterm 对 resize 的硬行为是
 * `onResize(e => e.rowsChanged && this.clearSelection())`——**行数一变，正在拖的选区
 * 无条件作废**；列数变了虽不清空，但 buffer 要 reflow，选区坐标整体挪位。
 * 手势期间只要撞上一次 fit，用户看到的就是「拖到一半选区断开 / 松手复制到别的段」。
 *
 * 而 fit 的触发源里至少有一条和手势同步发生：`dragSelecting` 状态会让窗格工具栏多出
 * 一枚徽标（React 重渲染），窗口/侧栏任何尺寸抖动又都会经 ResizeObserver 进
 * `scheduleFit`。手势期间把这些全挡在门外，是**结构性**保证——不依赖「猜哪条路径会
 * 触发 resize」，将来任何新触发源都自动被覆盖。
 *
 * ## 为什么是「记录下来补跑」而不是「直接丢掉」
 *
 * 丢掉会让终端停在错误的 cols（例如侧栏刚收起、过渡结束前就开始拖选）：整屏右侧或
 * 底部留一条空白，要等下一次尺寸变化才自愈。手势结束补跑一次，代价只是补跑时若行数
 * 真的变了，那一次选区会被清掉——而此时用户已经松手、文本已经进剪贴板了。
 *
 * ## 泄漏防护
 *
 * 与输入闸（`terminalInputHold`）**同一套释放点**：手势正常结束 / 指针取消 / 失焦 /
 * 卸载 / 滚轮自愈。任何一处漏掉都表现为「终端再也不重新 fit」，所以宁可多释放
 * （`releaseFit` 幂等），也不要在钩子里搞条件判断。
 */
const HELD = new WeakSet<Terminal>();
const PENDING = new WeakSet<Terminal>();
const RUNNER = new WeakMap<Terminal, () => void>();

/** 登记这个终端的 fit 入口（`useTerminalFit` 每次执行时登记，幂等且开销可忽略）。 */
export function registerFitRunner(term: Terminal, run: () => void): void {
  RUNNER.set(term, run);
}

/** 手势开始：挂起 fit。可重复调用（同一手势有多条起手路径）。 */
export function holdFit(term: Terminal): void {
  HELD.add(term);
}

/**
 * 闸闭合时把这次请求记成「待补跑」并返回 true，调用方应直接放弃本次 fit。
 * 闸开着一律返回 false（热路径，不做任何分配）。
 */
export function deferFitIfHeld(term: Terminal): boolean {
  if (!HELD.has(term)) return false;
  PENDING.add(term);
  return true;
}

/** 手势结束：开闸；期间若有被挂起的请求，补跑一次（幂等）。 */
export function releaseFit(term: Terminal): void {
  HELD.delete(term);
  if (!PENDING.delete(term)) return;
  RUNNER.get(term)?.();
}

/** 是否处于挂起态（供探针 / 单测断言，业务代码不需要它）。 */
export function isFitHeld(term: Terminal): boolean {
  return HELD.has(term);
}
