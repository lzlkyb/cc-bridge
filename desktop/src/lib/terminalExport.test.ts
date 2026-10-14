import { describe, it, expect } from "vitest";
import type { IBuffer } from "@xterm/xterm";
import { bufferToText, exportFileName } from "./terminalExport";

/**
 * 假缓冲区：`baseY + cursorY` 是「最后一行」的绝对行号（xterm 的口径），
 * 所以给 `lines.length - 1` 当 baseY、cursorY 固定 0，等价于「缓冲区写满、光标在最后一行」。
 */
function fakeBuffer(lines: string[]): IBuffer {
  return {
    baseY: Math.max(0, lines.length - 1),
    cursorY: 0,
    length: lines.length,
    getLine: (n: number) =>
      lines[n] === undefined
        ? undefined
        : { translateToString: (trim?: boolean) => (trim ? lines[n].replace(/\s+$/, "") : lines[n]) },
  } as unknown as IBuffer;
}

describe("bufferToText（会话导出）", () => {
  it("取整个缓冲区而不是可视区，行尾空白被修剪", () => {
    const text = bufferToText(fakeBuffer(["$ ls", "a.txt   ", "b.txt"]));
    expect(text).toBe("$ ls\na.txt\nb.txt");
  });

  it("尾部空行剥掉（屏幕没写满时缓冲区底部留着一大片空白）", () => {
    const text = bufferToText(fakeBuffer(["output", "", "", "   ", ""]));
    expect(text).toBe("output");
  });

  it("中间的空行保留（命令之间本来就有空行，剥掉会改变语义）", () => {
    const text = bufferToText(fakeBuffer(["a", "", "b"]));
    expect(text).toBe("a\n\nb");
  });

  it("全空缓冲区 → 空串（调用方据此提示「没有可导出的内容」）", () => {
    expect(bufferToText(fakeBuffer(["", "", ""]))).toBe("");
    expect(bufferToText(fakeBuffer([]))).toBe("");
  });

  it("单行缓冲区", () => {
    expect(bufferToText(fakeBuffer(["only line"]))).toBe("only line");
  });
});

describe("exportFileName（导出文件名）", () => {
  const at = new Date(2026, 9, 13, 20, 11, 5); // 2026-10-13 20:11:05

  it("基本形态：连接名 + 时间戳 + .log", () => {
    expect(exportFileName("aliyun-dev", at)).toBe("aliyun-dev-20261013-201105.log");
  });

  it("月/日/时/分/秒都补零", () => {
    expect(exportFileName("x", new Date(2026, 0, 2, 3, 4, 5))).toBe("x-20260102-030405.log");
  });

  it("文件名非法字符与空白换成 -（连接名是用户随手起的）", () => {
    expect(exportFileName('a/b:c*d?e"f<g>h|i j', at)).toBe("a-b-c-d-e-f-g-h-i-j-20261013-201105.log");
  });

  it("中文连接名保留", () => {
    expect(exportFileName("阿里云 dev", at)).toBe("阿里云-dev-20261013-201105.log");
  });

  it("名字被清空时回退 terminal（不能生成一个只剩时间戳的怪文件名）", () => {
    expect(exportFileName("///", at)).toBe("terminal-20261013-201105.log");
    expect(exportFileName("", at)).toBe("terminal-20261013-201105.log");
  });
});
