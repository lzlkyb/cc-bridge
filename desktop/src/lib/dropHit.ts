/**
 * 拖放命中判定（纯计算，可单测）。
 *
 * 🔴 为什么需要自己算：`tauri.conf.json` 未设 `dragDropEnabled`，Tauri 2 下默认
 * **开启原生拖放处理**，而开着时 webview 里的 HTML5 `dragover` / `drop` 不会触发——
 * 用不了 React 的 `onDrop`，只能拿 `onDragDropEvent` 给的光标坐标自己做命中判定。
 */

/** 一个可接收拖放的区域（矩形取自 `getBoundingClientRect()`，CSS 像素）。 */
export interface DropZone {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * 物理像素 → CSS 像素。
 *
 * 🔴 `DragDropEvent.position` 是 **PhysicalPosition**，而 `getBoundingClientRect()`
 * 返回的是 CSS 像素。不除 `devicePixelRatio` 的话，Windows 125% 缩放下坐标会偏 25%，
 * 表现是「拖到面板上方才亮」——且在 100% 缩放的机器上完全正常，极容易漏掉。
 *
 * `dpr` 非正数时当 1：宁可位置略偏，也不能除出 NaN 让整个拖放失灵。
 */
export function toCssPoint(pos: Point, dpr: number): Point {
  const r = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { x: pos.x / r, y: pos.y / r };
}

/** 点是否在矩形内（包含左/上边，不包含右/下边，与 CSS 命中一致）。 */
export function pointInZone(p: Point, z: DropZone): boolean {
  return p.x >= z.left && p.x < z.right && p.y >= z.top && p.y < z.bottom;
}

/**
 * 找出命中的区域 id；都没命中返回 null。
 *
 * 区域**按数组顺序从后往前**找：文件面板是 `absolute inset-0 z-10` 盖在终端之上的
 * 浮层，两者矩形完全重叠；排在后面的覆盖前面的，与视觉层叠顺序一致。
 */
export function hitZone(
  pos: Point,
  dpr: number,
  zones: DropZone[],
): string | null {
  const p = toCssPoint(pos, dpr);
  for (let i = zones.length - 1; i >= 0; i--) {
    if (pointInZone(p, zones[i])) return zones[i].id;
  }
  return null;
}

/** 从 `getBoundingClientRect()` 造一个 DropZone。零尺寸（隐藏元素）返回 null。 */
export function zoneOf(id: string, el: HTMLElement | null): DropZone | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // 隐藏元素（display:none）的矩形是 0×0，会在左上角造出一个假命中点。
  if (r.width <= 0 || r.height <= 0) return null;
  return { id, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}
