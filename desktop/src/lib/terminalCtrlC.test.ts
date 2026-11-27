import { describe, expect, it } from "vitest";
import { CTRL_C_COPIES_SELECTION, decideCtrlC, stripInterruptBytes } from "./terminalCtrlC";

/**
 * 守卫测试：每条断言都必须能因为「删掉对应分支/改错顺序」而变红。
 * 变异验证记录见 `docs/终端CtrlC误中断-2026-11-27.md`。
 */
describe("Ctrl+C 语义裁决", () => {
  it("输入法组合期一律本地吞掉——连有选区也不算复制，更不能发 \\x03", () => {
    expect(decideCtrlC({ hasSelection: true, composing: true })).toBe("swallow");
    expect(decideCtrlC({ hasSelection: false, composing: true })).toBe("swallow");
  });

  it("组合判定必须优先于选区判定——顺序颠倒时上一组用例会失败，这条钉住顺序", () => {
    // composing=true + hasSelection=true 是唯一能区分两条分支顺序的组合：
    // 若先判选区，会返回 copy（把拼音组合期的 ^C 当复制），断言在这里变红。
    expect(decideCtrlC({ hasSelection: true, composing: true, copiesSelection: true })).toBe("swallow");
  });

  it("有 live 选区 ⇒ 复制（不发字节）", () => {
    expect(decideCtrlC({ hasSelection: true, composing: false })).toBe("copy");
  });

  it("没有选区 ⇒ 原样放行，由 xterm 发 \\x03", () => {
    expect(decideCtrlC({ hasSelection: false, composing: false })).toBe("interrupt");
  });

  it("复制语义关掉时回到老行为：有选区也照样中断", () => {
    expect(decideCtrlC({ hasSelection: true, composing: false, copiesSelection: false })).toBe("interrupt");
  });

  it("默认开关是「开」——否则本次修复对用户不生效", () => {
    expect(CTRL_C_COPIES_SELECTION).toBe(true);
  });

  it("复制后按住不放：自动重复被吞掉（选区已清，重复不能升级成中断）", () => {
    expect(decideCtrlC({ hasSelection: false, composing: false, repeat: true, copiedInHold: true })).toBe("swallow");
    expect(decideCtrlC({ hasSelection: true, composing: false, repeat: true, copiedInHold: true })).toBe("swallow");
  });

  it("没有复制过的按住仍然连续发 \\x03——shell 里「按住 Ctrl+C 强杀」不能被削", () => {
    expect(decideCtrlC({ hasSelection: false, composing: false, repeat: true, copiedInHold: false })).toBe(
      "interrupt",
    );
    expect(decideCtrlC({ hasSelection: false, composing: false, repeat: true })).toBe("interrupt");
  });
});

describe("重放前的控制字节剥离", () => {
  it("剥掉 ^C / ^\\ / ^Z，其余字节原样保留", () => {
    expect(stripInterruptBytes("\x03ls\r")).toBe("ls\r");
    expect(stripInterruptBytes("a\x1ab\x1cc")).toBe("abc");
  });

  it("不碰 ESC 序列与普通按键——退格、方向键、中文都不能被改写", () => {
    const seq = "\x1b[A\x7f中";
    expect(stripInterruptBytes(seq)).toBe(seq);
  });

  it("空串与纯控制串", () => {
    expect(stripInterruptBytes("")).toBe("");
    expect(stripInterruptBytes("\x03\x03")).toBe("");
  });
});
