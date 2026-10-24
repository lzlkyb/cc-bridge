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
