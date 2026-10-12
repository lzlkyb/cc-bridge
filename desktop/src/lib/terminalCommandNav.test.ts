import { describe, it, expect, vi } from "vitest";
import {
  navCmdStart,
  navCmdEnd,
  navJump,
  formatCmdDuration,
} from "./terminalCommandNav";
import type { Terminal, IMarker } from "@xterm/xterm";

/** 轻量 fake：viewportY 会随 scrollToLine 变（真实跳转后视口就停在目标行）。 */
function fakeTerm(lines: number[], viewportY = 0) {
  const markers: IMarker[] = [];
  const state = { viewportY };
  const term = {
    buffer: {
      active: {
        get viewportY() {
          return state.viewportY;
        },
      },
    },
    scrollToLine: vi.fn((line: number) => {
      state.viewportY = line;
    }),
    registerMarker: vi.fn(() => {
      const line = lines.length ? lines[markers.length % lines.length] : 0;
      const m = { line, onDispose: vi.fn(), dispose: vi.fn() } as unknown as IMarker;
      markers.push(m);
      return m;
    }),
  } as unknown as Terminal;
  return { term, markers };
}

describe("formatCmdDuration", () => {
  it("秒级一位小数", () => {
    expect(formatCmdDuration(3200)).toBe("3.2s");
    expect(formatCmdDuration(940)).toBe("0.9s");
  });
  it("超过一分钟换算分秒", () => {
    expect(formatCmdDuration(65_000)).toBe("1m05s");
    expect(formatCmdDuration(600_000)).toBe("10m00s");
  });
  it("非法输入回退 null", () => {
    expect(formatCmdDuration(null)).toBe(null);
    expect(formatCmdDuration(-1)).toBe(null);
    expect(formatCmdDuration(NaN)).toBe(null);
  });
});

describe("navCmdStart / navCmdEnd 配对", () => {
  it("A→D 配对产生耗时；无 A 的 D 不产生", () => {
    const { term } = fakeTerm([1]);
    expect(navCmdEnd(term)).toBe(null); // 没有 A，直接 D
    navCmdStart(term);
    expect(navCmdEnd(term)).not.toBe(null);
  });
});

describe("navJump", () => {
  it("向上跳到视口上方最近的命令行", () => {
    const { term } = fakeTerm([10, 30, 50], 45); // 视口在 45，上方有 30、10
    navCmdStart(term);
    navCmdStart(term);
    navCmdStart(term);
    expect(navJump(term, -1)).toBe(true);
    expect(term.scrollToLine).toHaveBeenCalledWith(30);
  });
  it("向下跳到视口下方最近的命令行", () => {
    const { term } = fakeTerm([10, 30, 50], 20);
    navCmdStart(term);
    navCmdStart(term);
    navCmdStart(term);
    expect(navJump(term, 1)).toBe(true);
    expect(term.scrollToLine).toHaveBeenCalledWith(30);
  });
  it("到边界后返回 false（供调用方 toast）", () => {
    const { term } = fakeTerm([10], 50);
    navCmdStart(term);
    expect(navJump(term, -1)).toBe(true); // 10 < 50
    expect(navJump(term, -1)).toBe(false); // 没有更早的了
  });
  it("从未记录过命令时返回 false", () => {
    const { term } = fakeTerm([1]);
    expect(navJump(term, -1)).toBe(false);
    expect(navJump(term, 1)).toBe(false);
  });
});
