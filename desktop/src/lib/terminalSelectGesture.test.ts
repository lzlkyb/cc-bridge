import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  beginDragSelection,
  beginSelection,
  createSelectGesture,
  forceSelectAt,
  isSynthMouse,
  markSynthMouse,
  replayMouseUp,
} from "./terminalSelectGesture";

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

/** 手势起手用到的假终端：只要 modes / options / element 三件（其余入口不碰）。 */
function fakeTermForBegin(mode: "none" | "any") {
  const events: { type: string; init: MouseEventInit }[] = [];
  const target = { dispatchEvent: (e: { type: string; init: MouseEventInit }) => (events.push(e), true) };
  const options = { disableStdin: false, macOptionClickForcesSelection: false };
  const term = {
    modes: { mouseTrackingMode: mode },
    options,
    element: { querySelector: () => target },
  } as unknown as Terminal;
  return { term, events, options };
}

describe("手势起手（beginSelection / beginDragSelection）", () => {
  beforeEach(() => {
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
  });
  afterEach(() => vi.unstubAllGlobals());

  const types = (events: { type: string }[]) => events.map((e) => e.type);

  it("🔴 远端没开鼠标追踪：**不**补 mouseup（补了会摘掉 xterm 原生拖选的延伸监听）", () => {
    const { term, events, options } = fakeTermForBegin("none");
    beginDragSelection(term, 10, 10);
    // 探针实证：普通 shell 里补这枚合成 mouseup 后，拖选只剩 5 字符（不补是 209）。
    expect(events).toHaveLength(0);
    expect(options.disableStdin).toBe(true); // 闭闸照常（没有报告可拦，但语义一致）
  });

  it("远端开着鼠标追踪：先补 mouseup 收尾已泄漏的按键，再补强制 mousedown 起本地选区", () => {
    const { term, events } = fakeTermForBegin("any");
    beginDragSelection(term, 10, 10);
    expect(types(events)).toEqual(["mouseup", "mousedown"]);
  });

  it("起手就带 Shift / 选择模式：从不补 mouseup（这枚按下没发给远端，没有要收尾的）", () => {
    for (const mode of ["none", "any"] as const) {
      const { term, events } = fakeTermForBegin(mode);
      beginSelection(term, 10, 10);
      expect(types(events)).not.toContain("mouseup");
    }
  });
});

describe("createSelectGesture（同一手势只自动复制一次）", () => {
  it("同一手势内重复领取只放行一次（同一次松手可能触发多个 pointerup）", () => {
    const g = createSelectGesture();
    g.begin();
    expect(g.claimCopy()).toBe(true);
    expect(g.claimCopy()).toBe(false);
  });

  it("🔴 换手势立刻放行：快速连续拖选两段（间隔再短）都要复制", () => {
    const g = createSelectGesture();
    g.begin();
    expect(g.claimCopy()).toBe(true);
    g.begin();
    expect(g.claimCopy()).toBe(true);
  });
});
