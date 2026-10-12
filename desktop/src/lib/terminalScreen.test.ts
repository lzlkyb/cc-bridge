import { describe, expect, it } from "vitest";
import type { IBufferNamespace } from "@xterm/xterm";
import { screenToText } from "./terminalScreen";

/** 只造 screenToText 用到的 active.viewportY / active.getLine / translateToString。 */
function fakeBuffer(lines: string[], viewportY = 0): IBufferNamespace {
  return {
    active: {
      viewportY,
      getLine: (i: number) => {
        const text = lines[i - viewportY];
        return text === undefined
          ? null
          : {
              // 真实 translateToString(true) 会修剪行尾空白，fake 保持一致。
              translateToString: (trim?: boolean) => (trim ? text.replace(/\s+$/, "") : text),
            };
      },
    },
  } as unknown as IBufferNamespace;
}

describe("screenToText", () => {
  it("按行导出可视区域", () => {
    expect(screenToText(fakeBuffer(["hello", "world"]), 2)).toBe("hello\nworld");
  });

  it("从 viewportY 开始取（终端滚动态）", () => {
    // viewportY=5 即可视区域从缓冲区第 5 行开始：fake 里 getLine(5)=lines[0]。
    expect(screenToText(fakeBuffer(["a", "b", "c"], 5), 2)).toBe("a\nb");
  });

  it("越界行导出为空串", () => {
    expect(screenToText(fakeBuffer(["only"]), 3)).toBe("only\n\n");
  });

  it("行尾空白被修剪", () => {
    expect(screenToText(fakeBuffer(["x   ", "y\t"]), 2)).toBe("x\ny");
  });

  it("空缓冲区导出空串", () => {
    expect(screenToText(fakeBuffer([]), 2)).toBe("\n");
  });
});
