import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { isSelectHold, setSelectHold } from "./terminalInputHold";
import { isFitHeld } from "./terminalFitGate";
import {
  abortPointerGesture,
  beginDragFromDown,
  endPointerGesture,
  finishPlainClick,
  holdInputAtDown,
  markDownConsumed,
  replayClick,
} from "./terminalPointerGate";

const MODS = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };

interface FakeEv {
  type: string;
  init: MouseEventInit;
  gated: boolean;
}

/**
 * 手势相关的假终端：只需要 modes / options / element 三件。
 *
 * 🔴 这里和 `terminalSelectGesture.test.ts` 一样把 `MouseEvent` 换成最小替身：jsdom 的
 * 构造函数会校验 `view` 必须是它内部的 Window 实例，而 vitest 注入的 `window` 是个代理，
 * 必抛 `member view is not of type Window`——与被测逻辑无关，纯属测试环境的刺。
 */
function fakeTerm(mode: "none" | "any" = "any") {
  const events: FakeEv[] = [];
  const options = { disableStdin: false, macOptionClickForcesSelection: false };
  const target = {
    dispatchEvent: (e: { type: string; init: MouseEventInit }) => {
      events.push({ type: e.type, init: e.init, gated: options.disableStdin });
      return true;
    },
  };
  const term = { modes: { mouseTrackingMode: mode }, options, element: { querySelector: () => target } } as unknown as Terminal;
  return { term, events, options };
}

const types = (events: FakeEv[]) => events.map((e) => e.type);
const tick = () => new Promise((r) => setTimeout(r, 5));

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

describe("holdInputAtDown — 按下即闭闸", () => {
  it("🔴 开着拖拽即选：pointerdown 就闭闸（4px 之前那枚 mousedown 也不许外泄）", () => {
    const { term, options } = fakeTerm("any");
    expect(holdInputAtDown(term, MODS, false, true)).toBe(true);
    expect(options.disableStdin).toBe(true);
  });

  it("Shift / Alt / 选择模式任一成立也闭闸（它们都能起选择手势）", () => {
    for (const mods of [{ ...MODS, shiftKey: true }, { ...MODS, altKey: true }]) {
      const { term, options } = fakeTerm("any");
      expect(holdInputAtDown(term, mods, false, false)).toBe(true);
      expect(options.disableStdin).toBe(true);
    }
    const { term, options } = fakeTerm("any");
    expect(holdInputAtDown(term, MODS, true, false)).toBe(true);
    expect(options.disableStdin).toBe(true);
  });

  it("🔴 关掉拖拽即选又没按修饰键：不闭闸——TUI 原生拖拽要原样发给远端", () => {
    const { term, options } = fakeTerm("any");
    expect(holdInputAtDown(term, MODS, false, false)).toBe(false);
    expect(options.disableStdin).toBe(false);
  });

  it("远端没开鼠标追踪（普通 shell）：不闭闸，拦了只会干扰键鼠", () => {
    const { term, options } = fakeTerm("none");
    expect(holdInputAtDown(term, MODS, false, true)).toBe(false);
    expect(options.disableStdin).toBe(false);
  });
});

describe("beginDragFromDown — 阈值处起选区", () => {
  it("🔴 起手已闭闸：不补 mouseup（那枚按下没漏给远端，补了等于多发一次抬起）", () => {
    const { term, events } = fakeTerm("any");
    holdInputAtDown(term, MODS, false, true);
    beginDragFromDown(term, 10, 10);
    expect(types(events)).toEqual(["mousedown"]);
  });

  it("起手没闭闸（按下已泄漏）：先补 mouseup 收尾，再起本地选区", () => {
    const { term, events } = fakeTerm("any");
    beginDragFromDown(term, 10, 10);
    expect(types(events)).toEqual(["mouseup", "mousedown"]);
  });
});

describe("finishPlainClick — 补一次完整点击", () => {
  it("🔴 闭过闸的普通点击：开闸后补 mousedown + mouseup（否则 TUI 里点击全丢）", async () => {
    const { term, events, options } = fakeTerm("any");
    holdInputAtDown(term, MODS, false, true);
    finishPlainClick(term, 12, 34, MODS);
    // 同一任务内闸必须还闭着：紧随 pointerup 的真实 mouseup 报告要被拦下。
    expect(options.disableStdin).toBe(true);
    expect(events).toHaveLength(0);

    await tick();
    expect(options.disableStdin).toBe(false);
    expect(types(events)).toEqual(["mousedown", "mouseup"]);
    expect(events[0].gated).toBe(false); // 两枚都在开闸之后才发
    expect(events[1].init.clientX).toBe(12);
    expect(events[0].init.buttons).toBe(1);
    expect(events[1].init.buttons).toBe(0);
  });

  it("没闭过闸：不重放（原生点击已经正常发过），只做闸的兜底自愈", () => {
    const { term, events, options } = fakeTerm("any");
    setSelectHold(term, true); // 模拟异常路径上闸没被松开
    finishPlainClick(term, 1, 1, MODS);
    expect(events).toHaveLength(0);
    expect(isSelectHold(term)).toBe(false);
    expect(options.disableStdin).toBe(false);
  });

  it("🔴 按下被本地接管（双击取单元格）：只开闸不重放——重放会把刚选的单元格清掉", async () => {
    const { term, events, options } = fakeTerm("any");
    holdInputAtDown(term, MODS, false, true);
    markDownConsumed(term);
    finishPlainClick(term, 1, 1, MODS);
    await tick();
    expect(events).toHaveLength(0);
    expect(options.disableStdin).toBe(false);
  });
});

describe("手势结束的两条出口", () => {
  it("正常结束：延后一拍开闸 + 补跑挂起的 fit", async () => {
    const { term, options } = fakeTerm("any");
    holdInputAtDown(term, MODS, false, true);
    beginDragFromDown(term, 5, 5);
    expect(isFitHeld(term)).toBe(true);
    endPointerGesture(term);
    expect(options.disableStdin).toBe(true); // 这一拍还闭着
    await tick();
    expect(options.disableStdin).toBe(false);
    expect(isFitHeld(term)).toBe(false);
  });

  it("异常结束：两把闸立刻松开（没有要保护的选区）", () => {
    const { term, options } = fakeTerm("any");
    holdInputAtDown(term, MODS, false, true);
    beginDragFromDown(term, 5, 5);
    abortPointerGesture(term);
    expect(options.disableStdin).toBe(false);
    expect(isFitHeld(term)).toBe(false);
  });
});

describe("replayClick", () => {
  it("元素缺失时安全空转（半销毁终端不抛）", () => {
    expect(() => replayClick({ element: null } as unknown as Terminal, 1, 1, MODS)).not.toThrow();
  });
});
