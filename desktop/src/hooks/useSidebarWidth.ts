import { useEffect, useRef, useState, type PointerEvent } from "react";
const KEY = "cc-bridge.ssh-sidebar-width";
const clamp = (value: number) => Math.min(360, Math.max(180, value));

/**
 * 可拖拽侧栏宽度（180–360，默认 240）。
 *
 * `key` 默认是终端侧栏那个——**两条侧栏必须各存各的**：用户把终端侧栏拖到 300
 * 是给终端用的，不该顺手把对话页的会话栏也改名宽。调用方传自己的 key 即可。
 */
export function useSidebarWidth(storageKey: string = KEY) {
  const [width, setWidth] = useState(() => {
    try { const n = Number(localStorage.getItem(storageKey)); return Number.isFinite(n) && n > 0 ? clamp(n) : 240; }
    catch { return 240; }
  });
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => { try { localStorage.setItem(storageKey, String(width)); } catch { /* 存储不可用时仍可调宽。 */ } }, 200);
    return () => clearTimeout(timer);
  }, [width, storageKey]);
  return {
    width, resize: (n: number) => setWidth(clamp(n)),
    start: (e: PointerEvent<HTMLButtonElement>) => { drag.current = { x: e.clientX, width }; e.currentTarget.setPointerCapture(e.pointerId); },
    move: (e: PointerEvent<HTMLButtonElement>) => { if (drag.current) setWidth(clamp(drag.current.width + e.clientX - drag.current.x)); },
    end: () => { drag.current = null; },
  };
}
