import { describe, expect, it } from "vitest";
import {
  compactDiff,
  computeLineDiff,
  computeWordDiff,
  pairDiffRows,
  type DiffLine,
  type WordSeg,
} from "./ccDiff";

const stats = (d: ReturnType<typeof computeLineDiff>) => `${d.added}/${d.removed}`;

describe("computeLineDiff", () => {
  it("单行改动算准 +1/−1", () => {
    const oldText = ["a", "b", "c", "d", "e"].join("\n");
    const newText = ["a", "b", "C", "d", "e"].join("\n");
    const d = computeLineDiff(oldText, newText);
    expect(stats(d)).toBe("1/1");
    expect(d.truncated).toBe(false);
  });

  it("分散的多处改动不退化成整段替换（desktop-cc-gui 的老坑）", () => {
    const oldLines = Array.from({ length: 60 }, (_, i) => `L${i}`);
    const newLines = [...oldLines];
    newLines[10] = "X";
    newLines[30] = "Y";
    newLines[50] = "Z";
    const d = computeLineDiff(oldLines.join("\n"), newLines.join("\n"));
    expect(stats(d)).toBe("3/3");
    // 中间未改动的行必须保留成 ctx，而不是被吞进 add/del
    expect(d.lines.filter((l) => l.kind === "ctx").length).toBe(57);
  });

  it("行号在增删之间正确递进", () => {
    const d = computeLineDiff("a\nb\nc", "a\nB1\nB2\nc");
    expect(d.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["ctx", 3, 4],
    ]);
  });

  it("纯新增（旧内容为空）只出 add 行", () => {
    const d = computeLineDiff("", "x\ny");
    expect(stats(d)).toBe("2/0");
    expect(d.lines.every((l) => l.kind === "add")).toBe(true);
  });

  it("纯删除（新内容为空）只出 del 行", () => {
    const d = computeLineDiff("x\ny", "");
    expect(stats(d)).toBe("0/2");
    expect(d.lines.every((l) => l.kind === "del")).toBe(true);
  });

  it("完全相同时全是 ctx、零改动", () => {
    const d = computeLineDiff("a\nb", "a\nb");
    expect(stats(d)).toBe("0/0");
    expect(d.lines.every((l) => l.kind === "ctx")).toBe(true);
  });

  it("末尾换行不产生幽灵空行", () => {
    const d = computeLineDiff("a\nb\n", "a\nb\n");
    expect(d.lines.length).toBe(2);
  });

  it("超出 LCS 预算时降级并置 truncated", () => {
    const big = Array.from({ length: 1200 }, (_, i) => `old${i}`).join("\n");
    const other = Array.from({ length: 1200 }, (_, i) => `new${i}`).join("\n");
    const d = computeLineDiff(big, other);
    expect(d.truncated).toBe(true);
    expect(d.added).toBe(1200);
    expect(d.removed).toBe(1200);
  });
});

describe("compactDiff", () => {
  it("改动点之外的远端上下文被折叠成 gap", () => {
    const oldLines = Array.from({ length: 40 }, (_, i) => `L${i}`);
    const newLines = [...oldLines];
    newLines[20] = "CHANGED";
    const compact = compactDiff(computeLineDiff(oldLines.join("\n"), newLines.join("\n")), 2);

    const gaps = compact.filter((l) => l.kind === "gap") as Array<{ count: number }>;
    expect(gaps.length).toBe(2);
    // 40 行 ctx + 1 del + 1 add = 41 行；改动落在 del(20)/add(21)，
    // 保留下标 18..23 共 6 行 ⇒ 前折 18 行、后折 17 行（del/add 各占一行导致两边不对称）。
    expect(gaps[0].count).toBe(18);
    expect(gaps[1].count).toBe(17);
    // 保留改动点前后各 2 行 + 改动本身 2 行
    expect(compact.filter((l) => l.kind !== "gap").length).toBe(6);
  });

  it("无改动且行数少时原样返回", () => {
    const d = computeLineDiff("a\nb", "a\nb");
    expect(compactDiff(d, 3).length).toBe(2);
  });

  it("无改动且行数多时折成首行 + gap + 末行", () => {
    const text = Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n");
    const compact = compactDiff(computeLineDiff(text, text), 3);
    expect(compact.length).toBe(3);
    expect(compact[1]).toEqual({ kind: "gap", count: 28 });
  });
});

const joined = (segs: WordSeg[]) => segs.map((s) => s.text).join("");
const changedOf = (segs: WordSeg[]) => segs.filter((s) => s.changed).map((s) => s.text);

describe("computeWordDiff", () => {
  it("只标出改动的词，前后文的空格一并保留原样", () => {
    const d = computeWordDiff("const w = 1;", "const width = 1;");
    expect(d.oldSegs).toEqual([
      { text: "const ", changed: false },
      { text: "w", changed: true },
      { text: " = 1;", changed: false },
    ]);
    expect(d.newSegs).toEqual([
      { text: "const ", changed: false },
      { text: "width", changed: true },
      { text: " = 1;", changed: false },
    ]);
  });

  it("拼回去必须与原文逐字符相等（定案 3 的前提：不吞空格与标点）", () => {
    const cases: Array<[string, string]> = [
      ["const a = b.slice(0, 1);  // 取首段", "const a = b.slice(0, 2);  // 取首段"],
      ["\tif (x) { return; }", "\tif (y) { return; }"],
      ["", "x"],
      ["abc", ""],
      ["  ", "    "],
      ["中文注释", "中文注解"],
    ];
    for (const [o, n] of cases) {
      const d = computeWordDiff(o, n);
      expect(joined(d.oldSegs)).toBe(o);
      expect(joined(d.newSegs)).toBe(n);
    }
  });

  it("中文按字切：换一个字就只高亮那一个字", () => {
    const d = computeWordDiff("// 计算旧行号与新行号", "// 计算旧行号和新行号");
    expect(changedOf(d.oldSegs)).toEqual(["与"]);
    expect(changedOf(d.newSegs)).toEqual(["和"]);
  });

  it("空行没有词序列：空的那侧给空片段，另一侧整行标 changed", () => {
    const d = computeWordDiff("", "x");
    expect(d.oldSegs).toEqual([]);
    expect(d.newSegs).toEqual([{ text: "x", changed: true }]);
  });

  it("毫无公共词时两侧整行标 changed", () => {
    const d = computeWordDiff("abc", "xyz");
    expect(d.oldSegs).toEqual([{ text: "abc", changed: true }]);
    expect(d.newSegs).toEqual([{ text: "xyz", changed: true }]);
  });
});

describe("pairDiffRows", () => {
  it("ctx 独行、gap 透传", () => {
    const ctx: DiffLine = { kind: "ctx", text: "a", oldNo: 1, newNo: 1 };
    const hunks = pairDiffRows([ctx, { kind: "gap", count: 3 }]);
    expect(hunks).toEqual([{ kind: "ctx", line: ctx }, { kind: "gap", count: 3 }]);
  });

  it("相邻 del+add 配对并给出词级片段", () => {
    const d = computeLineDiff("a\nold\nb", "a\nnew\nb");
    const hunks = pairDiffRows(compactDiff(d, 2));
    const change = hunks.find((h) => h.kind === "change");
    if (!change || change.kind !== "change") throw new Error("没有 change 段");
    expect(change.pairs.length).toBe(1);
    expect(change.pairs[0].old?.text).toBe("old");
    expect(change.pairs[0].new?.text).toBe("new");
    expect(change.pairs[0].words).toBeDefined();
  });

  it("del 后面没有紧跟 add ⇒ 单边行，不算词级（跨行不配对）", () => {
    const del: DiffLine = { kind: "del", text: "x", oldNo: 1, newNo: null };
    expect(pairDiffRows([del])).toEqual([
      { kind: "change", pairs: [{ old: del, new: null }] },
    ]);
  });

  it("ad 单独出现（前面没有 del）也是单边行", () => {
    const add: DiffLine = { kind: "add", text: "y", oldNo: null, newNo: 1 };
    const hunks = pairDiffRows([add]);
    if (hunks[0].kind !== "change") throw new Error("不是 change 段");
    expect(hunks[0].pairs).toEqual([{ old: null, new: add }]);
  });

  it("多行 del 块与 add 块按位置配对，多出来的成单边行", () => {
    const d1: DiffLine = { kind: "del", text: "d1", oldNo: 1, newNo: null };
    const d2: DiffLine = { kind: "del", text: "d2", oldNo: 2, newNo: null };
    const a1: DiffLine = { kind: "add", text: "a1", oldNo: null, newNo: 1 };
    const hunks = pairDiffRows([d1, d2, a1]);
    if (hunks[0].kind !== "change") throw new Error("不是 change 段");
    expect(hunks[0].pairs.map((p) => [p.old?.text ?? null, p.new?.text ?? null])).toEqual([
      ["d1", "a1"],
      ["d2", null],
    ]);
  });

  it("空行不配对：位置照配，但不做词级", () => {
    const del: DiffLine = { kind: "del", text: "", oldNo: 1, newNo: null };
    const add: DiffLine = { kind: "add", text: "x", oldNo: null, newNo: 1 };
    const hunks = pairDiffRows([del, add]);
    if (hunks[0].kind !== "change") throw new Error("不是 change 段");
    expect(hunks[0].pairs[0].words).toBeUndefined();
  });
});
