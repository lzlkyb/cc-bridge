import { useEffect, useRef, useState } from "react";
import { useAppHidden } from "../lib/appVisibility";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/** Interpolate known samples only; resets, hidden views and reduced motion show the exact target. */
export function useAnimatedNumbers(target: number[], { enabled = true, resetKey = "", duration = 330 }: {
  enabled?: boolean; resetKey?: string; duration?: number;
} = {}): number[] {
  const hidden = useAppHidden();
  const reduced = usePrefersReducedMotion();
  const animate = enabled && !hidden && !reduced && duration > 0;
  const signature = target.join(",");
  const latest = useRef(target);
  latest.current = target;
  const current = useRef(target);
  const previous = useRef({ enabled: animate, resetKey });
  const [frame, setFrame] = useState({ values: target, resetKey });

  useEffect(() => {
    // Read the latest snapshot, not an array identity: callers may pass an inline single value.
    const next = latest.current;
    const from = current.current;
    const continuous = animate && previous.current.enabled && previous.current.resetKey === resetKey && from.length === next.length;
    previous.current = { enabled: animate, resetKey };
    if (!continuous || next.every((value, i) => value === from[i])) {
      current.current = next;
      setFrame(old => old.resetKey === resetKey && old.values.length === next.length && next.every((v, i) => old.values[i] === v) ? old : { values: next, resetKey });
      return;
    }
    const started = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.max(0, Math.min(1, (now - started) / duration));
      const eased = 1 - (1 - t) ** 3;
      const values = t === 1 ? next : next.map((value, i) => from[i] + (value - from[i]) * eased);
      current.current = values;
      setFrame({ values, resetKey });
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [signature, animate, resetKey, duration]);

  return !animate || frame.resetKey !== resetKey || frame.values.length !== target.length ? target : frame.values;
}
