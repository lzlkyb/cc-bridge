import { describe, expect, it, vi } from "vitest";
import {
  buildOscColorReply,
  createOscQueryResponder,
  hexToOscRgb,
  type OscQueryColors,
} from "./terminalOscQuery";

const LIGHT: OscQueryColors = { fg: "#24292f", bg: "#ffffff" };

/** 便捷构造：颜色固定、收集回写。 */
function make(colors: OscQueryColors = LIGHT) {
  const replies: string[] = [];
  const r = createOscQueryResponder({
    colors: () => colors,
    reply: (d) => replies.push(d),
  });
  return { r, replies };
}

describe("hexToOscRgb", () => {
  it("六位 hex → rgb:rrrr/gggg/bbbb（每通道扩成 4 位）", () => {
    expect(hexToOscRgb("#ffffff")).toBe("rgb:ffff/ffff/ffff");
    expect(hexToOscRgb("#1e1e1e")).toBe("rgb:1e1e/1e1e/1e1e");
    expect(hexToOscRgb("#0b110b")).toBe("rgb:0b0b/1111/0b0b");
  });

  it("三位 hex 逐位翻倍；大小写与首尾空白容忍", () => {
    expect(hexToOscRgb("#f4a")).toBe("rgb:ffff/4444/aaaa");
    expect(hexToOscRgb(" #ABCDEF ")).toBe("rgb:abab/cdcd/efef");
    expect(hexToOscRgb("#AB12CD")).toBe("rgb:abab/1212/cdcd");
  });

  it("非法输入返回 null（不抛异常）", () => {
    expect(hexToOscRgb("")).toBeNull();
    expect(hexToOscRgb("ffffff")).toBeNull();
    expect(hexToOscRgb("#12345")).toBeNull();
    expect(hexToOscRgb("#12345g")).toBeNull();
  });
});

describe("buildOscColorReply", () => {
  it("OSC 10/11 分别应答前景/背景，ST 结尾", () => {
    expect(buildOscColorReply(10, "#24292f")).toBe("\x1b]10;rgb:2424/2929/2f2f\x1b\\");
    expect(buildOscColorReply(11, "#ffffff")).toBe("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
  });

  it("颜色非法返回 null", () => {
    expect(buildOscColorReply(11, "nope")).toBeNull();
  });
});

describe("createOscQueryResponder · feed", () => {
  it("OSC 11 查询（BEL 结尾）：剥离 + 用 bg 应答，其余输出原样保留", () => {
    const { r, replies } = make();
    expect(r.feed("hello\x1b]11;?\x07world")).toBe("helloworld");
    expect(replies).toEqual(["\x1b]11;rgb:ffff/ffff/ffff\x1b\\"]);
  });

  it("OSC 10 查询（ST 结尾）：用 fg 应答", () => {
    const { r, replies } = make();
    expect(r.feed("\x1b]10;?\x1b\\x")).toBe("x");
    expect(replies).toEqual(["\x1b]10;rgb:2424/2929/2f2f\x1b\\"]);
  });

  it("合并查询 ESC]10;?ESC]11;?ST：两个都应答、全部剥离", () => {
    const { r, replies } = make();
    expect(r.feed("\x1b]10;?\x1b]11;?\x1b\\")).toBe("");
    expect(replies).toHaveLength(2);
    expect(replies[0]).toContain("]10;");
    expect(replies[1]).toContain("]11;");
  });

  it("查询前后的多段文本顺序保持、多条查询逐条应答", () => {
    const { r, replies } = make();
    expect(r.feed("a\x1b]11;?\x07b\x1b]11;?\x07c")).toBe("abc");
    expect(replies).toHaveLength(2);
  });

  it("跨 chunk 分裂：前缀被扣住不发，拼齐后剥离并应答", () => {
    const { r, replies } = make();
    expect(r.feed("pre\x1b]1")).toBe("pre"); // "\x1b]1" 是查询前缀，扣住
    expect(r.feed("1;?\x07post")).toBe("post"); // 拼齐 → 剥离 + 应答
    expect(replies).toEqual(["\x1b]11;rgb:ffff/ffff/ffff\x1b\\"]);
  });

  it("跨 chunk 分裂（ST 结尾、分在两半）", () => {
    const { r, replies } = make();
    expect(r.feed("\x1b]11;?\x1b")).toBe("");
    expect(r.feed("\\end")).toBe("end");
    expect(replies).toHaveLength(1);
  });

  it("形似而不同的序列原样透传（OSC 12、无 ? 的 OSC 11）", () => {
    const { r, replies } = make();
    expect(r.feed("\x1b]12;?\x07\x1b]11;1\x07tail")).toBe("\x1b]12;?\x07\x1b]11;1\x07tail");
    expect(replies).toEqual([]);
  });

  it("查询不是唯一内容时，前缀扣留不吞掉后续普通文本", () => {
    const { r, replies } = make();
    expect(r.feed("\x1b]1")).toBe("");
    // 扣住的 "\x1b]1" 拼上后构成 "\x1b]12 …"——不是查询，原样放出。
    expect(r.feed("2 title\x07done")).toBe("\x1b]12 title\x07done");
    expect(replies).toEqual([]);
  });

  it("应答颜色取查询到达时刻的 colors()（主题热切换后跟随）", () => {
    const colors = { ...LIGHT };
    const replies: string[] = [];
    const r = createOscQueryResponder({ colors: () => colors, reply: (d) => replies.push(d) });
    r.feed("\x1b]11;?\x07");
    colors.bg = "#1e1e1e";
    r.feed("\x1b]11;?\x07");
    expect(replies[0]).toContain("rgb:ffff");
    expect(replies[1]).toContain("rgb:1e1e");
  });

  it("回复回调确实被调用（接线方用它的返回值回写 ssh 通道）", () => {
    const reply = vi.fn();
    const r = createOscQueryResponder({ colors: () => LIGHT, reply });
    r.feed("\x1b]11;?\x07");
    expect(reply).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line no-control-regex -- 断言应答以 ESC ]11; 开头，\x1b 是协议常量
    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/^\x1b\]11;/));
  });
});
