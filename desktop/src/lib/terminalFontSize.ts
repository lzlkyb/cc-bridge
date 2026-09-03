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

/**
 * 字号变化的订阅者。
 *
 * 🔴 上面那句「字号是**全局**的」以前只是句声明：存储确实是一个全局键，
 * 但每个终端各自持有 state，没人告诉其它终端“值变了”。于是把 A 调到 20、
 * B 还是 14，重启后两个都变 20——同一个设置表现得像两个。
 */
const listeners = new Set<(n: number) => void>();

/** 订阅字号变化（另一个终端调了字号）；返回退订函数。 */
export function subscribeFontSize(fn: (n: number) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 存盘并广播给所有开着的终端。 */
export function saveFontSize(n: number): void {
  const v = clampFontSize(n);
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* 存不下就算了，不影响当前会话 */
  }
  // 广播不能放进上面的 try：没有 localStorage 时存盘失败是可接受的，
  // 但本次会话内的同步不能跟着一起挂。
  listeners.forEach((fn) => fn(v));
}
