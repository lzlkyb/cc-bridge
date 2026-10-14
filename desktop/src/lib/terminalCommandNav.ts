import type { Terminal, IMarker } from "@xterm/xterm";

/**
 * 命令导航 + 命令块。
 *
 * 数据全部来自已注入的 OSC 133 钩子（`hooks/useTerminalOsc.ts`），免费：
 * - `133;A`（prompt 标记）→ 此刻光标在提示符行，`registerMarker()` 钉住这一行。
 *   marker 跟随缓冲区滚动/截断自动移动，xterm trim 掉旧行时会 dispose（onDispose 移除）。
 * - `133;D;code`（命令结束）→ 给该块回填退出码，并用「钉点 → D 到达」的间隔当耗时。
 *
 * 🔴 钩子必须 A 与 D 都发、且 **D 在 A 之前**（见 `terminalStatusbar.hookCmd` 的注释）：
 *   D 先到才能落在「刚跑完的那一块」上，A 后到才 push 新块。顺序反了会整体错位一格。
 *
 * WHY 模块级 WeakMap 而不是 hook state：marker 是 xterm 内部对象、按终端实例归属，
 * 生命周期与组件无关（重连换 term 实例自然换 state）；状态栏只读「上一条耗时」一个数字
 * （由 useTerminalOsc 提升进 React），块列表只在面板打开时才需要，不必常驻渲染。
 * WHY 不存 React：useTerminalOsc 的 hooks 数已顶到 8 上限，一个都不能加。
 */

/** 最多记住多少条命令——scrollback 本身有限，50 条足够覆盖可见历史。 */
const MAX_BLOCKS = 50;

/**
 * 一条命令的块 = 提示符行（A 标记）到下一个提示符行之前。
 *
 * ⚠️ 退出码/耗时归属**该块自己**（D 事件回填）。耗时是「上一个提示符 → 本条结束」，
 * 含用户敲命令的时间 —— 精确到「命令执行」需要 `133;C`（要 DEBUG trap），明确不做。
 */
export interface CmdBlock {
  /** 命令在缓冲区里的起始行（提示符行）。 */
  line: number;
  /** 该命令的退出码（OSC 133;D）。null = 还没结束，或远端 shell 未回执。 */
  exitCode: number | null;
  /** 该命令耗时毫秒。null = 还没结束。 */
  durMs: number | null;
}

interface Entry {
  marker: IMarker;
  /** A 事件时刻（performance.now() 毫秒），耗时基准。 */
  at: number;
  exitCode: number | null;
  durMs: number | null;
}

interface NavState {
  entries: Entry[];
  lastDurMs: number | null;
}

const NAV_STATES = new WeakMap<Terminal, NavState>();

function navStateOf(term: Terminal): NavState {
  let s = NAV_STATES.get(term);
  if (!s) {
    s = { entries: [], lastDurMs: null };
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
  const entry: Entry = { marker, at: performance.now(), exitCode: null, durMs: null };
  s.entries.push(entry);
  // onDispose 移除：缓冲区截断/清屏时 xterm 会 dispose marker，列表同步收敛。
  marker.onDispose(() => {
    const i = s.entries.indexOf(entry);
    if (i >= 0) s.entries.splice(i, 1);
  });
  while (s.entries.length > MAX_BLOCKS) s.entries.shift()!.marker.dispose();
}

/**
 * OSC 133;D（命令结束）：给**最后一块**回填退出码与耗时，返回耗时毫秒。
 *
 * 返回 null 表示这次 D 无处可落 —— 还没有任何 A 锚点（会话刚建立时的首个提示符就是
 * 这种情况），或该块的 marker 已被缓冲区截断移除。调用方据此保留旧值。
 */
export function navCmdEnd(term: Terminal, code: number | null): number | null {
  const s = navStateOf(term);
  const last = s.entries[s.entries.length - 1];
  if (!last || last.marker.line === -1) return null;
  const dur = performance.now() - last.at;
  last.durMs = dur;
  last.exitCode = code;
  s.lastDurMs = dur;
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
  if (!s || s.entries.length === 0) return false;
  const viewportY = term.buffer.active.viewportY;
  let best: number | null = null;
  for (const e of s.entries) {
    const line = e.marker.line;
    if (line < 0) continue; // 已被 dispose（onDispose 兜底，双保险）
    if (dir === -1 ? line < viewportY : line > viewportY) {
      if (best === null || (dir === -1 ? line > best : line < best)) best = line;
    }
  }
  if (best === null) return false;
  term.scrollToLine(best);
  return true;
}

/* ============================== 命令块（面板用） ============================== */

/** 当前记录的命令块数量。下标在两次调用之间可能因缓冲区截断而移位，面板按快照用。 */
export function navBlockCount(term: Terminal): number {
  return NAV_STATES.get(term)?.entries.length ?? 0;
}

/** 第 index 个块的元数据。越界或该行已被截断返回 null。 */
export function navBlockAt(term: Terminal, index: number): CmdBlock | null {
  const e = NAV_STATES.get(term)?.entries[index];
  if (!e || e.marker.line < 0) return null;
  return { line: e.marker.line, exitCode: e.exitCode, durMs: e.durMs };
}

/** 缓冲区最后一行的行号（滚动历史底 = baseY，视口内光标偏移 = cursorY）。 */
function bufferBottom(term: Terminal): number {
  const b = term.buffer.active;
  return b.baseY + b.cursorY;
}

/**
 * 第 index 个块的**输出文本**：提示符行的下一行起，到下一个提示符行的前一行止。
 *
 * ⚠️ 提示符行本身**不含在内** —— 那一行是「提示符 + 用户敲的命令」，属输入不属输出；
 * 精确切分它需要 `133;B`（要改 PS1），明确不做。最后一块取到缓冲区末尾（可能还在增长）。
 * 尾部空行剥掉，避免复制出一大坨空白。
 */
export function navBlockOutput(term: Terminal, index: number): string | null {
  const s = NAV_STATES.get(term);
  const e = s?.entries[index];
  if (!s || !e || e.marker.line < 0) return null;
  const buf = term.buffer.active;
  const start = e.marker.line + 1;
  const next = s.entries[index + 1];
  const end = next && next.marker.line >= 0 ? next.marker.line - 1 : bufferBottom(term);
  if (start > end) return ""; // 命令无输出（如 cd / export）
  const out: string[] = [];
  for (let n = start; n <= end; n++) out.push(buf.getLine(n)?.translateToString(true) ?? "");
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** 耗时显示格式：< 60s 显示 `x.xs`，更长显示 `XmYYs`。null/异常回退 null。 */
export function formatCmdDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${m}m${sec.toString().padStart(2, "0")}s`;
}
