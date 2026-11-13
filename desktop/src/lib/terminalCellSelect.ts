import type { Terminal } from "@xterm/xterm";
import { mouseTrackingActive } from "./terminalMouse";
import { markDownConsumed } from "./terminalPointerGate";

/**
 * 双击「选中单元格」：把 xterm 的词选换成**按表格/字段边界**取一整块。
 *
 * ## 为什么需要（2026-11-03 用户报「只想选表格里那一格，后面的也被复制出来」）
 *
 * xterm 只有三种选择语义：线性（起点→终点，跨行时中间行整行带走）、词、整行。
 * 表格里横向拖选时只要鼠标斜着走两三个像素到了下一行，中间那行就**从起点一直选到行尾**，
 * 右侧「说明」列一并被复制。这是语义问题，不是 bug，改不了。
 *
 * 两个对策：
 * - 矩形列选：`Alt+拖拽`，走 xterm 原生 `SelectionMode.COLUMN`（见 terminalSelectGesture）。
 * - **双击取一格**（本文件）：用户明确指向某个单元格时，一次点击就选中它。
 *
 * ## 为什么不用 xterm 自带的双击选词
 *
 * 1. 鼠标追踪开着时 `SelectionService` 被整体 disable，双击根本不产生选区
 *    （Claude Code 的表格正是这个场景）——那才是用户真正想选的地方。
 * 2. `wordSeparator` 里没有中文边界，CJK 会被当成一个长词；表格的单元格内又常有空格。
 *    与其调分词器，不如按**列**切：表格是空格/竖线对齐的，按对齐关系切必然准。
 *
 * ## 边界判定顺序（表格 → 对齐文本 → 普通文本）
 *
 * 1. 该行含两条以上竖线（`│`/`|`）⇒ 取光标所在的两条竖线之间。
 * 2. 该行「像表格」（竖线够多，或有 ≥2 处连续双空格）⇒ 按**连续 2+ 空白**切列。
 * 3. 其余情况按单个空白切词 —— 普通日志/路径双击仍是一段，不是整行。
 *
 * 全程用**列**（不是字符串下标）计算，因为 `term.select(col, row, len)` 的 len 是列数，
 * 而 CJK 占两列；混用会错位。
 */

/** 表格框线。CC 的表格用 U+2502，日志里也常见 ASCII 竖线。 */
const VERTICAL_RULES = new Set(["|", "│", "┃", "║", "┆", "┊", "┇", "┋"]);
/** 半角 + 全角空格（有些表格用 U+3000 对齐）。 */
const BLANKS = new Set([" ", "\u3000"]);

export interface CellRange {
  /** 起始列（0-based，终端格） */
  start: number;
  /** 跨越的列数（≥1） */
  length: number;
}

/**
 * 单字符占几列（East Asian Width 的简化版）。
 * 组合记号/变体选择符返回 0：它们并进前一格，不额外占列。
 */
export function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** 把一行文本摊成「列 → 该格的首字符」，宽字符的右半格记 null。 */
export function toColumns(text: string): (string | null)[] {
  const cols: (string | null)[] = [];
  for (const ch of text) {
    const w = cellWidth(ch);
    if (w === 0) {
      // 组合记号并进前一格：不新增列
      const last = cols.length - 1;
      if (last >= 0) cols[last] = `${cols[last] ?? ""}${ch}`;
      continue;
    }
    cols.push(ch);
    for (let i = 1; i < w; i++) cols.push(null);
  }
  return cols;
}

/**
 * 该列是不是「空白」。
 * 🔴 `null` 是宽字符的右半格，**不是空白**——把它当空白会把「修改」这类中文
 * 从中间截断（选出来只剩「修」）。
 */
function isBlank(cols: (string | null)[], i: number): boolean {
  const ch = cols[i];
  return ch !== null && BLANKS.has(ch);
}

/** 宽字符的右半格不是合法起点，退回它所在的整字。 */
function alignStart(cols: (string | null)[], i: number): number {
  return i > 0 && cols[i] === null && cols[i - 1] !== null ? i - 1 : i;
}

/** 结束列落在宽字符本体上时补上它的右半格，避免截半个字。 */
function alignEnd(cols: (string | null)[], i: number): number {
  return i + 1 < cols.length && cols[i + 1] === null && cols[i] !== null ? i + 1 : i;
}

function trimSpan(cols: (string | null)[], from: number, to: number): CellRange | null {
  let s = from;
  let e = to;
  while (s <= e && isBlank(cols, s)) s++;
  while (e >= s && isBlank(cols, e)) e--;
  if (e < s) return null;
  s = alignStart(cols, s);
  e = alignEnd(cols, e);
  return { start: s, length: e - s + 1 };
}

/**
 * 以 `at` 为种子向两侧扩出一个字段：遇到「连续 ≥ minGap 个空白」即边界。
 * 点在填充空白上时吸附到更近的一侧（等距取右 —— 表格的填充通常在单元格右侧）。
 * 返回的区间首尾一定落在非空白列上。
 */
function findField(cols: (string | null)[], at: number, minGap: number): CellRange | null {
  const n = cols.length;
  if (n === 0) return null;
  let seed = Math.max(0, Math.min(at, n - 1));
  if (isBlank(cols, seed)) {
    let l = seed;
    while (l >= 0 && isBlank(cols, l)) l--;
    let r = seed;
    while (r < n && isBlank(cols, r)) r++;
    if (l < 0 && r >= n) return null;
    const gap = r - l - 1;
    if (l < 0) seed = r;
    else if (r >= n) seed = l;
    else if (gap < minGap) seed = l; // 字段内部的空格：并进左段
    else seed = seed - l <= r - seed ? r : l;
  }
  seed = alignStart(cols, seed);
  if (seed < 0 || seed >= n || isBlank(cols, seed)) return null;

  let s = seed;
  let e = seed;
  while (s > 0) {
    if (!isBlank(cols, s - 1)) {
      s--;
      continue;
    }
    let k = s - 1;
    while (k >= 0 && isBlank(cols, k)) k--;
    if (k < 0 || s - 1 - k >= minGap) break;
    s = k;
  }
  while (e < n - 1) {
    if (!isBlank(cols, e + 1)) {
      e++;
      continue;
    }
    let k = e + 1;
    while (k < n && isBlank(cols, k)) k++;
    if (k >= n || k - e - 1 >= minGap) break;
    e = k;
  }
  s = alignStart(cols, s);
  e = alignEnd(cols, e);
  return { start: s, length: e - s + 1 };
}

/** 该行是否「像表格」：竖线够多，或存在两处以上连续双空格（对齐列的特征）。 */
function looksTabular(cols: (string | null)[]): boolean {
  let rules = 0;
  let gaps = 0;
  for (let i = 0; i < cols.length; i++) {
    const ch = cols[i];
    if (ch !== null && VERTICAL_RULES.has(ch)) rules++;
    if (isBlank(cols, i)) {
      let j = i;
      while (j < cols.length && isBlank(cols, j)) j++;
      if (j - i >= 2) gaps++;
      i = j - 1;
    }
  }
  return rules >= 2 || gaps >= 2;
}

/** 该行是否「表格/对齐列」文本 —— 决定裸 shell 里双击要不要接管（普通文本交回 xterm 选词）。 */
export function isTabularLine(text: string): boolean {
  return looksTabular(toColumns(text));
}

/**
 * 求 `col` 处应选中的单元格列区间；整行空白/越界返回 null。
 * `text` 传 `IBufferLine.translateToString(true)`（已去行尾空白）。
 */
export function resolveCellRange(text: string, col: number): CellRange | null {
  const cols = toColumns(text);
  if (cols.length === 0) return null;
  const at = Math.max(0, Math.min(col, cols.length - 1));

  // ① 竖线优先：表格的框线是硬边界，比空白可靠
  const rules: number[] = [];
  for (let i = 0; i < cols.length; i++) {
    const ch = cols[i];
    if (ch !== null && VERTICAL_RULES.has(ch)) rules.push(i);
  }
  if (rules.length >= 2) {
    let left = -1;
    for (const r of rules) {
      if (r <= at) left = r;
      else break;
    }
    const right = rules.find((r) => r > at);
    if (left >= 0 && right !== undefined) {
      const span = trimSpan(cols, left + 1, right - 1);
      if (span) return span;
    }
  }

  // ② 对齐文本按双空格切列；③ 普通文本按单词切
  return findField(cols, at, looksTabular(cols) ? 2 : 1);
}

/** 视口内像素坐标 → buffer 绝对行 + 列。取不到（元素未布局、缺字段）返回 null。 */
export function bufferCellFromPoint(
  term: Terminal,
  container: HTMLElement,
  clientX: number,
  clientY: number,
): { row: number; col: number } | null {
  const screen = term.element?.querySelector?.(".xterm-screen") as HTMLElement | null | undefined;
  const el = screen ?? container;
  if (typeof el.getBoundingClientRect !== "function") return null;
  const rect = el.getBoundingClientRect();
  const cols = term.cols;
  const rows = term.rows;
  if (!rect.width || !rect.height || !cols || !rows) return null;
  const x = Math.floor((clientX - rect.left) / (rect.width / cols));
  const y = Math.floor((clientY - rect.top) / (rect.height / rows));
  if (x < 0 || y < 0 || x >= cols || y >= rows) return null;
  return { col: x, row: term.buffer.active.viewportY + y };
}

export interface CellDoubleClickOptions {
  /** 额外的生效条件（如「手动选择模式」开着）。鼠标追踪开着时总是生效。 */
  isEnabled?: () => boolean;
  /** 选中后回调（拿到的是 `term.getSelection()` 的文本）。 */
  onSelected?: (text: string) => void;
}

/**
 * 挂「双击选中单元格」。返回注销函数。
 *
 * 🔴 只拦 `detail === 2` 的那次 mousedown：第一次点击是普通点击（TUI 的定位/交互），
 * 拦掉会让单击也失效。停止传播是为了不让 xterm 把它当鼠标报告发给远端。
 * 🔴 用 `stopImmediatePropagation`（而非 stopPropagation）：调用方必须**先**注册本监听，
 * 才能连带挡掉同容器上的「选择模式起手」——否则那边会再合成一次 mousedown，
 * 把刚设好的单元格选区冲成线性选区。
 */
export function attachCellDoubleClick(
  term: Terminal,
  container: HTMLElement,
  opts: CellDoubleClickOptions = {},
): () => void {
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0 || e.detail !== 2) return;
    const at = bufferCellFromPoint(term, container, e.clientX, e.clientY);
    if (!at) return;
    const line = term.buffer.active.getLine(at.row);
    if (!line) return;
    const text = line.translateToString(true);
    // 裸 shell（没有鼠标追踪、也没开选择模式）只接管表格行：普通文本继续走 xterm 原生
    // 双击选词，别把用户习惯换掉。
    if (!mouseTrackingActive(term) && !opts.isEnabled?.() && !isTabularLine(text)) return;
    // 先拦事件：xterm 的 mousedown 在子元素上，容器捕获阶段停掉就传不过去
    e.preventDefault();
    e.stopImmediatePropagation();
    // 这一按已被本地接管：告诉按下闸别再补重放点击（重放会 fire onUserInput → clearSelection，
    // 把下面刚选好的单元格清掉）。
    markDownConsumed(term);
    // 拦掉 mousedown 也就拦掉了 xterm 自己的聚焦路径：双击后立刻敲键盘必须还能输入
    term.focus();
    const range = resolveCellRange(text, at.col);
    if (!range) {
      // 点在空白/边框上：等同于「取消选中」，别留着上一次的选区让人误以为复制它
      term.clearSelection();
      return;
    }
    term.select(range.start, at.row, range.length);
    const sel = term.getSelection();
    if (sel) opts.onSelected?.(sel);
  };
  container.addEventListener("mousedown", onDown, true);
  return () => container.removeEventListener("mousedown", onDown, true);
}
