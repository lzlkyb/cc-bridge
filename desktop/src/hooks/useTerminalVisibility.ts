import { useEffect, useRef, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "../lib/tauri";

/** 可见性只决定适配尺寸；输入焦点始终归当前选中的窗格，防止还原分屏时互相抢焦点。 */
export function useTerminalVisibility({ visible, active, sessionId, termRef, closedRef, doFit }: {
  visible: boolean; active: boolean; sessionId: string;
  termRef: MutableRefObject<Terminal | null>; closedRef: MutableRefObject<boolean>; doFit: () => void;
}) {
  const canFocusRef = useRef(visible && active);
  canFocusRef.current = visible && active;
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
