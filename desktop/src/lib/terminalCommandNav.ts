import type { Terminal, IMarker } from "@xterm/xterm";

/**
 * 命令导航（P1 ⑥）：跳到上一条/下一条命令的输出起点 + 显示上一条命令耗时。
 *
 * 数据全部来自已注入的 OSC 133 钩子（`hooks/useTerminalOsc.ts`），免费：
 * - `133;A`（prompt 标记）→ 此刻光标在提示符行，`registerMarker()` 钉住这一行。
 *   marker 跟随缓冲区滚动/截断自动移动，xterm trim 掉旧行时会 dispose（onDispose 移除）。
 * - `133;D;code`（命令结束）→ 与最近一次 A 配对算耗时。
 *
 * WHY 模块级 WeakMap 而不是 hook state：marker 是 xterm 内部对象、按终端实例归属，
 * 生命周期与组件无关（重连换 term 实例自然换 state）；状态栏只读「上一条耗时」一个
 * 数字（由 useTerminalOsc 提升进 React），marker 列表永远不需要触发渲染。
 * WHY 不存 React：useTerminalOsc 的 hooks 数已顶到 8 上限，一个都不能加。
 */

/** 最多记住多少条命令起点——scrollback 本身有限，50 条足够覆盖可见历史。 */
const MAX_MARKERS = 50;

interface NavState {
  markers: IMarker[];
  /** 与 markers 一一对应的命令开始时刻（performance.now() 毫秒）。 */
  starts: number[];
  lastDurMs: number | null;
}

const NAV_STATES = new WeakMap<Terminal, NavState>();

function navStateOf(term: Terminal): NavState {
  let s = NAV_STATES.get(term);
  if (!s) {
    s = { markers: [], starts: [], lastDurMs: null };
    NAV_STATES.set(term, s);
  }
  return s;
}

/** OSC 133;A（新提示符 / 命令起点）：钉 marker、记开始时刻。 */
export function navCmdStart(term: Terminal): void {
  const s = navStateOf(term);
  const marker = term.registerMarker(0);
  if (!marker || marker.line === -1) {
    marker?.dispose();
    return;
  }
  s.markers.push(marker);
  s.starts.push(performance.now());
  // onDispose 移除：缓冲区截断/清屏时 xterm 会 dispose marker，列表同步收敛。
  marker.onDispose(() => {
    const i = s.markers.indexOf(marker);
    if (i >= 0) {
      s.markers.splice(i, 1);
      s.starts.splice(i, 1);
    }
  });
  while (s.markers.length > MAX_MARKERS) {
    s.markers.shift()!.dispose();
    s.starts.shift();
  }
}

/** OSC 133;D（命令结束）：与最近一次 A 配对算耗时，返回毫秒（无法配对返回 null）。 */
export function navCmdEnd(term: Terminal): number | null {
  const s = navStateOf(term);
  if (s.starts.length === 0) return null;
  const t0 = s.starts.pop()!;
  const dur = performance.now() - t0;
  s.lastDurMs = dur;
  // D 只消费时间戳，marker 保留（它标的是提示符行，导航要用）。
  return dur;
}

/** 上一条命令的耗时（状态栏显示用）。 */
export function navLastDuration(term: Terminal): number | null {
  return NAV_STATES.get(term)?.lastDurMs ?? null;
}

/**
 * 跳到上一条（dir=-1）/下一条（dir=+1）命令的提示符行。
 * 以当前视口顶（viewportY）为参照，返回是否跳了（供调用方给 toast 反馈）。
 */
export function navJump(term: Terminal, dir: -1 | 1): boolean {
  const s = NAV_STATES.get(term);
  if (!s || s.markers.length === 0) return false;
  const viewportY = term.buffer.active.viewportY;
  let best: number | null = null;
  for (const m of s.markers) {
    const line = m.line;
    if (line < 0) continue; // 已被 dispose（onDispose 兜底，双保险）
    if (dir === -1 ? line < viewportY : line > viewportY) {
      if (best === null || (dir === -1 ? line > best : line < best)) best = line;
    }
  }
  if (best === null) return false;
  term.scrollToLine(best);
  return true;
}

/** 耗时显示格式：< 60s 显示 `x.xs`，更长显示 `XmYYs`。null/异常回退 null。 */
export function formatCmdDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${m}m${sec.toString().padStart(2, "0")}s`;
}
