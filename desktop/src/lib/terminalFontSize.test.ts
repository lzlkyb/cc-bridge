import { describe, it, expect } from "vitest";
import {
  clampFontSize,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_DEFAULT,
} from "./terminalFontSize";

describe("clampFontSize", () => {
  it("区间内原样返回", () => {
    expect(clampFontSize(13)).toBe(13);
    expect(clampFontSize(FONT_SIZE_MIN)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(FONT_SIZE_MAX)).toBe(FONT_SIZE_MAX);
  });

  it("越界夹到边界（而不是报错或返回默认值）", () => {
    expect(clampFontSize(1)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(999)).toBe(FONT_SIZE_MAX);
    expect(clampFontSize(-20)).toBe(FONT_SIZE_MIN);
  });

  it("取整：字号必须是整数，否则行高会带出亚像素对齐问题", () => {
    expect(clampFontSize(13.4)).toBe(13);
    expect(clampFontSize(13.6)).toBe(14);
  });

  it("非法值回默认值", () => {
    expect(clampFontSize(NaN)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(Infinity)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(Number("abc"))).toBe(FONT_SIZE_DEFAULT);
  });
});
