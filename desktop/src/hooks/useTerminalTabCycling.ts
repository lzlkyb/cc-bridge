import { useEffect, useRef } from "react";
import { useViewActive } from "../lib/viewActivity";

/** 焦点在输入控件里时不抢 Ctrl+Tab（那是浏览器的正常 Tab 导航语义）。 */
function isTyping(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLElement &&
    !el.closest(".xterm") &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
}

/**
 * 终端标签的键盘切换：Ctrl+Tab / Ctrl+Shift+Tab 在会话标签间循环。
 *
 * 由来（2026-10-29 盘点）：终端**一个标签级快捷键都没有**，全屏时更糟——全屏把标签区
 * 的滚动条显式隐藏、宽度限 60%，被挤出去的标签既没有「还有 N 个」提示也没有 ◀▶，
 * 用户只能靠鼠标去够（够不到就没辙）。Ctrl+Tab 是编辑器/终端（VS Code、Windows Terminal）
 * 的通行约定，加上它就把「溢出的标签够不着」这个死角补掉一半。
 *
 * 🔴 只在终端视图活动时生效（useViewActive）：CC 对话页自己也用 Ctrl+Tab 切会话，
 * 两个页面同时挂 window 监听会互相抢。
 */
export function useTerminalTabCycling(
  /** 参与循环的会话 id（顺序即标签顺序，副格不参与）。 */
  ids: string[],
  activeId: string | null,
  activate: (sessionId: string) => void,
): void {
  const viewActive = useViewActive();
  const ref = useRef({ ids, activeId, activate });
  ref.current = { ids, activeId, activate };

  useEffect(() => {
    if (!viewActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.key !== "Tab") return;
      if (isTyping()) return;
      const { ids: list, activeId: current, activate: go } = ref.current;
      if (list.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const i = current ? list.indexOf(current) : -1;
      const step = e.shiftKey ? -1 : 1;
      go(list[(i + step + list.length) % list.length]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [viewActive]);
}
