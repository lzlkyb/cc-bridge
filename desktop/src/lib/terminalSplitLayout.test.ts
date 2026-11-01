import { describe, expect, it } from "vitest";
import { clampSplitRatio, defaultSplitDirection } from "./terminalSplitLayout";

describe("split size constraints", () => {
  it("首次分屏按可用终端宽度选择方向", () => {
    expect(defaultSplitDirection(725)).toBe("v");
    expect(defaultSplitDirection(726)).toBe("h");
    expect(defaultSplitDirection(0)).toBe("h");
  });
  it("限制每格的像素宽高", () => {
    expect(clampSplitRatio(20, 1006, "h")).toBe(36);
    expect(clampSplitRatio(80, 1006, "h")).toBe(64);
    expect(clampSplitRatio(20, 406, "v")).toBe(40);
    expect(clampSplitRatio(80, 406, "v")).toBe(60);
  });

  it("🔴 窄到放不下像素下限时也不能锁死 50/50（手柄必须还能拖）", () => {
    // 可用宽 494 < 2×360：以前 edge 被夹到 50，区间退化成 [50,50]，手柄拖不动。
    expect(clampSplitRatio(20, 500, "h")).toBe(25);
    expect(clampSplitRatio(80, 500, "h")).toBe(75);
    const v = clampSplitRatio(70, 200, "v"); // 可用高 194 < 2×160
    expect(v).toBe(70);
    expect(clampSplitRatio(5, 200, "v")).toBe(25);
  });
});
