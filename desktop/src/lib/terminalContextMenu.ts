import type { Terminal } from "@xterm/xterm";
import { cancelPendingRelease, releaseSelectHoldSoon, setSelectHold } from "./terminalInputHold";

/**
 * 右键「保住选区」守卫。
 *
 * ## 为什么需要它（2026-10-16 用户报「选中文字后右键复制基本报废」）
 *
 * 🔴 xterm 把鼠标报告当**用户输入**发：`CoreMouseService.triggerMouseEvent` 调的是
 * `CoreService.triggerDataEvent(report, true)`，而 `wasUserInput` 为真会 fire `onUserInput`，
 * `SelectionService` 构造时挂在这个事件上的监听（源码 139-143）只有一句
 * `if (this.hasSelection) this.clearSelection()`。右键同样是鼠标事件——协议活跃
 * （Claude Code 开着鼠标跟踪）时，**右键按下那一瞬选区就被 xterm 自己清掉了**，
 * 等我们的 contextmenu 菜单弹出，`term.getSelection()` 已是空串，「复制」项于是恒置灰。
 * 这不是菜单的问题，是选区在菜单之前就没了。
 *
 * ## 修法
 *
 * 右键按下时闭**输入闸**（`disableStdin`，见 lib/terminalInputHold.ts），把这一对
 * down/up 报告拦在 `CoreService.triggerDataEvent` 门口：
 * ① 本地选区保住；② 远端收不到——本来就该如此，右键在我们的应用里是**应用级菜单**，
 * 不是发给 TUI 的输入。
 *
 * 开闸走 `releaseSelectHoldSoon`（延后一拍）：紧随 pointerup 的 mouseup 报告若在开闸之后
 * 发出，仍会走 onUserInput → clearSelection，选区会在菜单弹出后被清掉。
 *
 * 顺带关掉 xterm 的 `rightClickSelectsWord`：它的默认值在 mac 上是 true，会在右键位置
 * **选中光标下的词**、覆盖用户刚拖好的选区（显式关掉才对三平台一致）。
 */
export function attachContextMenuGuard(term: Terminal, container: HTMLElement): () => void {
  term.options.rightClickSelectsWord = false;

  // 用容器所属文档的 window（而不是全局 window）：既能在 node 测试里构造，也天然正确
  // 对应多窗口场景。pointerup 挂 window 是因为指针可能已经移出容器。
  const win = container.ownerDocument?.defaultView ?? null;

  // capture 阶段：xterm 的鼠标监听在子元素上，capture 先于它执行，闸门先于报告编码闭合。
  const onDown = (e: PointerEvent) => {
    if (e.button !== 2) return; // 只管右键；中键的 auxclick 粘贴走 xterm 自己那条路
    cancelPendingRelease(term); // 上一个手势的延时开闸可能还没跑，先撤掉再闭闸
    setSelectHold(term, true);
  };
  const onUp = (e: PointerEvent) => {
    if (e.button !== 2) return;
    releaseSelectHoldSoon(term);
  };
  container.addEventListener("pointerdown", onDown, true);
  win?.addEventListener("pointerup", onUp, true);

  return () => {
    container.removeEventListener("pointerdown", onDown, true);
    win?.removeEventListener("pointerup", onUp, true);
    // 卸载时松开：终端跨重连保留，闸留在闭合态就再没人来开。释放是幂等的。
    releaseSelectHoldSoon(term);
  };
}
