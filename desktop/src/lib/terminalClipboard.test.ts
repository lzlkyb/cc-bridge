import { describe, expect, it } from "vitest";
import { OSC52_MAX_PAYLOAD, parseOsc52 } from "./terminalClipboard";

/** 测试里自产 base64（走 TextEncoder+btoa，而非被测代码的 atob，避免自证）。 */
const b64 = (s: string) => {
  let bin = "";
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte);
  return btoa(bin);
};

describe("parseOsc52", () => {
  it("写剪贴板：c;<base64> 解出原文", () => {
    const r = parseOsc52(`c;${b64("hello world")}`);
    expect(r).toEqual({ kind: "write", text: "hello world" });
  });

  it("UTF-8 多字节字符不会被拆坏（atob 只给字节）", () => {
    const r = parseOsc52(`c;${b64("中文 🚀 mixed")}`);
    expect(r).toEqual({ kind: "write", text: "中文 🚀 mixed" });
  });

  it("p / s / 数字 target 同样按「写」处理（Windows 上落同一块剪贴板）", () => {
    for (const t of ["p", "s", "0", "c"]) {
      expect(parseOsc52(`${t};${b64("x")}`)).toEqual({ kind: "write", text: "x" });
    }
  });

  it("读半边（c;?）必须拒绝", () => {
    expect(parseOsc52("c;?")).toEqual({ kind: "reject", reason: "read" });
  });

  it("空 payload（清空剪贴板）必须拒绝", () => {
    expect(parseOsc52("c;")).toEqual({ kind: "reject", reason: "empty" });
  });

  it("没有分号 → malformed", () => {
    expect(parseOsc52("c")).toEqual({ kind: "reject", reason: "malformed" });
    expect(parseOsc52("")).toEqual({ kind: "reject", reason: "malformed" });
  });

  it("超过上限的 payload 在解码前就拒绝（不占主线程）", () => {
    const huge = "A".repeat(OSC52_MAX_PAYLOAD + 1);
    expect(parseOsc52(`c;${huge}`)).toEqual({ kind: "reject", reason: "too-large" });
  });

  it("恰好等于上限仍允许（边界不误伤）", () => {
    // 用 "A" 填充到上限长：base64 合法字符，解码后是 0x00 字节序列。
    const r = parseOsc52(`c;${"A".repeat(OSC52_MAX_PAYLOAD)}`);
    expect(r.kind).toBe("write");
  });

  it("非法 base64 → decode 拒绝，不抛异常", () => {
    expect(parseOsc52("c;!!!!not-base64!!!!")).toEqual({ kind: "reject", reason: "decode" });
  });

  it("空字符串内容（payload 为合法 base64 但解码为空）仍算写", () => {
    // Buffer.from("").toString("base64") === ""，属于 empty 分支，这里用单字节 \0 验证非空。
    expect(parseOsc52(`c;${b64("\u0000")}`)).toEqual({ kind: "write", text: "\u0000" });
  });
});
