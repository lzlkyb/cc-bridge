import { useEffect, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";

/** 焦点落在这类元素上 = 用户正在打字：这种焦点绝不抢回来。 */
function isTypingTarget(el: Element | null): boolean {
  return (
    el instanceof HTMLElement &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
}

/**
 * 工具栏 / 菜单点完把焦点还给终端。
 *
 * 现象（改前）：点「复制 / 粘贴 / 图片 / 搜索 / 更多 / 外观」任一按钮或右键菜单项后，
 * 焦点落在按钮上，直接打字没有任何反应，界面上也没有提示；更糟的是焦点留在按钮上时
 * 按 Space/Enter 会**重复触发上一次动作**（比如再弹一次「已复制 N 字」）。
 *
 * WHY 用 window 事件而不是在每个按钮的 onClick 里 `term.focus()`：按钮散落在
 * 工具栏 / 更多菜单 / 外观菜单 / 窗格操作 / 全屏工具 / 右键菜单六个文件里，逐个包一层
 * 必然漏掉一个 —— 漏掉的那个就是「点了之后打字没反应」。这里只认两个事实：
 * ① 按下去的那一刻终端**本来**持有焦点；② 这一下点在终端自己的 chrome 上。
 *
 * 三条不抢的情形（都有实际后果，别简化）：
 * ① 按下时终端没聚焦 → 用户是从别处（设置页、侧栏）点进来的，抢焦点会把输入光标拽走；
 * ② 点击后活动元素是 input/textarea（搜索框自动聚焦、外观菜单里的输入）→ 该动作要打字；
 * ③ 点击落在终端画布内 → 那里本来就会自己抓焦点（useSshTerminalSession 的 mousedown）。
 */
export function useTerminalFocusReturn(
  termRef: MutableRefObject<Terminal | null>,
  focusedRef: MutableRefObject<boolean>,
  /** 属于「本终端 chrome」的容器（工具栏宿主、右键菜单所在根节点）。 */
  hostsRef: MutableRefObject<(Element | null)[]>,
): void {
  useEffect(() => {
    let armed = false;
    const inHosts = (el: Element | null) =>
      el !== null && hostsRef.current.some((h) => h !== null && h.contains(el));

    // pointerdown 在浏览器把焦点移给按钮**之前**，所以此刻读到的 focusedRef 是「点击前」的真相。
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      armed = focusedRef.current && inHosts(target) && !isTypingTarget(target);
    };
    // 冒泡到 window 时 React 的 onClick 已经跑完（React 18 把监听挂在根容器上）。
    const onClick = () => {
      if (!armed) return;
      armed = false;
      if (isTypingTarget(document.activeElement)) return; // 动作自己拿走了焦点
      termRef.current?.focus();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClick);
    };
  }, [termRef, focusedRef, hostsRef]);
}
