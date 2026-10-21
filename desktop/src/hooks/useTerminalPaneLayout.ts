import { useEffect, useState, type RefObject } from "react";
import { clampSplitRatio, SPLIT_GUTTER } from "../lib/terminalSplitLayout";
import type { SplitInfo } from "../components/tabs/useTerminalSplit";

export function useTerminalPaneLayout(areaRef: RefObject<HTMLDivElement | null>, split: SplitInfo | null, setRatio: (ratio: number) => void) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = () => setSize({ width: area.clientWidth, height: area.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [areaRef]);
  const vertical = split?.dir === "v";
  const extent = vertical ? size.height : size.width;
  const ratio = split ? clampSplitRatio(split.ratio, extent, split.dir) : 50;
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!split || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const rect = areaRef.current!.getBoundingClientRect();
    const length = vertical ? rect.height : rect.width;
    if (length <= SPLIT_GUTTER) return;
    const distance = vertical ? e.clientY - rect.top : e.clientX - rect.left;
    setRatio(clampSplitRatio((distance - SPLIT_GUTTER / 2) / (length - SPLIT_GUTTER) * 100, length, split.dir));
  };
  const keyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!split) return;
    const decrease = vertical ? "ArrowUp" : "ArrowLeft", increase = vertical ? "ArrowDown" : "ArrowRight";
    if (![decrease, increase, "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? 100 : ratio + (e.key === decrease ? -5 : 5);
    setRatio(clampSplitRatio(next, extent, split.dir));
  };
  return { ratio, move, keyDown, min: split ? clampSplitRatio(0, extent, split.dir) : 0, max: split ? clampSplitRatio(100, extent, split.dir) : 100 };
}
