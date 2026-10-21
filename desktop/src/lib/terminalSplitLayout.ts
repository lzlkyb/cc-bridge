export type SplitDirection = "h" | "v";
export const SPLIT_GUTTER = 6;
export const MIN_PANE_WIDTH = 360;
export const MIN_PANE_HEIGHT = 160;

export function defaultSplitDirection(width: number): SplitDirection {
  return width > 0 && width < MIN_PANE_WIDTH * 2 + SPLIT_GUTTER ? "v" : "h";
}

/** Use pixel limits when space permits; tiny windows still keep both panes within the area. */
export function clampSplitRatio(ratio: number, size: number, dir: SplitDirection): number {
  const usable = Math.max(0, size - SPLIT_GUTTER);
  const minimum = dir === "h" ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT;
  const edge = usable > 0 ? Math.min(50, minimum / usable * 100) : 20;
  return Math.max(edge, Math.min(100 - edge, ratio));
}
