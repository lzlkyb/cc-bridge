import { describe, expect, it } from "vitest";
import { MESSAGE_WINDOW, windowStart } from "./ccWindow";

describe("ccWindow", () => {
  it("会话比窗口短时全量渲染", () => {
    expect(windowStart(50, MESSAGE_WINDOW)).toBe(0);
    expect(windowStart(200, MESSAGE_WINDOW)).toBe(0);
  });

  it("超长会话只画最近窗口条", () => {
    expect(windowStart(800, MESSAGE_WINDOW)).toBe(600);
    expect(windowStart(201, 200)).toBe(1);
  });

  it("Infinity 即回到全量（回退开关）", () => {
    expect(windowStart(800, Infinity)).toBe(0);
  });

  it("窗口容量非法时至少留一条，不能切出空白界面", () => {
    expect(windowStart(10, 0)).toBe(9);
    expect(windowStart(10, -5)).toBe(9);
  });
});
