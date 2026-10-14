import { describe, it, expect, vi } from "vitest";
import {
  navCmdStart,
  navCmdEnd,
  navJump,
  navLastDuration,
  navBlockCount,
  navBlockAt,
  navBlockOutput,
  formatCmdDuration,
} from "./terminalCommandNav";
import type { Terminal, IMarker } from "@xterm/xterm";

/**
 * 轻量 fake 终端：
 * - `markerLines` 依次分配给每次 `registerMarker()`（用完后循环）——用来模拟「A 钉在不同行」。
 * - `content` 是缓冲区内容，`getLine(n)` 返回第 n 行，边界外 undefined。
 * - `viewportY` 会随 scrollToLine 变（真实跳转后视口就停在目标行）。
 */
function fakeTerm(
  opts: { markerLines?: number[]; content?: string[]; viewportY?: number } = {},
) {
  const { markerLines = [0], content = [], viewportY = 0 } = opts;
  const markers: {
    line: number;
    cb?: () => void;
    onDispose: (cb: () => void) => void;
    dispose: () => void;
  }[] = [];
  const state = { viewportY };
  const term = {
    buffer: {
      active: {
        get viewportY() {
          return state.viewportY;
        },
        get baseY() {
          return Math.max(0, content.length - 1);
        },
        get cursorY() {
          return 0;
        },
        getLine: (n: number) =>
          content[n] === undefined
            ? undefined
            : {
                // 真实 xterm 的 translateToString(true) 会去掉行尾空白（全空白行 → ""）。
                translateToString: (trimRight?: boolean) =>
                  trimRight ? content[n].replace(/\s+$/, "") : content[n],
              },
      },
    },
    scrollToLine: vi.fn((line: number) => {
      state.viewportY = line;
    }),
    registerMarker: vi.fn(() => {
      const m = {
        line: markerLines[markers.length % markerLines.length],
        cb: undefined as (() => void) | undefined,
        onDispose(cb: () => void) {
          m.cb = cb;
        },
        dispose() {
          m.line = -1;
          m.cb?.();
        },
      };
      markers.push(m);
      return m as unknown as IMarker;
    }),
  } as unknown as Terminal;
  return { term, markers, state };
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
  it("没有 A 锚点时 D 无处可落，返回 null", () => {
    const { term } = fakeTerm();
    expect(navCmdEnd(term, 0)).toBe(null);
  });

  it("A 之后 D 能算出耗时", () => {
    const { term } = fakeTerm();
    navCmdStart(term);
    const dur = navCmdEnd(term, 0);
    expect(typeof dur).toBe("number");
    expect(dur).toBeGreaterThanOrEqual(0);
    expect(navLastDuration(term)).toBe(dur);
  });

  it("D 的退出码回填到「最后一块」", () => {
    const { term } = fakeTerm({ markerLines: [0, 3] });
    navCmdStart(term); // 块 0（$ ls）
    navCmdEnd(term, 0); // 上一条结束：落在块 0
    navCmdStart(term); // 块 1（$ pwd），尚未结束
    expect(navBlockAt(term, 0)?.exitCode).toBe(0);
    expect(navBlockAt(term, 1)?.exitCode).toBe(null);
    expect(navBlockAt(term, 1)?.durMs).toBe(null);
  });

  it("非零退出码原样保留", () => {
    const { term } = fakeTerm();
    navCmdStart(term);
    navCmdEnd(term, 137);
    expect(navBlockAt(term, 0)?.exitCode).toBe(137);
  });
});

describe("命令块元数据", () => {
  it("navBlockCount 与 navBlockAt 的下标一致，越界返回 null", () => {
    const { term } = fakeTerm({ markerLines: [0, 5, 9] });
    navCmdStart(term);
    navCmdStart(term);
    navCmdStart(term);
    expect(navBlockCount(term)).toBe(3);
    expect(navBlockAt(term, 0)?.line).toBe(0);
    expect(navBlockAt(term, 2)?.line).toBe(9);
    expect(navBlockAt(term, 3)).toBe(null);
  });

  it("marker 被缓冲区截断（dispose）后条目同步移除", () => {
    const { term, markers } = fakeTerm({ markerLines: [0, 5] });
    navCmdStart(term);
    navCmdStart(term);
    expect(navBlockCount(term)).toBe(2);
    markers[0].dispose(); // 模拟 xterm trim 掉旧行
    expect(navBlockCount(term)).toBe(1);
  });

  it("超过 50 块时丢弃最旧的（避免无限增长）", () => {
    const { term } = fakeTerm();
    for (let i = 0; i < 55; i++) navCmdStart(term);
    expect(navBlockCount(term)).toBe(50);
  });
});

describe("navBlockOutput（输出区间抽取）", () => {
  it("取「提示符行之后」到「下一块之前」", () => {
    // 0:$ ls  1:a.txt  2:b.txt  3:$ pwd  4:/home/u
    const { term } = fakeTerm({
      markerLines: [0, 3],
      content: ["$ ls", "a.txt", "b.txt", "$ pwd", "/home/u"],
    });
    navCmdStart(term); // 块 0 钉在 0
    navCmdEnd(term, 0);
    navCmdStart(term); // 块 1 钉在 3
    expect(navBlockOutput(term, 0)).toBe("a.txt\nb.txt");
  });

  it("提示符行本身不算输出（命令文本属输入）", () => {
    const { term } = fakeTerm({
      markerLines: [0, 2],
      content: ["$ echo hi", "hi", "$ "],
    });
    navCmdStart(term);
    navCmdStart(term);
    const out = navBlockOutput(term, 0);
    expect(out).toBe("hi");
    expect(out).not.toContain("echo hi");
  });

  it("无输出的命令返回空串（不是 null）", () => {
    const { term } = fakeTerm({ markerLines: [0, 1], content: ["$ cd /tmp", "$ "] });
    navCmdStart(term);
    navCmdStart(term);
    expect(navBlockOutput(term, 0)).toBe("");
  });

  it("最后一块取到缓冲区末尾（命令可能还在输出）", () => {
    const { term } = fakeTerm({
      markerLines: [0],
      content: ["$ sleep 1", "..."],
    });
    navCmdStart(term);
    expect(navBlockOutput(term, 0)).toBe("...");
  });

  it("尾部空行剥掉", () => {
    const { term } = fakeTerm({
      markerLines: [0, 4],
      content: ["$ ls", "a.txt", "", "   ", "$ "],
    });
    navCmdStart(term);
    navCmdStart(term);
    expect(navBlockOutput(term, 0)).toBe("a.txt");
  });

  it("越界的块返回 null", () => {
    const { term } = fakeTerm();
    expect(navBlockOutput(term, 7)).toBe(null);
  });
});

describe("navJump", () => {
  it("向上跳到视口上方最近的命令行", () => {
    const { term } = fakeTerm({ markerLines: [10, 30, 50], viewportY: 45 });
    navCmdStart(term);
    navCmdStart(term);
    navCmdStart(term);
    expect(navJump(term, -1)).toBe(true);
    expect(term.scrollToLine).toHaveBeenCalledWith(30);
  });
  it("向下跳到视口下方最近的命令行", () => {
    const { term } = fakeTerm({ markerLines: [10, 30, 50], viewportY: 20 });
    navCmdStart(term);
    navCmdStart(term);
    navCmdStart(term);
    expect(navJump(term, 1)).toBe(true);
    expect(term.scrollToLine).toHaveBeenCalledWith(30);
  });
  it("到边界后返回 false（供调用方 toast）", () => {
    const { term } = fakeTerm({ markerLines: [10], viewportY: 50 });
    navCmdStart(term);
    expect(navJump(term, -1)).toBe(true); // 10 < 50
    expect(navJump(term, -1)).toBe(false); // 没有更早的了
  });
  it("从未记录过命令时返回 false", () => {
    const { term } = fakeTerm({ markerLines: [1] });
    expect(navJump(term, -1)).toBe(false);
    expect(navJump(term, 1)).toBe(false);
  });
});
