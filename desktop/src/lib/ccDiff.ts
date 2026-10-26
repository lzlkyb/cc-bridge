/**
 * 行级 diff（纯计算）。
 *
 * 用途：把 Claude Code `Edit` 工具的真实入参形状（`old_string` / `new_string`）
 * 变成可渲染的行列表。
 *
 * 🔴 为什么不照抄 desktop-cc-gui 的 `computeDiffLines`：那个实现只裁掉公共首尾，
 *    中间整段当「全删 + 全加」。实测 60 行文件改 3 处会报 +41/−41（真实 +3/−3），
 *    diff 数字错了比没有更糟。这里做正经的 LCS。
 *
 * 性能策略：先裁公共前后缀，剩下的中间段再做 LCS——绝大多数 Edit 中间段都很小。
 * 中间段超过 MAX_LCS_CELLS 才降级为整段替换（`truncated: true` 由调用方提示）。
 */

export type DiffLineKind = "ctx" | "add" | "del";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  /** 删除行/上下文行在旧文件里的 1 基行号；新增行为 null。 */
  oldNo: number | null;
  /** 新增行/上下文行在新文件里的 1 基行号；删除行为 null。 */
  newNo: number | null;
};

export type LineDiff = {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** 中间段过大、降级为整段替换时为 true。 */
  truncated: boolean;
};

/** 中间段 LCS 表的单元上限（1.44M 单元 ≈ 5.8MB Uint32，单次渲染可接受）。 */
const MAX_LCS_CELLS = 1_200_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // 末尾换行会产出一个空元素，视觉上无意义，剔掉（不影响行号，因为它后面没有行）。
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 反向填表的 LCS 矩阵：dp[i*(m+1)+j] = a[i..] 与 b[j..] 的最长公共子序列长度。 */
function buildLcsTable(a: string[], b: string[]): Uint32Array {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w;
    const next = (i + 1) * w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] =
        a[i] === b[j] ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }
  return dp;
}

export function computeLineDiff(oldText: string, newText: string): LineDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const lines: DiffLine[] = [];

  // 1. 公共前缀
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  // 2. 公共后缀（不与前缀重叠）
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  for (let i = 0; i < head; i++) {
    lines.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: i + 1 });
  }

  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);
  let oldNo = head + 1;
  let newNo = head + 1;
  let truncated = false;

  if (aMid.length > 0 && bMid.length > 0 && aMid.length * bMid.length <= MAX_LCS_CELLS) {
    const dp = buildLcsTable(aMid, bMid);
    const w = bMid.length + 1;
    let i = 0;
    let j = 0;
    while (i < aMid.length && j < bMid.length) {
      if (aMid[i] === bMid[j]) {
        lines.push({ kind: "ctx", text: aMid[i], oldNo: oldNo++, newNo: newNo++ });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        lines.push({ kind: "del", text: aMid[i], oldNo: oldNo++, newNo: null });
        i++;
      } else {
        lines.push({ kind: "add", text: bMid[j], oldNo: null, newNo: newNo++ });
        j++;
      }
    }
    for (; i < aMid.length; i++) {
      lines.push({ kind: "del", text: aMid[i], oldNo: oldNo++, newNo: null });
    }
    for (; j < bMid.length; j++) {
      lines.push({ kind: "add", text: bMid[j], oldNo: null, newNo: newNo++ });
    }
  } else {
    // 中间段过大（或只剩单侧内容）：降级为整段替换，删在前增在后。
    truncated = aMid.length > 0 && bMid.length > 0;
    for (const line of aMid) {
      lines.push({ kind: "del", text: line, oldNo: oldNo++, newNo: null });
    }
    for (const line of bMid) {
      lines.push({ kind: "add", text: line, oldNo: null, newNo: newNo++ });
    }
  }

  for (let k = 0; k < tail; k++) {
    lines.push({
      kind: "ctx",
      text: a[a.length - tail + k],
      oldNo: a.length - tail + k + 1,
      newNo: b.length - tail + k + 1,
    });
  }

  return {
    lines,
    added: lines.reduce((n, l) => n + (l.kind === "add" ? 1 : 0), 0),
    removed: lines.reduce((n, l) => n + (l.kind === "del" ? 1 : 0), 0),
    truncated,
  };
}

/**
 * 折叠上下文：只保留改动行前后各 `context` 行，其余合并成省略标记。
 * 返回 `null` 的位置代表省略段，由渲染层画成「⋯ N 行未变」。
 */
export function compactDiff(
  diff: LineDiff,
  context = 3,
): Array<DiffLine | { kind: "gap"; count: number }> {
  const keep = new Set<number>();
  diff.lines.forEach((line, i) => {
    if (line.kind === "ctx") return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.lines.length - 1, i + context); k++) {
      keep.add(k);
    }
  });
  if (keep.size === 0) {
    // 纯上下文（无改动）：只留首尾各一行，中间折叠。
    if (diff.lines.length <= context * 2) return diff.lines;
    return [
      diff.lines[0],
      { kind: "gap", count: diff.lines.length - 2 },
      diff.lines[diff.lines.length - 1],
    ];
  }
  const out: Array<DiffLine | { kind: "gap"; count: number }> = [];
  let gap = 0;
  diff.lines.forEach((line, i) => {
    if (keep.has(i)) {
      if (gap > 0) {
        out.push({ kind: "gap", count: gap });
        gap = 0;
      }
      out.push(line);
    } else {
      gap++;
    }
  });
  if (gap > 0) out.push({ kind: "gap", count: gap });
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
   词级 diff（优化轨道 A）—— 井排与单栏共用，只此一份（R11）。
   ══════════════════════════════════════════════════════════════════════ */

export type WordSeg = { text: string; changed: boolean };

export type WordDiff = { oldSegs: WordSeg[]; newSegs: WordSeg[] };

/**
 * 词 token：连续空白 / 连续 ASCII 词字符 / 其余单字符（CJK、标点、符号）。
 *
 * 🔴 token 拼回去必须与原文**逐字符相等** —— 词级高亮不允许吞掉空格或标点，
 *    否则同一行在「有高亮」和「无高亮」时宽度不同，等宽列对齐就破了（定案 3）。
 *
 * 🔴 CJK 按**单字**切，不按 `\p{L}` 连成一段：`// 计算旧行号与新行号` 里
 *    只换了「与→和」，整段标红等于没高亮；逐字才能把那一对字挑出来。
 *    拉丁词保持整词（`w` → `width` 是一个词的增补，拆成字母反而碎）。
 */
const WORD_TOKEN_RE = /\s+|[A-Za-z0-9_]+|[^\s]/gu;

/** 词级 LCS 的单元上限。压缩成一行的几千字符代码不做词级，整行标 changed 即可。 */
const MAX_WORD_CELLS = 40_000;

function tokenizeLine(line: string): string[] {
  return line.match(WORD_TOKEN_RE) ?? [];
}

function segsOf(tokens: string[], changed: (i: number) => boolean, changedCount: number): WordSeg[] {
  if (changedCount === 0) return [{ text: tokens.join(""), changed: false }];
  const out: WordSeg[] = [];
  tokens.forEach((t, i) => {
    const c = changed(i);
    const last = out[out.length - 1];
    if (last && last.changed === c) last.text += t;
    else out.push({ text: t, changed: c });
  });
  return out;
}

/**
 * 行内词级 diff：给一对 del/add 行找出「这一行相对那一行改掉了哪些词」。
 *
 * 只做**一致性**判断（两侧公共词按 LCS 保留，其余标 changed），不做语义对齐。
 * 一侧没有 token（空行）⇒ 那一侧给空片段、另一侧整行标 changed：没有词序列
 * 就谈不上「相对改了什么」。纯空白行由配对层挡掉（`pairDiffRows` 不配对空行）。
 */
export function computeWordDiff(oldLine: string, newLine: string): WordDiff {
  const a = tokenizeLine(oldLine);
  const b = tokenizeLine(newLine);

  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_WORD_CELLS) {
    return {
      oldSegs: a.length === 0 ? [] : [{ text: oldLine, changed: true }],
      newSegs: b.length === 0 ? [] : [{ text: newLine, changed: true }],
    };
  }

  const dp = buildLcsTable(a, b);
  const w = b.length + 1;
  const oldChanged = new Uint8Array(a.length);
  const newChanged = new Uint8Array(b.length);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      oldChanged[i] = 1;
      i++;
    } else {
      newChanged[j] = 1;
      j++;
    }
  }
  for (; i < a.length; i++) oldChanged[i] = 1;
  for (; j < b.length; j++) newChanged[j] = 1;

  return {
    oldSegs: segsOf(a, (k) => oldChanged[k] === 1, oldChanged.reduce((n, v) => n + v, 0)),
    newSegs: segsOf(b, (k) => newChanged[k] === 1, newChanged.reduce((n, v) => n + v, 0)),
  };
}

/** 一对可渲染的行：`old` = 改动前那侧，`new` = 改动后那侧；单侧缺失为 null。 */
export type DiffPair = {
  old: DiffLine | null;
  new: DiffLine | null;
  /** 两侧都是非空行时才有：词级片段（成对 del+add 才有意义）。 */
  words?: WordDiff;
};

/**
 * compact 后的行 → 井排可用的「行对」。
 *
 * 一个连着的 del 块 + 紧跟的 add 块按**位置**配对（第 1 个 del 对第 1 个 add），
 * 多出来的单侧成单边行。这是定案 2 的口径：只在相邻的 del+add 之间算词级，
 * 跨行不配对 —— 把不相关的两行缝在一起比不高亮更误导。
 */
export type DiffHunk =
  | { kind: "gap"; count: number }
  | { kind: "ctx"; line: DiffLine }
  | { kind: "change"; pairs: DiffPair[] };

const isBlankLine = (s: string) => s.trim() === "";

export function pairDiffRows(
  rows: Array<DiffLine | { kind: "gap"; count: number }>,
): DiffHunk[] {
  const out: DiffHunk[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === "gap") {
      out.push({ kind: "gap", count: row.count });
      i++;
      continue;
    }
    if (row.kind === "ctx") {
      out.push({ kind: "ctx", line: row });
      i++;
      continue;
    }
    if (row.kind === "add") {
      // 前面没有 del 的孤立 add：单边行，整行即新增。
      out.push({ kind: "change", pairs: [{ old: null, new: row }] });
      i++;
      continue;
    }
    // del 块 + 紧跟的 add 块，按位置配对。
    const dels: DiffLine[] = [];
    while (i < rows.length && rows[i].kind === "del") {
      dels.push(rows[i] as DiffLine);
      i++;
    }
    const adds: DiffLine[] = [];
    while (i < rows.length && rows[i].kind === "add") {
      adds.push(rows[i] as DiffLine);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    const pairs: DiffPair[] = [];
    for (let k = 0; k < n; k++) {
      const oldLine = dels[k] ?? null;
      const newLine = adds[k] ?? null;
      pairs.push({
        old: oldLine,
        new: newLine,
        words:
          oldLine && newLine && !isBlankLine(oldLine.text) && !isBlankLine(newLine.text)
            ? computeWordDiff(oldLine.text, newLine.text)
            : undefined,
      });
    }
    out.push({ kind: "change", pairs });
  }
  return out;
}
