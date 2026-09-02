import { describe, it, expect } from "vitest";
import { countPasteLines, pastePreview } from "./terminalPaste";

describe("countPasteLines", () => {
  it("空串算 0 行", () => {
    expect(countPasteLines("")).toBe(0);
  });

  it("单行算 1 行", () => {
    expect(countPasteLines("ls -al")).toBe(1);
  });

  // 关键行为：这种粘贴等价于手敲一条命令再回车，不应该弹确认框。
  it("单行 + 末尾换行仍算 1 行（不弹框）", () => {
    expect(countPasteLines("ls -al\n")).toBe(1);
    expect(countPasteLines("ls -al\r\n")).toBe(1);
  });

  it("多行按实际命令数算", () => {
    expect(countPasteLines("cd /opt\ngit pull")).toBe(2);
    expect(countPasteLines("cd /opt\ngit pull\n")).toBe(2);
    expect(countPasteLines("cd /opt\r\ngit pull\r\n")).toBe(2);
  });

  it("中间的空行也是一条（空行会让 shell 多回一次车）", () => {
    expect(countPasteLines("a\n\nb")).toBe(3);
  });
});

describe("pastePreview", () => {
  it("不超上限时原样展示", () => {
    expect(pastePreview("a\nb\nc")).toBe("a\nb\nc");
  });

  it("超出部分折成一句「…还有 N 行」", () => {
    expect(pastePreview("a\nb\nc\nd")).toBe("a\nb\nc\n…还有 1 行");
    expect(pastePreview("a\nb\nc\nd\ne\nf")).toBe("a\nb\nc\n…还有 3 行");
  });

  it("末尾换行不会多出一行空白", () => {
    expect(pastePreview("a\nb\n")).toBe("a\nb");
  });
});
