import type { Terminal } from "@xterm/xterm";

/**
 * 终端**输入闸**：选择手势期间旁路一切「本端 → 远端」的数据（键盘、鼠标报告、方向键兜底）。
 *
 * ## 为什么是它，而不是「关掉本地鼠标报告」（2026-10-16 第三轮报障后换的方案）
 *
 * 老方案在拖选时往本地 xterm 写 `?1003l` 关鼠标报告，松手再写 `?1003h` 恢复。它有两个
 * 结构性缺陷，前四轮补丁（捕获阶段监听 / 快照兜底 / 滚轮自愈 / 自持 SGR 转发）都在同一
 * 个模型里加冗余，所以一直修不干净：
 *
 * 1. 🔴 **恢复失败 = 滚轮永久归外层**。xterm 的 wheel 转发监听器是**由协议状态驱动装卸**的
 *    （CoreBrowserTerminal.bindMouse 里 `onProtocolChange` 决定挂不挂 `requestedEvents.wheel`）。
 *    协议一旦停在关，备用屏又没有 scrollback，事件就落进源码 806-842 行的兜底分支：
 *    `deltaY === 0` 直接 `return false`（不 cancel、不 preventDefault）→ 一路冒泡滚外层页面；
 *    否则改写成 ↑/↓ 发给远端（Claude Code 当输入框历史导航）。而「恢复」要穿过
 *    `term.write` 的异步解析队列 + 信念/快照两套易失依据，任何一环失手就永久卡死。
 * 2. 写 `?1003l` 还会让 xterm 摘掉 `enable-mouse-events` class → 滚动条/归属徽章在拖选期间
 *    翻成「死滚轮」，用户看到的是状态自己乱跳。
 *
 * 本方案换成 `term.options.disableStdin`：它是 `CoreService.triggerDataEvent` /
 * `triggerBinaryEvent` 的**同步入口闸**（源码 61-66 / 84-91 行），鼠标报告
 * （`CoreMouseService.triggerMouseEvent` → `triggerDataEvent`）、方向键兜底、键盘输入
 * 全都要过它。置 true 即静默，置 false 即恢复，**全程不碰协议状态**——
 * 于是「滚轮归属」永远由远端自己的 DECSET 决定，死窗这一类故障在结构上消失了。
 *
 * ## 为什么不是调用方直接写 `term.options.disableStdin`
 *
 * 这个开关已被「会话断开」占用（断开时置 true 拦住输入）。两处各写一次就会互相覆盖，
 * 于是这里用**两个独立来源求或**：基础闸（会话层）+ 选择手势闸（交互层），
 * 谁都不需要知道对方的存在，也不存在「恢复成谁的值」的陈旧写入问题。
 */

/** 会话层基础闸：会话已断开 → 输入不该再发往远端。 */
const BASE_HOLD = new WeakMap<Terminal, boolean>();
/** 选择手势闸：拖选 / 选择模式 / Shift 选择期间置 true。 */
const SELECT_HOLD = new WeakMap<Terminal, boolean>();

function apply(term: Terminal): void {
  term.options.disableStdin = BASE_HOLD.get(term) === true || SELECT_HOLD.get(term) === true;
}

/** 会话层设置基础闸（`useSshTerminalSession` 按 `closed` 调用）。 */
export function setInputHoldBase(term: Terminal, on: boolean): void {
  BASE_HOLD.set(term, on);
  apply(term);
}

/** 选择手势闸开关。松手 / 失焦 / 卸载都必须松开，否则键盘输入会失灵。 */
export function setSelectHold(term: Terminal, on: boolean): void {
  SELECT_HOLD.set(term, on);
  apply(term);
}

/** 选择手势闸当前是否闭合——滚轮守卫用它做「异常路径漏松手」的兜底自检。 */
export function isSelectHold(term: Terminal): boolean {
  return SELECT_HOLD.get(term) === true;
}

/** 未决的延时松开定时器（每终端一个；同一 tick 内多次调用只保留最后一次）。 */
const PENDING_RELEASE = new WeakMap<Terminal, number>();

/**
 * 松开选择闸，但要**等本轮鼠标事件的后续阶段跑完**再松。
 *
 * WHY（2026-10-16 第六轮，用户报「松手瞬间选区自己消失」）：xterm 把鼠标报告当**用户输入**
 * 发（`CoreMouseService.triggerMouseEvent` → `CoreService.triggerDataEvent(report, true)`），
 * 而 `triggerDataEvent` 里 `wasUserInput` 为真会 fire `onUserInput`，挂在这个事件上的
 * `SelectionService` 监听（源码 138-143）会**直接 clearSelection()**。
 * 一次鼠标交互的事件序列是 pointerup → mouseup（同一事件循环任务内同步派发），
 * 在 pointerup 里立刻开闸，紧随其后的 mouseup 报告就会一路走到 clearSelection，
 * 用户看到的就是「松手即失去选区」。
 *
 * 用 0ms 定时器把开闸推到该任务之后：这枚 mouseup 仍被闸拦下（远端收不到、选区保住），
 * 下一次点击/滚动/输入照常。若期间又来一次按下，调用方应当先 `cancelPendingRelease`。
 */
export function releaseSelectHoldSoon(term: Terminal): void {
  cancelPendingRelease(term);
  const id = setTimeout(() => {
    PENDING_RELEASE.delete(term);
    setSelectHold(term, false);
  }, 0) as unknown as number;
  PENDING_RELEASE.set(term, id);
}

/** 撤销未决的延时松开（新一次按下必须在闭闸前调用，否则旧定时器会把新闸误开）。 */
export function cancelPendingRelease(term: Terminal): void {
  const id = PENDING_RELEASE.get(term);
  if (id === undefined) return;
  clearTimeout(id);
  PENDING_RELEASE.delete(term);
}

/** 立即松开（异常出口：指针取消 / 失焦 / 卸载——这些场景没有要保护的选区）。 */
export function releaseSelectHoldNow(term: Terminal): void {
  cancelPendingRelease(term);
  setSelectHold(term, false);
}
