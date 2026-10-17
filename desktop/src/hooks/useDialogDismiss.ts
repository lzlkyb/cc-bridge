import { useCallback, useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { useViewActive } from "../lib/viewActivity";
import { MOTION } from "../lib/motion";

/** 先退场，再通知条件挂载的父组件卸载；重复点击不会执行两次危险操作。 */
export function useDialogDismiss(onClose: () => void, open = true) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const latest = useRef(onClose);
  latest.current = onClose;
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const frame = useRef(0);
  const reduced = usePrefersReducedMotion();
  const active = useViewActive();
  const dismiss = useCallback((action?: () => void) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const finish = action ?? latest.current;
    if (reduced) { finish(); return; }
    frame.current = requestAnimationFrame(() => { timer.current = setTimeout(finish, MOTION.exit); });
  }, [reduced]);
  useEffect(() => {
    if (!open) { closingRef.current = false; setClosing(false); }
    else if (!active) dismiss();
  }, [open, active, dismiss]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); clearTimeout(timer.current); }, []);
  return { closing, dismiss };
}
