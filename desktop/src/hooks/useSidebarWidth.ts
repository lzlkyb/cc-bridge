import { useEffect, useRef, useState, type PointerEvent } from "react";
const KEY = "cc-bridge.ssh-sidebar-width";
const clamp = (value: number) => Math.min(360, Math.max(180, value));

export function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    try { const n = Number(localStorage.getItem(KEY)); return Number.isFinite(n) && n > 0 ? clamp(n) : 240; }
    catch { return 240; }
  });
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => { try { localStorage.setItem(KEY, String(width)); } catch { /* 存储不可用时仍可调宽。 */ } }, 200);
    return () => clearTimeout(timer);
  }, [width]);
  return {
    width, resize: (n: number) => setWidth(clamp(n)),
    start: (e: PointerEvent<HTMLButtonElement>) => { drag.current = { x: e.clientX, width }; e.currentTarget.setPointerCapture(e.pointerId); },
    move: (e: PointerEvent<HTMLButtonElement>) => { if (drag.current) setWidth(clamp(drag.current.width + e.clientX - drag.current.x)); },
    end: () => { drag.current = null; },
  };
}
