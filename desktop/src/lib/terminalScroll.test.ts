import { describe, it, expect } from "vitest";
import {
  TUI_VIRTUAL_TOTAL,
  TUI_THUMB_MIN_PX,
  TUI_EDGE_REARM_LINES,
  TUI_EDGE_SEQ,
  isTuiScrollActive,
  thumbMetrics,
  clampPos,
  planDrag,
  wheelCounts,
  shiftWheelLines,
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
