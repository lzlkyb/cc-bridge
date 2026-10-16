import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { forceSelectAt, isSynthMouse, markSynthMouse, replayMouseUp } from "./terminalSelectGesture";

describe("合成鼠标事件标记", () => {
  it("标记后可识别——容器级 onDown 靠它跳过自己合成的事件（否则会二次进入手势）", () => {
    const e = {} as unknown as MouseEvent;
    expect(isSynthMouse(e)).toBe(false);
    markSynthMouse(e);
    expect(isSynthMouse(e)).toBe(true);
  });

  it("普通事件对象读到 false，不抛", () => {
    expect(isSynthMouse({} as unknown as Event)).toBe(false);
  });
});

describe("forceSelectAt 的前置判据", () => {
  it("鼠标跟踪没开（普通 shell）→ 什么都不做（xterm 原生拖选本来就能用）", () => {
    const term = { modes: { mouseTrackingMode: "none" } } as unknown as Terminal;
    expect(() => forceSelectAt(term, 1, 1)).not.toThrow();
  });
});

describe("replayMouseUp —— 给远端收尾「已经泄漏出去的那次按下」", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("终端元素缺失时安全空转（半销毁终端不抛）", () => {
    expect(() => replayMouseUp({ element: null } as unknown as Terminal, 1, 1)).not.toThrow();
  });

  it("🔴 补发的是一枚可冒泡、带合成标记的 mouseup（xterm 的 document 级监听才收得到）", () => {
    const seen: unknown[] = [];
    vi.stubGlobal("window", {});
    vi.stubGlobal(
      "MouseEvent",
      class {
        constructor(
          public type: string,
          public init: MouseEventInit,
        ) {}
      },
    );
    const target = { dispatchEvent: (e: unknown) => (seen.push(e), true) };
    const term = { element: { querySelector: () => target } } as unknown as Terminal;

    replayMouseUp(term, 12, 34);

    expect(seen).toHaveLength(1);
    const ev = seen[0] as { type: string; init: MouseEventInit };
    expect(ev.type).toBe("mouseup");
    expect(ev.init.bubbles).toBe(true);
    expect(ev.init.clientX).toBe(12);
    expect(ev.init.buttons).toBe(0); // 抬起：xterm 据此移除 document 上的拖拽监听
    expect(isSynthMouse(ev as unknown as Event)).toBe(true); // 不回头触发我们自己的手势
  });
});
