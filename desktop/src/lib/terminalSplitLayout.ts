export type SplitDirection = "h" | "v";
export const SPLIT_GUTTER = 6;
export const MIN_PANE_WIDTH = 360;
export const MIN_PANE_HEIGHT = 160;

export function defaultSplitDirection(width: number): SplitDirection {
  return width > 0 && width < MIN_PANE_WIDTH * 2 + SPLIT_GUTTER ? "v" : "h";
}

/** Use pixel limits when space permits; tiny windows keep a draggable range instead of locking 50/50. */
export function clampSplitRatio(ratio: number, size: number, dir: SplitDirection): number {
  const usable = Math.max(0, size - SPLIT_GUTTER);
  // 还没量到尺寸（首帧 / jsdom）：不按像素夹，只留 20%~80% 的常识区间。
  if (usable <= 0) return Math.max(20, Math.min(80, ratio));
  const minimum = dir === "h" ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT;
  const byPixels = (minimum / usable) * 100;
  // 🔴 窄窗陷阱：两格加起来都放不下一个像素下限时，`min(50, byPixels)` 会得到 50，
  // 夹取区间退化成 [50, 50] —— 手柄还在、却一格都拖不动，用户以为分屏坏了。
  // 这种情况（byPixels ≥ 50）改为各留 25% 的百分比下限：像素上限做不到，至少保住可拖。
  const edge = byPixels >= 50 ? 25 : byPixels;
  return Math.max(edge, Math.min(100 - edge, ratio));
}
