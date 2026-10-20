import type { Terminal } from "@xterm/xterm";
import { mouseTrackingActive } from "./terminalMouse";

/**
 * 选区保活守卫：**松手之后**不许「无按键的鼠标移动」把本地选区冲掉。
 *
 * ## 为什么会有这个洞（2026-10-20 报障：关掉「选中即复制」后松手选区自动消失）
 *
 * 完整链条（源码级，动之前必读）：
 * 1. Claude Code 开的是 `?1003h`（ANY，任意移动）—— 它的二进制里
 *    `S = w1(1000)+w1(1002)+w1(1003)+w1(1006)`、`w1(E) = "CSI ?Eh"`，1003 排在最后生效。
 * 2. xterm 在 ANY 时给**容器内部**的 `.terminal` 根元素挂 `mousemove`
 *    （`CoreBrowserTerminal.bindMouse`：743-749 行装监听，720-725 行
 *    `if (!ev.buttons) sendEvent(ev)`）⇒ **没有按住任何键的纯移动也会被编码成
 *    SGR 报告**（`ESC[<35;x;yM`）。
 * 3. 报告走 `CoreMouseService.triggerMouseEvent` 末尾的
 *    `triggerDataEvent(report, true)`（327-330 行），`wasUserInput` 为真 ⇒
 *    `CoreService` 里 fire `onUserInput`（74-76 行）。
 * 4. `SelectionService` 在这个事件上只挂了一句 `clearSelection()`（139-143 行）。
 *
 * 于是：手势期间靠 `terminalInputHold` 的输入闸挡报告，松手时 `releaseSelectHoldSoon`
 * 只多挡一拍（拦下紧随 pointerup 的 mouseup），**闸一开，用户把鼠标移开的那一下就把
 * 选区清掉了**。开着「选中即复制」时文本早在 pointerup 就进了剪贴板、还弹了 toast，
 * 用户不会去看高亮；关掉后高亮是唯一反馈，于是表现为「松手即取消选中」。
 *
 * ## 为什么吞 mousemove，而不是把输入闸继续闭着
 *
 * 闸（`disableStdin`）是**全局**的：闭着就键盘也哑。要保住选区就得一直闭到下一次真实
 * 动作（keydown / pointerdown / wheel），等于维护三四条释放路径——漏一条就是键盘全哑
 * （历史致命故障，见 terminalInputHold 头注）。而这里有害的只有「无按键的移动报告」
 * 这一路，它唯一的语义是 hover；把这一路在**容器捕获阶段**掐掉就够，别的输入一字不动。
 *
 * xterm 那枚 ANY 监听挂在容器的**子元素** `.terminal` 上，容器 capture 里
 * `stopPropagation()` 之后它根本收不到事件 ⇒ 报告在生产端就没了，不用碰协议状态。
 *
 * ## 代价与自愈
 *
 * 选区存在期间 TUI 收不到 hover（Claude Code 没有 hover 反馈，感知不到；链接悬停下划线
 * 在同一窗口内失效）。用户下一次点击时 xterm 自己清掉选区 ⇒ 判据自然失效：
 * **没有需要复位的状态、没有定时器，不可能泄漏**。
 */
export function attachSelectionKeepGuard(term: Terminal, container: HTMLElement): () => void {
  const onMove = (e: MouseEvent) => {
    if (e.buttons !== 0) return; // 按住键的拖动：选区延伸与远端拖拽报告都该照常
    if (!mouseTrackingActive(term)) return; // 没开鼠标追踪：本来就不产生报告
    if (!term.hasSelection()) return; // 没选区：hover 照常转发
    e.stopPropagation();
  };
  container.addEventListener("mousemove", onMove, true);
  return () => container.removeEventListener("mousemove", onMove, true);
}
