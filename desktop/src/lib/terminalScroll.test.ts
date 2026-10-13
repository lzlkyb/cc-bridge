import { describe, it, expect, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  TUI_VIRTUAL_TOTAL,
  TUI_THUMB_MIN_PX,
  TUI_EDGE_REARM_LINES,
  TUI_EDGE_SEQ,
  isTuiScrollActive,
  wheelOwner,
  thumbMetrics,
  clampPos,
  planDrag,
  wheelCounts,
  shiftWheelLines,
  wheelPoint,
  markSynthWheel,
  isSynthWheel,
  attachSelectWheelGuard,
} from "./terminalScroll";

describe("isTuiScrollActive", () => {
  it("备用屏 + 鼠标跟踪（enable-mouse-events）才激活", () => {
    expect(isTuiScrollActive("alternate", true)).toBe(true);
  });
  it("备用屏但无鼠标跟踪（vim 不开鼠标）不激活", () => {
    expect(isTuiScrollActive("alternate", false)).toBe(false);
  });
  it("普通缓冲区（即使鼠标跟踪残留）不激活", () => {
    expect(isTuiScrollActive("normal", true)).toBe(false);
    expect(isTuiScrollActive("normal", false)).toBe(false);
  });
});

describe("wheelOwner（滚轮归属四态，设计稿屏6）", () => {
  it("normal × 无跟踪 = local（缺省态，不出徽章）", () => {
    expect(wheelOwner("normal", false)).toBe("local");
  });
  it("alternate × 跟踪开 = forward（现有 TUI 态）", () => {
    expect(wheelOwner("alternate", true)).toBe("forward");
  });
  it("normal × 跟踪开 = forwardMain（xterm 原生转发给 less 等）", () => {
    expect(wheelOwner("normal", true)).toBe("forwardMain");
  });
  it("alternate × 无跟踪 = dead（备用屏无 scrollback，滚轮无处可去）", () => {
    expect(wheelOwner("alternate", false)).toBe("dead");
  });
  it("isTuiScrollActive 恰为 forward 态（别名语义不漂移）", () => {
    for (const buffer of ["normal", "alternate"]) {
      for (const mouse of [true, false]) {
        expect(isTuiScrollActive(buffer, mouse)).toBe(wheelOwner(buffer, mouse) === "forward");
      }
    }
  });
});

describe("thumbMetrics", () => {
  it("底部（pos=total）thumb 贴轨道底", () => {
    const m = thumbMetrics(TUI_VIRTUAL_TOTAL, TUI_VIRTUAL_TOTAL, 30, 400);
    expect(m.topPx).toBeCloseTo(400 - m.heightPx, 5);
  });
  it("顶部（pos=0）thumb 贴轨道顶", () => {
    expect(thumbMetrics(0, TUI_VIRTUAL_TOTAL, 30, 400).topPx).toBe(0);
  });
  it("中间位置按比例分布", () => {
    const m = thumbMetrics(TUI_VIRTUAL_TOTAL / 2, TUI_VIRTUAL_TOTAL, 30, 400);
    const full = thumbMetrics(TUI_VIRTUAL_TOTAL, TUI_VIRTUAL_TOTAL, 30, 400);
    expect(m.topPx).toBeCloseTo(full.topPx / 2, 5);
  });
  it("thumb 高度 = track × rows/total，且有最小高度", () => {
    expect(thumbMetrics(0, TUI_VIRTUAL_TOTAL, 30, 400).heightPx).toBeCloseTo((400 * 30) / TUI_VIRTUAL_TOTAL, 5);
    // rows 很小时不低于 TUI_THUMB_MIN_PX
    expect(thumbMetrics(0, TUI_VIRTUAL_TOTAL, 1, 400).heightPx).toBe(TUI_THUMB_MIN_PX);
  });
  it("pos 超界被夹紧，不把 thumb 画出轨道", () => {
    const m = thumbMetrics(99999, TUI_VIRTUAL_TOTAL, 30, 400);
    expect(m.topPx).toBeCloseTo(400 - m.heightPx, 5);
    expect(thumbMetrics(-5, TUI_VIRTUAL_TOTAL, 30, 400).topPx).toBe(0);
  });
});

describe("clampPos", () => {
  it("夹回 [0, total]", () => {
    expect(clampPos(-3, 500)).toBe(0);
    expect(clampPos(250, 500)).toBe(250);
    expect(clampPos(503, 500)).toBe(500);
  });
});

describe("planDrag", () => {
  it("向上拖 N 行：target = start - N", () => {
    expect(planDrag(500, 40, TUI_VIRTUAL_TOTAL)).toEqual({ target: 460, overflowUp: 0, overflowDown: 0 });
  });
  it("向下拖（deltaLinesUp 为负）", () => {
    expect(planDrag(460, -30, TUI_VIRTUAL_TOTAL)).toEqual({ target: 490, overflowUp: 0, overflowDown: 0 });
  });
  it("越过顶边界：target 夹到 0，overflowUp 记录溢出行数", () => {
    expect(planDrag(10, 50, TUI_VIRTUAL_TOTAL)).toEqual({ target: 0, overflowUp: 40, overflowDown: 0 });
  });
  it("越过底边界：target 夹到 total，overflowDown 记录溢出行数", () => {
    expect(planDrag(490, -30, TUI_VIRTUAL_TOTAL)).toEqual({ target: 500, overflowUp: 0, overflowDown: 20 });
  });
  it("🔴 目标量化为整数行：浮点拖动增量不产生行数漂移", () => {
    // 连续三次 0.6 行的拖动，发送的行数累计应为整数、位置不漂移
    let pos = 500;
    let sent = 0;
    for (let i = 0; i < 3; i++) {
      const plan = planDrag(pos, 0.6, TUI_VIRTUAL_TOTAL);
      sent += wheelCounts(pos, plan.target).up;
      pos = plan.target;
    }
    expect(sent).toBeGreaterThan(0);
    expect(Number.isInteger(pos)).toBe(true);
    expect(Number.isInteger(sent)).toBe(true);
    // 位置变化必须与发送行数一致（无隐性漂移）
    expect(500 - pos).toBe(sent);
  });
  it("overshoot 按原始未夹紧值算，round 在 clamp 之前", () => {
    // 从 0 向上拖 0.4 行：raw = -0.4 → round = -0 → clamp 0；overflowUp = 0.4
    expect(planDrag(0, 0.4, TUI_VIRTUAL_TOTAL).target).toBe(0);
    expect(planDrag(0, 0.4, TUI_VIRTUAL_TOTAL).overflowUp).toBeCloseTo(0.4, 5);
    // 从 0 向下拖（负增量）不会产生顶部溢出
    expect(planDrag(0, -0.4, TUI_VIRTUAL_TOTAL)).toEqual({
      target: 0,
      overflowUp: 0,
      overflowDown: 0,
    });
  });
});

describe("wheelCounts", () => {
  it("向上滚（to < from）", () => {
    expect(wheelCounts(500, 490)).toEqual({ up: 10, down: 0 });
  });
  it("向下滚（to > from）", () => {
    expect(wheelCounts(490, 500)).toEqual({ up: 0, down: 10 });
  });
  it("不动为 0", () => {
    expect(wheelCounts(500, 500)).toEqual({ up: 0, down: 0 });
  });
  it("浮点差值四舍五入", () => {
    expect(wheelCounts(500, 499.6)).toEqual({ up: 0, down: 0 });
    expect(wheelCounts(500, 499.4)).toEqual({ up: 1, down: 0 });
  });
});

describe("TUI_EDGE_SEQ", () => {
  it("Ctrl+Home / Ctrl+End 的 xterm 编码（修饰参数 5 = Ctrl）", () => {
    expect(TUI_EDGE_SEQ.home).toBe("\x1b[1;5H");
    expect(TUI_EDGE_SEQ.end).toBe("\x1b[1;5F");
  });
});

describe("re-arm 常量", () => {
  it("re-arm 行数为正且小于虚拟总行数", () => {
    expect(TUI_EDGE_REARM_LINES).toBeGreaterThan(0);
    expect(TUI_EDGE_REARM_LINES).toBeLessThan(TUI_VIRTUAL_TOTAL);
  });
});

describe("shiftWheelLines（Shift+滚轮 → 本地滚动行数）", () => {
  it("deltaMode=1（行）：1 格 = 1 行，与 SGR 转发同口径", () => {
    expect(shiftWheelLines(1, 1)).toBe(1);
    expect(shiftWheelLines(-1, 1)).toBe(-1);
    expect(shiftWheelLines(-5, 1)).toBe(-5);
  });
  it("deltaMode=0（像素）：约 3 行/格，34px 一行", () => {
    expect(shiftWheelLines(102, 0)).toBe(3);
    expect(shiftWheelLines(-120, 0)).toBe(-3);
  });
  it("像素不足一行时保底 ±1（否则慢滚没反应）", () => {
    expect(shiftWheelLines(20, 0)).toBe(1);
    expect(shiftWheelLines(-20, 0)).toBe(-1);
  });
  it("deltaY=0 不动", () => {
    expect(shiftWheelLines(0, 0)).toBe(0);
    expect(shiftWheelLines(0, 1)).toBe(0);
  });
});

describe("wheelPoint（合成 wheel 的命中坐标）", () => {
  const rect = { left: 100, top: 50, width: 800, height: 400 };

  it("指针在屏幕内：原样使用真实指针坐标", () => {
    expect(wheelPoint(rect, { x: 300, y: 200 })).toEqual({ x: 300, y: 200 });
  });

  it("🔴 不再钉在屏幕中心：有指针就用指针", () => {
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    expect(wheelPoint(rect, { x: 110, y: 60 })).not.toEqual(center);
  });

  it("指针落在屏幕外时夹回矩形内（1px 内缩，避免命中测试落空）", () => {
    expect(wheelPoint(rect, { x: 0, y: 0 })).toEqual({ x: 101, y: 51 });
    expect(wheelPoint(rect, { x: 9999, y: 9999 })).toEqual({ x: 899, y: 449 });
  });

  it("没有指针时回退屏幕中心", () => {
    expect(wheelPoint(rect, null)).toEqual({ x: 500, y: 250 });
  });

  it("没有屏幕矩形时退化为指针原值（无指针则 0,0）", () => {
    expect(wheelPoint(null, { x: 7, y: 9 })).toEqual({ x: 7, y: 9 });
    expect(wheelPoint(null, null)).toEqual({ x: 0, y: 0 });
  });

  it("矩形退化（宽高 ≤2px）时不夹紧，直接用中心", () => {
    const tiny = { left: 10, top: 10, width: 2, height: 2 };
    expect(wheelPoint(tiny, { x: 999, y: 999 })).toEqual({ x: 11, y: 11 });
  });
});

describe("合成 wheel 标记", () => {
  it("markSynthWheel 后 isSynthWheel 为真，未标记事件为假", () => {
    const plain = { deltaY: -1 } as unknown as WheelEvent;
    expect(isSynthWheel(plain)).toBe(false);
    markSynthWheel(plain);
    expect(isSynthWheel(plain)).toBe(true);
  });
});

/** 记录型 fake 容器：既要断言注册参数（capture/passive），也要手动触发监听。 */
function fakeContainer() {
  const listeners: { type: string; fn: (e: unknown) => void; opts?: AddEventListenerOptions }[] = [];
  return {
    listeners,
    addEventListener(type: string, fn: (e: unknown) => void, opts?: AddEventListenerOptions) {
      listeners.push({ type, fn, opts });
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    fireWheel(e: unknown) {
      for (const l of listeners.filter((x) => x.type === "wheel")) l.fn(e);
    },
  };
}

interface FakeWheel {
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function fakeWheel(over: Partial<FakeWheel> = {}): FakeWheel {
  return {
    deltaY: -1,
    deltaMode: 1,
    shiftKey: false,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...over,
  };
}

describe("attachSelectWheelGuard（选择态滚轮守卫）", () => {
  const setup = (active: boolean) => {
    const container = fakeContainer();
    const scrollLines = vi.fn();
    const detach = attachSelectWheelGuard(
      container as unknown as HTMLElement,
      () => active,
      () => ({ scrollLines } as unknown as Terminal),
    );
    return { container, scrollLines, detach };
  };

  it("挂在捕获阶段且非 passive（否则拦不住 xterm 的默认行为）", () => {
    const { container } = setup(false);
    const wheels = container.listeners.filter((l) => l.type === "wheel");
    expect(wheels).toHaveLength(1);
    expect(wheels[0].opts?.capture).toBe(true);
    expect(wheels[0].opts?.passive).toBe(false);
  });

  it("选择态：吞掉滚轮，不让它退化成 ↑/↓ 穿到远端", () => {
    const { container } = setup(true);
    const e = fakeWheel();
    container.fireWheel(e);
    expect(e.prevented).toBe(true);
    expect(e.stopped).toBe(true);
  });

  it("选择态：顺手滚本地（主屏下仍有反应）", () => {
    const { container, scrollLines } = setup(true);
    container.fireWheel(fakeWheel({ deltaY: -5, deltaMode: 1 }));
    expect(scrollLines).toHaveBeenCalledWith(-5);
  });

  it("非选择态：完全放行（普通滚动不受影响）", () => {
    const { container, scrollLines } = setup(false);
    const e = fakeWheel();
    container.fireWheel(e);
    expect(e.prevented).toBe(false);
    expect(e.stopped).toBe(false);
    expect(scrollLines).not.toHaveBeenCalled();
  });

  it("Shift+滚轮放行：交给 attachShiftWheel 的本地滚动路径", () => {
    const { container, scrollLines } = setup(true);
    const e = fakeWheel({ shiftKey: true });
    container.fireWheel(e);
    expect(e.prevented).toBe(false);
    expect(scrollLines).not.toHaveBeenCalled();
  });

  it("🔴 合成的滚动条 wheel 不被自己吞掉（否则拖动滚动条失效）", () => {
    const { container } = setup(true);
    const e = fakeWheel();
    markSynthWheel(e as unknown as WheelEvent);
    container.fireWheel(e);
    expect(e.prevented).toBe(false);
    expect(e.stopped).toBe(false);
  });

  it("卸载后监听移除", () => {
    const { container, detach } = setup(true);
    detach();
    expect(container.listeners.filter((l) => l.type === "wheel")).toHaveLength(0);
  });
});
