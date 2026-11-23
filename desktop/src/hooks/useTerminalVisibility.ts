import { useEffect, useRef, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "../lib/tauri";
import { isAppHidden, subscribeAppVisibility } from "../lib/appVisibility";
import { useViewActive } from "../lib/viewActivity";

/** 可见性只决定适配尺寸；输入焦点始终归当前选中的窗格，防止还原分屏时互相抢焦点。 */
export function useTerminalVisibility({ visible, active, sessionId, termRef, closedRef, doFit }: {
  visible: boolean; active: boolean; sessionId: string;
  termRef: MutableRefObject<Terminal | null>; closedRef: MutableRefObject<boolean>; doFit: () => void;
}) {
  const viewActive = useViewActive();
  const canFocusRef = useRef(visible && active && viewActive);
  canFocusRef.current = visible && active && viewActive;
  useEffect(() => {
    if (!visible || !viewActive) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => clearTimeout(timer);
    const restore = (focus: boolean) => {
      cancel();
      if (isAppHidden()) return;
      timer = setTimeout(() => {
        if (isAppHidden()) return;
        doFit();
        const term = termRef.current;
        if (!term || !focus || !canFocusRef.current || closedRef.current) return;
        // 窗口恢复不等于用户结束了搜索或填表，不能把焦点从这些控件夺走。
        const el = document.activeElement;
        if (document.querySelector('[aria-modal="true"]:not([data-exiting])')) return;
        if (el !== term.textarea && el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"]')) return;
        term.focus();
      }, 0);
    };
    const onFocus = () => restore(true);
    const off = subscribeAppVisibility(() => restore(document.hasFocus()));
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", cancel);
    return () => { cancel(); off(); window.removeEventListener("focus", onFocus); window.removeEventListener("blur", cancel); };
  }, [visible, viewActive, sessionId, termRef, closedRef, doFit]);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      doFit();
      const term = termRef.current;
      if (term) void invoke("ssh_resize", { sessionId, rows: term.rows, cols: term.cols }).catch(() => {});
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, sessionId, doFit, termRef]);
  useEffect(() => {
    if (!visible || !active) return;
    const timer = setTimeout(() => {
      if (!canFocusRef.current || closedRef.current) return;
      const term = termRef.current;
      if (!term) return;
      try { term.textarea?.focus(); } catch { /* textarea 尚未就绪 */ }
      term.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, active, sessionId, termRef, closedRef]);
  return canFocusRef;
}
