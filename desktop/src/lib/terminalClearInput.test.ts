import { describe, expect, it } from "vitest";
import { countCharsToClear, MAX_CLEAR_CHARS } from "./terminalClearInput";

describe("countCharsToClear", () => {
  it("普通屏只清光标所在行，不向上累加命令输出", () => {
    expect(
      countCharsToClear({
        cursorLine: "$ git commit -m x", // 17
        cursorX: 17,
        crossLine: false,
        // 上面是上一个命令的输出：哪怕给了也不能算进去
        upwardLines: ["total 12", "drwxr-xr-x 1 user 197609 0 Nov  2 21:00 ."],
      }),
    ).toBe(17);
  });

  it("备用屏（全屏 TUI）向上跨行累计", () => {
    expect(
      countCharsToClear({
        cursorLine: "> hello world", // 13
        cursorX: 13,
        crossLine: true,
        upwardLines: ["> first line"], // 12
      }),
    ).toBe(25);
  });

  it("遇到输入框上边框就停", () => {
    expect(
      countCharsToClear({
        cursorLine: "> hello world",
        cursorX: 13,
        crossLine: true,
        upwardLines: ["──────────────", "> 这段在输入框外面，不该算"],
      }),
    ).toBe(13);
  });

  it("遇到空行就停（输入区到顶）", () => {
    expect(
      countCharsToClear({
        cursorLine: "> hello",
        cursorX: 7,
        crossLine: true,
        upwardLines: ["", "> 对话内容，不该算"],
      }),
    ).toBe(7);
  });

  it("光标行整行是框线且没有上行时返回 0", () => {
    expect(
      countCharsToClear({
        cursorLine: "──────────────",
        cursorX: 14,
        crossLine: true,
        upwardLines: [],
      }),
    ).toBe(0);
  });

  it("发出去的按键数有上限，判据失效也不会刷屏", () => {
    const long = "x".repeat(MAX_CLEAR_CHARS * 2);
    expect(
      countCharsToClear({
        cursorLine: "",
        cursorX: 5,
        crossLine: true,
        upwardLines: [long, long],
      }),
    ).toBe(MAX_CLEAR_CHARS);
  });

  it("行尾空白不算入（translateToString(true) 已修剪）", () => {
    expect(
      countCharsToClear({
        cursorLine: "> hi",
        cursorX: 4,
        crossLine: true,
        upwardLines: ["> ab"],
      }),
    ).toBe(8);
  });
});
