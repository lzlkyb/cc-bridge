import { useEffect, useState } from "react";
import { MOTION } from "../lib/motion";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/** Retain the DOM through exit; reopening cancels its pending removal. */
export function usePresence(open: boolean) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (!open) {
      setEntered(false);
      if (reduced) { setMounted(false); return; }
      const timer = window.setTimeout(() => setMounted(false), MOTION.exit);
      return () => window.clearTimeout(timer);
    }
    setMounted(true);
    if (reduced) { setEntered(true); return; }
    // A single frame can be batched with mounting and skip the initial pose.
    let next = 0;
    const frame = requestAnimationFrame(() => {
      next = requestAnimationFrame(() => setEntered(true));
    });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(next); };
  }, [open, reduced]);

  // Opening must expose controls in this commit, even before the entry effect runs.
  return { mounted: open || mounted, entered };
}
