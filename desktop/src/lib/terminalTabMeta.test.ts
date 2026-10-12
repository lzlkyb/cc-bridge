import { describe, it, expect } from "vitest";
import { sanitizeTitle } from "./terminalTabMeta";

describe("sanitizeTitle（OSC 0/2 标题净化）", () => {
  it("正常标题原样保留", () => {
    expect(sanitizeTitle("claude")).toBe("claude");
    expect(sanitizeTitle("user@host: ~/code")).toBe("user@host: ~/code");
  });
  it("剥掉 ANSI 转义序列（OSC 子序列整段删除）", () => {
    // 标题里夹带 OSC 转义试图改写终端其它部分
    expect(sanitizeTitle("vi\x1b]0;evil\x07m")).toBe("vim");
    expect(sanitizeTitle("\x1b]2;fake\x1b\\claude")).toBe("claude");
  });
  it("剥掉 C0/C1 控制字符", () => {
    expect(sanitizeTitle("a\x07b\x1bc\r\nd")).toBe("abcd");
  });
  it("空白/空标题回退 null（标签显示主机名）", () => {
    expect(sanitizeTitle("")).toBe(null);
    expect(sanitizeTitle("   \t ")).toBe(null);
    expect(sanitizeTitle("\x1b]0;\x07")).toBe(null);
  });
  it("超长截断到 24 字符 + 省略号", () => {
    const long = "a".repeat(30);
    expect(sanitizeTitle(long)).toBe(`${"a".repeat(24)}…`);
  });
});
