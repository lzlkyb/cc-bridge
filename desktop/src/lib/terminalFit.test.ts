import { describe, it, expect } from "vitest";
import { rowsToDrop } from "./terminalFit";

// 以 30 行 × 17px 行高 = 510px 内容为基准造例。
const ROWS = 30;
const CELL = 17;
const CONTENT = ROWS * CELL; // 510

describe("rowsToDrop", () => {
  it("刚好装下时不动", () => {
    expect(rowsToDrop(CONTENT, CONTENT, ROWS)).toBe(0);
  });

  it("容器比内容高（底部有富余）时不动", () => {
    expect(rowsToDrop(CONTENT, CONTENT + 12, ROWS)).toBe(0);
  });

  it("溢出半行 → 退一行（就是「最后一行被切掉一半」那个场景）", () => {
    expect(rowsToDrop(CONTENT, CONTENT - CELL / 2, ROWS)).toBe(1);
  });

  it("溢出整一行 → 退一行", () => {
    expect(rowsToDrop(CONTENT, CONTENT - CELL, ROWS)).toBe(1);
  });

  it("溢出 2.5 行 → 一次退 3 行，不靠多轮收敛", () => {
    expect(rowsToDrop(CONTENT, CONTENT - CELL * 2.5, ROWS)).toBe(3);
  });

  // 回归防护：这条在没有容差（FIT_OVERFLOW_TOLERANCE_PX = 0）时会返回 1 而挂掉。
  // 布局高度在 125% 缩放下普遍带小数，两个盒子各自舍入就能差出不足 1px，
  // 把它当真溢出会白白退掉一整行。
  it("亚像素误差（小于 1px）不算溢出", () => {
    expect(rowsToDrop(CONTENT + 0.6, CONTENT, ROWS)).toBe(0);
    expect(rowsToDrop(CONTENT + 1, CONTENT, ROWS)).toBe(0);
  });

  it("超过容差就算溢出", () => {
    expect(rowsToDrop(CONTENT + 1.5, CONTENT, ROWS)).toBe(1);
  });

  it("容器被隐藏（高度 0）时不动——切会话/切 tab 都是 display:none", () => {
    expect(rowsToDrop(0, 0, ROWS)).toBe(0);
    expect(rowsToDrop(CONTENT, 0, ROWS)).toBe(0);
    expect(rowsToDrop(0, CONTENT, ROWS)).toBe(0);
  });

  it("只剩一行时不退（退到 0 行会把终端弄成无效尺寸）", () => {
    expect(rowsToDrop(100, 10, 1)).toBe(0);
  });

  it("即使溢出得离谱，也至少给终端留 1 行", () => {
    // 容器只有 1px，按实测行高算出来该退 30 行，但上限是 rows-1。
    expect(rowsToDrop(CONTENT, 1, ROWS)).toBe(ROWS - 1);
  });

  it("异常入参（NaN / 负数）不会算出奇怪结果", () => {
    expect(rowsToDrop(NaN, CONTENT, ROWS)).toBe(0);
    expect(rowsToDrop(CONTENT, NaN, ROWS)).toBe(0);
    expect(rowsToDrop(-10, CONTENT, ROWS)).toBe(0);
  });
});
