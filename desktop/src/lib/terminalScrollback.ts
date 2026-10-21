/**
 * 终端滚动缓冲行数的持久化（纯前端偏好，与 terminalFontSize / terminalPreset 同一套做法）。
 *
 * 以前写死 5000（`terminalTheme.ts` 的 TERMINAL_SCROLLBACK）：跑构建日志 / tail 大文件时
 * 历史被冲掉。现在可选，存 localStorage、广播给所有开着的终端热生效——xterm 支持
 * 运行时改 `options.scrollback`（调小自动从最旧一侧裁剪）。
 *
 * 🔴 不提供「无限制」：scrollback 是按行驻留内存的（每行 ≈ cols 个 cell），
 * 上不封顶等于给长时运行的 tail -f 留一个 OOM 引线。上限 5 万行已覆盖绝大多数场景。
 */

const KEY = "cc-bridge.terminal-scrollback";
const OPTIONS = [1000, 5000, 10000, 50000] as const;

export const SCROLLBACK_OPTIONS: readonly number[] = OPTIONS;
export const DEFAULT_SCROLLBACK = 5000;
/** 硬上限：防手改 localStorage 塞进离谱值。 */
export const SCROLLBACK_MAX = 100_000;
/** 硬下限：低于几百行的回滚没有使用价值。 */
export const SCROLLBACK_MIN = 100;

/** 夹到硬区间并取整；非法值（NaN / 非数字）回默认。 */
export function clampScrollback(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SCROLLBACK;
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(n)));
}

let cache: number | null = null;
const listeners = new Set<(n: number) => void>();

/** 读取当前滚动行数。localStorage 不可用/值非法时回落默认，不抛。 */
export function loadScrollback(): number {
  if (cache !== null) return cache;
  cache = DEFAULT_SCROLLBACK;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) cache = clampScrollback(Number(raw));
  } catch {
    // 隐私模式等：保持默认。
  }
  return cache;
}

/** 订阅变化（其它终端 / 设置页改了值）；返回退订函数。 */
export function subscribeScrollback(fn: (n: number) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 存盘并广播给所有开着的终端（热生效，xterm 自动裁剪旧缓冲）。 */
export function saveScrollback(n: number): boolean {
  const v = clampScrollback(n);
  cache = v;
  let saved = false;
  try {
    localStorage.setItem(KEY, String(v));
    saved = true;
  } catch {
    // 写不进就只留在内存，本次会话仍然生效。
  }
  listeners.forEach((fn) => fn(v));
  return saved;
}

/** 仅供单测：清掉模块级缓存。 */
export function resetScrollbackForTest(): void {
  cache = null;
}
