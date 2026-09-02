/**
 * 终端字号（Ctrl+滚轮缩放）的纯逻辑。
 *
 * 字号是**全局**的、不是每个会话各管各的：调字号是在调“我看得清不清”，
 * 跟连的是哪台机器无关。存 localStorage，重开保持。
 */

const KEY = "cc-bridge.terminal-font-size";

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 24;
export const FONT_SIZE_DEFAULT = 13;

/** 夹到合法区间并取整；非法值（NaN / 非数字）一律回默认值。 */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

/** 读取已保存的字号；没有 / 不可用时回默认值。 */
export function loadFontSize(): number {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? FONT_SIZE_DEFAULT : clampFontSize(Number(raw));
  } catch {
    return FONT_SIZE_DEFAULT; // 隐私模式等无 localStorage
  }
}

export function saveFontSize(n: number): void {
  try {
    localStorage.setItem(KEY, String(clampFontSize(n)));
  } catch {
    /* 存不下就算了，不影响当前会话 */
  }
}
