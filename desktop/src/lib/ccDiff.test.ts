import { describe, expect, it } from "vitest";
import { compactDiff, computeLineDiff } from "./ccDiff";

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
