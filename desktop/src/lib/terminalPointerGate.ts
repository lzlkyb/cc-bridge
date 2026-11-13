import type { Terminal } from "@xterm/xterm";
import {
  cancelPendingRelease,
  isSelectHold,
  releaseSelectHoldNow,
  releaseSelectHoldSoon,
  setSelectHold,
} from "./terminalInputHold";
import { beginDragSelection, beginSelection, markSynthMouse } from "./terminalSelectGesture";
import { releaseFit } from "./terminalFitGate";
import { mouseTrackingActive } from "./terminalMouse";

/**
 * 终端「按下即闭闸」（A 方案）：把输入闸从 4px 阈值处提前到 pointerdown。
 *
 * ## 为什么必须提前（2026-11-13 报障：拖选时页面抖动 / 选不出文字）
 *
 * 老路径在**越过 4px 阈值**时才闭闸（见 `useSshTerminalSelect` 的 `onPointerMove`）。
 * 而 xterm 的鼠标报告是在 `mousedown` 处理里同步发出的
 * （`CoreBrowserTerminal.bindMouse`：`areMouseEventsActive && !shouldForceSelection(e)` →
 * `i(e)` 立刻编码成 SGR 发给远端）。于是从按下到越过 4px 的那一小段里：
 *
 * 1. **按下 / 移动报告真的发出去了**（探针计数 `reports: 3`）。Claude Code 开着 `?1003h`
 *    （ANY，任意移动），收到就做命中测试并重绘——画面在光标底下变化，用户看到的就是
 *    「一拖拽页面就抖」。
 * 2. 报告以 `wasUserInput = true` 进 `CoreService.triggerDataEvent`，它第一段就是
 *    `t && scrollOnUserInput && i.ybase !== i.ydisp && this.scrollToBottom()`。
 *    ⇒ **滚上去（不在底部）时按一下鼠标，视口会被弹回底部**，选区起点直接错 20 行。
 *    探针实测：ydisp 346 → 366。
 *
 * 这两条都发生在闸闭合**之前**，事后补 mouseup 只能收尾，救不回已经抖过的那一帧。
 *
 * ## 代价与补偿
 *
 * 按下就闭闸 ⇒ 远端收不到那次 mousedown ⇒ **普通点击会丢**。所以松手时若没有形成选择
 * 手势，补发一次完整点击（`finishPlainClick` → `replayClick`：同点 mousedown + mouseup，
 * 闸已开，报告正常外发）。远端看到的就是原本那一次点击，只晚了约一帧。
 *
 * 闭闸条件里带着 `dragSelect`：关掉「拖拽即选」的用户要的是 TUI 原生拖拽（vim 里拖选、
 * htop 里拖滚动条），那种拖拽必须原样发给远端，不能拦——按钮的整条序列都不许拦。
 */

/** 本次按下是否已由我们在 pointerdown 处闭闸（⇒ 那枚 mousedown 没发给远端）。 */
const DOWN_HELD = new WeakSet<Terminal>();

/**
 * 本次按下已被别的守卫**接管**（双击取单元格会 `stopImmediatePropagation` 掉那次 mousedown）。
 *
 * 接管的语义是「这一按已经被本地消费掉、远端本来就不该看到它」，于是松手时不能补
 * 重放点击：那枚合成 mousedown 会让 xterm fire `onUserInput` → `clearSelection()`，
 * 把刚选好的单元格直接清掉（用户看到的是「双击闪一下又没了」）。
 */
const DOWN_CONSUMED = new WeakSet<Terminal>();

/** 只取重放要用的修饰键：shift 有意不收（见 replayClick）。 */
interface ClickMods {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * pointerdown 处提前闭闸。返回是否真的闭了闸。
 *
 * 只有「这一按**可能**变成选择手势」时才闭：Shift / Alt（列选）/ 选择模式 / 开着拖拽即选。
 * 否则让原生行为完整走完（TUI 原生拖拽、右键菜单都不受影响）。
 */
export function holdInputAtDown(
  term: Terminal,
  e: ClickMods,
  selectMode: boolean,
  dragSelect: boolean,
): boolean {
  // 没有鼠标追踪 = 远端不消费报告，闸闭了只会干扰键鼠，没有收益。
  if (!mouseTrackingActive(term)) return false;
  if (!(e.shiftKey || e.altKey || selectMode || dragSelect)) return false;
  // 上一手势的延时开闸还没跑：先撤掉，否则它会在本次手势中途把闸打开。
  cancelPendingRelease(term);
  setSelectHold(term, true);
  DOWN_HELD.add(term);
  return true;
}

/**
 * 重放一次完整点击（mousedown + mouseup，同一坐标）。
 *
 * 必须连着发两枚：xterm 只在 mousedown 里登记 document 级 mouseup 监听
 * （`bindMouse` 的 `s.mouseup`），单发 mouseup 远端收不到抬起，会以为按键还按着。
 *
 * `shiftKey` 有意固定为 false：真按下时带 Shift 会走「强制选择」窄路（远端本来就没收到
 * 那枚按下），重放时再带上会被 xterm 自己吃掉，远端连点击都收不到。
 */
export function replayClick(term: Terminal, x: number, y: number, e: ClickMods): void {
  const target = (term.element?.querySelector(".xterm-screen") ?? term.element) as HTMLElement | null;
  if (!target) return;
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    detail: 1,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  };
  for (const type of ["mousedown", "mouseup"] as const) {
    const ev = new MouseEvent(type, { ...base, buttons: type === "mousedown" ? 1 : 0 });
    markSynthMouse(ev); // 不回头触发我们自己的容器级手势
    target.dispatchEvent(ev);
  }
}

/**
 * 松手收尾（未形成选择手势的那一支）：把「按下的报告没发出去」补成一次完整点击。
 *
 * 开闸必须**延后一拍**（`releaseSelectHoldSoon`）：紧随 pointerup 的真实 mouseup 报告
 * 仍要被闸拦下（否则远端先收到一次抬起、再收到我们的重放点击，等于两次点击）。
 * 重放挂在同一个定时器的 `after` 里，天然排在开闸之后、且被新一次按下撤销时一起作废。
 */
export function finishPlainClick(term: Terminal, x: number, y: number, e: ClickMods): void {
  const consumed = DOWN_CONSUMED.delete(term);
  if (!DOWN_HELD.delete(term)) {
    // 没闭过闸：保持 2026-10-16 的兜底自愈（异常路径上闸可能没开，键盘会一直哑）。
    if (isSelectHold(term)) releaseSelectHoldNow(term);
    return;
  }
  if (consumed) {
    // 这一按被本地守卫接管了（双击取单元格等）：只开闸，不重放——重放会把刚建的选区清掉。
    releaseSelectHoldSoon(term);
    return;
  }
  releaseSelectHoldSoon(term, () => replayClick(term, x, y, e));
}

/**
 * 标记「本次按下已被别的守卫接管」，松手时不再补重放点击。
 * 由 `attachCellDoubleClick` 在真正接管那次 mousedown 时调用（见 DOWN_CONSUMED 注释）。
 */
export function markDownConsumed(term: Terminal): void {
  DOWN_CONSUMED.add(term);
}

/**
 * 越过阈值起选区：起手已闭闸（`DOWN_HELD`）时那枚按下**没漏给远端**，不必再补 mouseup。
 *
 * 补 mouseup 是给「已经泄漏出去的按下」收尾的（见 `beginDragSelection` 头注）；这里多补
 * 一枚，远端就收到一次没有对应按下的抬起，Claude Code 会当成点击，反而把刚起的选区
 * 判成"用户点了别处"。所以必须按「按下有没有发出去」分两条路，别图省事合成一条。
 */
export function beginDragFromDown(term: Terminal, x: number, y: number, column = false): void {
  if (DOWN_HELD.has(term)) {
    beginSelection(term, x, y, column);
    return;
  }
  beginDragSelection(term, x, y, column);
}

/**
 * 手势**正常**结束：延后一拍开输入闸（拦住紧随 pointerup 的 mouseup 报告），
 * 同一定时器里补跑手势期间挂起的 fit。
 *
 * 两件事共用一拍不是图省事：补跑的 fit 会 `term.resize()`，行数真变时 xterm 会
 * `clearSelection()`——必须等这次松手的复制、重绘都落定。挂在一起能保证顺序恒定。
 */
export function endPointerGesture(term: Terminal): void {
  DOWN_HELD.delete(term);
  DOWN_CONSUMED.delete(term);
  releaseSelectHoldSoon(term, () => releaseFit(term));
}

/** 手势**异常**结束（指针取消 / 失焦 / 卸载）：没有要保护的选区，两把闸立刻松开。 */
export function abortPointerGesture(term: Terminal): void {
  DOWN_HELD.delete(term);
  DOWN_CONSUMED.delete(term);
  releaseSelectHoldNow(term);
  releaseFit(term);
}
