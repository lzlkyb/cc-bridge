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

  it("备用屏 + 输入框竖线：向上跨行累计（Claude Code 的多行输入）", () => {
    expect(
      countCharsToClear({
        cursorLine: "│ > hello world │",
        cursorX: 15,
        crossLine: true,
        upwardLines: ["│ > first line │"], // 16
      }),
    ).toBe(31);
  });

  it("遇到输入框上边框就停", () => {
    expect(
      countCharsToClear({
        cursorLine: "│ > hello world │",
        cursorX: 13,
        crossLine: true,
        upwardLines: ["╭──────────────╮", "│ 这段在输入框外面，不该算 │"],
      }),
    ).toBe(13);
  });

  it("遇到空行就停（输入区到顶）", () => {
    expect(
      countCharsToClear({
        cursorLine: "│ > hello │",
        cursorX: 7,
        crossLine: true,
        upwardLines: ["", "│ 对话内容，不该算 │"],
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
    const long = `│${"x".repeat(MAX_CLEAR_CHARS * 2)}│`;
    expect(
      countCharsToClear({
        cursorLine: "│",
        cursorX: 5,
        crossLine: true,
        upwardLines: [long, long],
      }),
    ).toBe(MAX_CLEAR_CHARS);
  });

  it("行尾空白不算入（translateToString(true) 已修剪）", () => {
    expect(
      countCharsToClear({
        cursorLine: "│ > hi │",
        cursorX: 4,
        crossLine: true,
        upwardLines: ["│ > ab │"], // 8
      }),
    ).toBe(12);
  });

  it("🔴 vim/nano 插入模式（备用屏但没有输入框竖线）：只清光标行，不向上删文件正文", () => {
    expect(
      countCharsToClear({
        cursorLine: "  return a + b;",
        cursorX: 15,
        crossLine: true,
        upwardLines: ["function sum(a, b) {", "// 求和"],
      }),
    ).toBe(15);
  });

  it("🔴 光标行带竖线但上行是正文（编辑器里的表格）：到无竖线那行即停", () => {
    expect(
      countCharsToClear({
        cursorLine: "│ a │ b │",
        cursorX: 5,
        crossLine: true,
        upwardLines: ["表头说明文字", "│ c │ d │"],
      }),
    ).toBe(5);
  });

  it("半角 | 不算输入框证据（shell 管道 / 正文里的竖线）", () => {
    expect(
      countCharsToClear({
        cursorLine: "cat a | grep b",
        cursorX: 14,
        crossLine: true,
        upwardLines: ["x | y"],
      }),
    ).toBe(14);
  });
});