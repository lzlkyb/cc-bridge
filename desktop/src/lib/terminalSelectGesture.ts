import type { Terminal } from "@xterm/xterm";
import { isMac } from "./platform";
import { mouseTrackingActive } from "./terminalMouse";

/**
 * 终端「强制起选区」：鼠标跟踪开着时，让 xterm 在指定坐标起一次**本地**选区。
 *
 * ## 为什么需要它
 *
 * 远端程序开着鼠标追踪时，xterm 会把 `SelectionService` 整体 **disable**
 * （`CoreBrowserTerminal.bindMouse` 的 `onProtocolChange`：`events` 为真 →
 * `this._selectionService.disable()`），于是 mousedown 连本地选区都起不来。
 *
 * 但 `SelectionService.handleMouseDown` 里留了一条窄路（源码 462-470 行）：
 *
 * ```ts
 * // Allow selection when using a specific modifier key, even when disabled
 * if (!this._enabled) {
 *   if (!this.shouldForceSelection(event)) return;
 *   event.stopPropagation(); // Don't send the mouse down event to the current process
 * }
 * ```
 *
 * 而 `shouldForceSelection`（437-443 行）= 非 macOS 看 `shiftKey`、macOS 看
 * `altKey && options.macOptionClickForcesSelection`。**所以「带强制修饰键的 mousedown」
 * 能在完全不改协议状态的前提下起本地选区**，并且 xterm 自己会把它挡在远端之外
 * （`CoreBrowserTerminal` 的 mousedown 处理里 `shouldForceSelection` 为真时直接 return，
 * 不发鼠标报告）。
 *
 * 这正是 2026-10-16 第五轮换掉「关本地鼠标报告再恢复」老方案的原因——那条路要改协议状态，
 * 恢复失败就把滚轮永久打成 dead 态（详见 lib/terminalInputHold.ts 头注）。
 *
 * ## 为什么要合成事件而不是直接放行真实事件
 *
 * 裸拖选（不按 Shift）时真实 mousedown 上没有修饰键，走的不是这条窄路；而在
 * 4px 阈值处补发一枚**带强制修饰键**的合成 mousedown，就能在不改协议状态的前提下
 * 起选区（真实后续的 mousemove/mouseup 会驱动它延伸/提交——`_addMouseDownListeners`
 * 挂的是 document 级监听，不关心修饰键）。
 */

/** 合成事件标记：本模块自己的容器级监听据此跳过，避免二次进入手势状态。 */
const SYNTH_FLAG = "__ccbSynthMouse";

export function markSynthMouse(e: MouseEvent): void {
  (e as MouseEvent & Record<string, unknown>)[SYNTH_FLAG] = true;
}

export function isSynthMouse(e: Event): boolean {
  return Boolean((e as Event & Record<string, unknown>)[SYNTH_FLAG]);
}

/** macOS 的强制选择判据是 Option+click，且要先打开这个选项（xterm 官方语义：鼠标模式下强制本地选择）。 */
function macForceSelection(term: Terminal): boolean {
  if (!isMac(typeof navigator === "undefined" ? undefined : navigator.platform)) return false;
  if (!term.options.macOptionClickForcesSelection) term.options.macOptionClickForcesSelection = true;
  return true;
}

/**
 * 在 (x,y) 处起一次本地选区。鼠标跟踪没开时**什么都不做**——那是普通 shell，
 * xterm 原生拖选本来就能用，凭空补一枚 mousedown 只会多一次无谓的点击语义。
 */
export function forceSelectAt(term: Terminal, x: number, y: number): void {
  if (!mouseTrackingActive(term)) return;
  const mac = macForceSelection(term);
  const target = (term.element?.querySelector(".xterm-screen") ?? term.element) as HTMLElement | null;
  if (!target) return;
  const ev = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    detail: 1,
    shiftKey: !mac,
    altKey: mac,
  });
  markSynthMouse(ev);
  target.dispatchEvent(ev);
}

/**
 * 补一枚**合成 mouseup**，给远端收尾「已经泄漏出去的那次按下」。
 *
 * WHY（2026-10-16 第六轮）：裸拖选的前 4px 里输入闸还没闭，真实 mousedown 已被 xterm
 * 编码成 SGR 报告发给远端（xterm 的 mousedown 处理只在 `shouldForceSelection` 为真时才
 * 拦下不发）。等我们闭闸，远端已经处于「用户按着左键」；后续 drag/up 报告全被闸拦掉，
 * 它**永远等不到抬起**，于是按自己的理解做出反应——实测 Claude Code 会把滚轮归属打回
 * 非转发态，终端整片滚不动。这里补一枚 mouseup 把这次点击收尾：远端看到的是
 * 「按下 + 抬起（无移动）」= 一次干净点击，不残留按下态。
 *
 * 🔴 必须在**闭闸之前**调用：xterm 的鼠标报告走 `CoreService.triggerDataEvent`，而它第一行
 * 就是 `if (disableStdin) return`。
 * 🔴 副作用（可接受，顺序有讲究）：这枚报告以 `wasUserInput=true` 进入 xterm，会触发
 * `onUserInput` → `SelectionService.clearSelection()`。所以调用方必须「先补发、后
 * forceSelectAt」，否则会把刚起的选区清掉。
 * 没有按下报告可收尾时（起手就带 Shift / 开着选择模式）dispatch 是无害空转。
 */
export function replayMouseUp(term: Terminal, x: number, y: number): void {
  const target = (term.element?.querySelector(".xterm-screen") ?? term.element) as HTMLElement | null;
  if (!target) return;
  const ev = new MouseEvent("mouseup", {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0,
    detail: 1,
  });
  markSynthMouse(ev);
  target.dispatchEvent(ev);
}
