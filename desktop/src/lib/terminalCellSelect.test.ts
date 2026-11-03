// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  attachCellDoubleClick,
  bufferCellFromPoint,
  cellWidth,
  resolveCellRange,
  toColumns,
} from "./terminalCellSelect";

/**
 * 表格行（CC 实际输出的形状）：竖线 + 空格填充 + 中文单元格。
 * 列索引：0 `│` 1 空格 2..10 `ic/a.java` 11 空格 12 `│` 13 空格
 * 14 `修` 15 宽字符右半 16 `改` 17 宽字符右半 18 空格 19 `│` …
 */
const TABLE = "│ ic/a.java │ 修改 │ exe() │";

function rectStub(el: HTMLElement, w: number, h: number): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function fakeTerm(over: Record<string, unknown> = {}, line = TABLE): Terminal {
  return {
    cols: 80,
    rows: 24,
    options: {} as Record<string, unknown>,
    modes: { mouseTrackingMode: "any" },
    element: null,
    buffer: { active: { viewportY: 0, getLine: () => ({ translateToString: () => line }) } },
    select: vi.fn(),
    getSelection: () => "修改",
    clearSelection: vi.fn(),
    focus: vi.fn(),
    ...over,
  } as unknown as Terminal;
}

describe("列宽与展开", () => {
  it("中文占两列，右半格是 null", () => {
    expect(cellWidth("修")).toBe(2);
    expect(cellWidth("a")).toBe(1);
    expect(toColumns("修a")).toEqual(["修", null, "a"]);
  });

  it("组合记号并进前一格，不额外占列", () => {
    expect(toColumns("e\u0301")).toEqual(["e\u0301"]);
  });
});

describe("resolveCellRange —— 单元格边界", () => {
  it("落在表格中间列：只取该格内容，且完整覆盖宽字符", () => {
    // 「修改」占 14..17 四列（含两个宽字符的右半格）
    expect(resolveCellRange(TABLE, 14)).toEqual({ start: 14, length: 4 });
    expect(resolveCellRange(TABLE, 16)).toEqual({ start: 14, length: 4 });
  });

  it("落在竖线上：取右侧那一格", () => {
    expect(resolveCellRange(TABLE, 12)).toEqual({ start: 14, length: 4 });
  });

  it("落在文件名格：只取路径，不带右侧说明列", () => {
    expect(resolveCellRange(TABLE, 4)).toEqual({ start: 2, length: 9 });
    expect(resolveCellRange(TABLE, 11)).toEqual({ start: 2, length: 9 });
  });

  it("普通文本按单词切（不会把整行选中）", () => {
    expect(resolveCellRange("hello world foo", 3)).toEqual({ start: 0, length: 5 });
    expect(resolveCellRange("hello world foo", 8)).toEqual({ start: 6, length: 5 });
  });

  it("对齐文本（连续双空格）按列切", () => {
    expect(resolveCellRange("aaa  bbb  ccc", 6)).toEqual({ start: 5, length: 3 });
  });

  it("整行空白 / 空串返回 null", () => {
    expect(resolveCellRange("     ", 2)).toBeNull();
    expect(resolveCellRange("", 0)).toBeNull();
  });
});

describe("bufferCellFromPoint", () => {
  it("按 cols/rows 换算成 buffer 绝对行", () => {
    const el = document.createElement("div");
    rectStub(el, 800, 480); // 80 列 × 24 行 ⇒ 每格 10 × 20
    const term = fakeTerm({ buffer: { active: { viewportY: 10, getLine: () => null } } });
    expect(bufferCellFromPoint(term, el, 25, 45)).toEqual({ col: 2, row: 12 });
    expect(bufferCellFromPoint(term, el, -1, 0)).toBeNull();
    expect(bufferCellFromPoint(term, el, 9999, 0)).toBeNull();
  });

  it("元素没有布局尺寸（未挂载）时不猜坐标", () => {
    const el = document.createElement("div");
    expect(bufferCellFromPoint(fakeTerm(), el, 10, 10)).toBeNull();
  });
});

describe("attachCellDoubleClick", () => {
  it("双击选中单元格并回调文本", () => {
    const el = document.createElement("div");
    rectStub(el, 800, 480);
    document.body.append(el);
    const term = fakeTerm();
    const onSelected = vi.fn();
    const detach = attachCellDoubleClick(term, el, { onSelected });

    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail: 2, clientX: 145, clientY: 10, bubbles: true }));

    expect(term.select).toHaveBeenCalledWith(14, 0, 4);
    expect(onSelected).toHaveBeenCalledWith("修改");
    detach();
    el.remove();
  });

  it("单击不接管（remote TUI 的普通点击照旧）", () => {
    const el = document.createElement("div");
    rectStub(el, 800, 480);
    const term = fakeTerm();
    attachCellDoubleClick(term, el, {});
    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail: 1, clientX: 145, clientY: 10, bubbles: true }));
    expect(term.select).not.toHaveBeenCalled();
  });

  it("没有鼠标追踪且未开选择模式：普通文本交回 xterm 原生双击选词", () => {
    const el = document.createElement("div");
    rectStub(el, 800, 480);
    const term = fakeTerm({ modes: { mouseTrackingMode: "none" } }, "hello world foo");
    attachCellDoubleClick(term, el, {});
    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail: 2, clientX: 145, clientY: 10, bubbles: true }));
    expect(term.select).not.toHaveBeenCalled();
  });

  it("没有鼠标追踪但该行是表格：仍然接管（CC 退出后回看历史也能双击取格）", () => {
    const el = document.createElement("div");
    rectStub(el, 800, 480);
    const term = fakeTerm({ modes: { mouseTrackingMode: "none" } });
    attachCellDoubleClick(term, el, {});
    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail: 2, clientX: 145, clientY: 10, bubbles: true }));
    expect(term.select).toHaveBeenCalledWith(14, 0, 4);
  });

  it("选择模式开着时即使没有鼠标追踪也接管", () => {
    const el = document.createElement("div");
    rectStub(el, 800, 480);
    const term = fakeTerm({ modes: { mouseTrackingMode: "none" } });
    attachCellDoubleClick(term, el, { isEnabled: () => true });
    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail: 2, clientX: 145, clientY: 10, bubbles: true }));
    expect(term.select).toHaveBeenCalledWith(14, 0, 4);
  });
});
