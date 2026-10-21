/**
 * TUI 滚动速度的持久化（纯前端观感偏好，与 lib/terminalPreset.ts 同一套做法）。
 *
 * 语义：TUI 虚拟滚动条拖动时，每 1px 物理位移对应几行内容。默认 1（1px=1行，
 * 精细）；长对话调到 3/5 更省手。localStorage 不进备份——偏好丢失回到默认，可接受。
 */
const SPEED_KEY = "cc-bridge.tui-scroll-speed";
const SPEEDS = [1, 3, 5] as const;

export type TuiScrollSpeed = (typeof SPEEDS)[number];
export const DEFAULT_TUI_SCROLL_SPEED: TuiScrollSpeed = 1;
export const TUI_SCROLL_SPEEDS: readonly TuiScrollSpeed[] = SPEEDS;

/** 模块级缓存：拖动时每个 pointermove 都要读一次，不能每次碰 localStorage。 */
let cache: TuiScrollSpeed | null = null;

/** 读取当前速度。localStorage 不可用/值非法时回落默认，不抛。 */
export function loadTuiScrollSpeed(): TuiScrollSpeed {
  if (cache !== null) return cache;
  cache = DEFAULT_TUI_SCROLL_SPEED;
  try {
    const raw = Number(localStorage.getItem(SPEED_KEY));
    if ((SPEEDS as readonly number[]).includes(raw)) {
      cache = raw as TuiScrollSpeed;
    }
  } catch {
    // 隐私模式等：保持默认。
  }
  return cache;
}

/** 保存速度并同步缓存（热生效，正在拖动的滚动条下一次 move 即用新值）。 */
export function saveTuiScrollSpeed(v: TuiScrollSpeed): boolean {
  cache = v;
  try {
    localStorage.setItem(SPEED_KEY, String(v));
    return true;
  } catch {
    // 写不进就只留在内存，本次会话仍然生效。
    return false;
  }
}

/** 仅供单测：清掉模块级缓存，让下一次 load 重新读 localStorage。 */
export function resetTuiScrollSpeedForTest(): void {
  cache = null;
}
