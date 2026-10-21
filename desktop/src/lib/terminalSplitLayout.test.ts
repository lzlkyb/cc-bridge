import { describe, expect, it } from "vitest";
import { clampSplitRatio, defaultSplitDirection } from "./terminalSplitLayout";

describe("split size constraints", () => {
  it("首次分屏按可用终端宽度选择方向", () => {
    expect(defaultSplitDirection(725)).toBe("v");
    expect(defaultSplitDirection(726)).toBe("h");
    expect(defaultSplitDirection(0)).toBe("h");
  });
  it("限制每格的像素宽高，窗口过小时强制均分而不溢出", () => {
    expect(clampSplitRatio(20, 1006, "h")).toBe(36);
    expect(clampSplitRatio(80, 1006, "h")).toBe(64);
    expect(clampSplitRatio(20, 500, "h")).toBe(50);
    expect(clampSplitRatio(20, 406, "v")).toBe(40);
    expect(clampSplitRatio(80, 406, "v")).toBe(60);
    expect(clampSplitRatio(70, 200, "v")).toBe(50);
  });
});
