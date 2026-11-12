import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { shouldStartDrag } from "../lib/titlebarDrag";

/**
 * 顶栏拖拽接管（H8）。用法：顶栏根元素设 `data-tauri-drag-region="false"`
 * 关闭 tauri 内置脚本，再把本 hook 返回的 handler 挂到 `onMouseDown`。
 *
 * 内置脚本走 `document` 的 mousedown 冒泡监听，我们挂在元素上先执行；
 * 但只「不调用」不够——内置脚本仍会自己 invoke，所以属性必须置 false。
 */

/** 这些元素上的 mousedown 是正常交互（点按钮、选文本），既不拖窗口也不吞事件。 */
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** 纯浏览器 dev（非 Tauri WebView）里 getCurrentWindow 会同步抛错。 */
function tryWin(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function useTitlebarDrag() {
  // 挂载时窗口通常就在前台；focusedAt=0 表示「没记录过」，按已聚焦处理
  const focusedRef = useRef(true);
  const focusedAtRef = useRef(0);

  useEffect(() => {
    const onFocus = () => {
      focusedRef.current = true;
      focusedAtRef.current = performance.now();
    };
    const onBlur = () => {
      focusedRef.current = false;
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    if (target?.closest(INTERACTIVE_SELECTOR)) return;

    const now = performance.now();
    if (!shouldStartDrag(now, focusedAtRef.current, focusedRef.current)) {
      // 这一下只负责把窗口拉到前台。消费掉 grace：紧接着的第二次点击
      // （比如手快的双击）要能正常拖动 / 最大化，不能一直被挡。
      focusedRef.current = true;
      focusedAtRef.current = 0;
      return;
    }

    // 防止拖拽时选中顶栏文字（内置脚本原来也做这件事）
    e.preventDefault();

    const win = tryWin();
    if (!win) return;
    if (e.detail === 2) void win.toggleMaximize().catch(() => {});
    else void win.startDragging().catch(() => {});
  }, []);
}
