import { describe, it, expect } from "vitest";
import { toCssPoint, pointInZone, hitZone, type DropZone } from "./dropHit";

const panel: DropZone = { id: "files", left: 100, top: 50, right: 500, bottom: 400 };
const term: DropZone = { id: "terminal", left: 100, top: 50, right: 500, bottom: 400 };

describe("toCssPoint", () => {
  // 🔴 position 是物理像素，getBoundingClientRect 是 CSS 像素。
  // 这一步漏了在 100% 缩放的机器上完全正常，只在高 DPI 上错——得靠单测盯。
  it("125% 缩放下按 dpr 换算", () => {
    expect(toCssPoint({ x: 250, y: 125 }, 1.25)).toEqual({ x: 200, y: 100 });
  });

  it("100% 缩放原样返回", () => {
    expect(toCssPoint({ x: 250, y: 125 }, 1)).toEqual({ x: 250, y: 125 });
  });

  it("dpr 非法时当 1，不能除出 NaN 让拖放整个失灵", () => {
    expect(toCssPoint({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
    expect(toCssPoint({ x: 10, y: 20 }, NaN)).toEqual({ x: 10, y: 20 });
    expect(toCssPoint({ x: 10, y: 20 }, -2)).toEqual({ x: 10, y: 20 });
  });
});

describe("pointInZone", () => {
  it("内部命中", () => {
    expect(pointInZone({ x: 300, y: 200 }, panel)).toBe(true);
  });

  it("左/上边界算命中，右/下边界不算", () => {
    expect(pointInZone({ x: 100, y: 50 }, panel)).toBe(true);
    expect(pointInZone({ x: 500, y: 200 }, panel)).toBe(false);
    expect(pointInZone({ x: 300, y: 400 }, panel)).toBe(false);
  });

  it("区域外不命中", () => {
    expect(pointInZone({ x: 99, y: 200 }, panel)).toBe(false);
    expect(pointInZone({ x: 300, y: 49 }, panel)).toBe(false);
  });
});

describe("hitZone", () => {
  it("重叠时后面的区域赢（文件面板是盖在终端之上的浮层）", () => {
    // 两个矩形完全重叠，排在后面的 files 应当拿到。
    expect(hitZone({ x: 300, y: 200 }, 1, [term, panel])).toBe("files");
    // 只有终端时归终端。
    expect(hitZone({ x: 300, y: 200 }, 1, [term])).toBe("terminal");
  });

  it("🔴 高 DPI 下仍能命中（不换算就会落空）", () => {
    // 物理坐标 (375,250) 在 1.25 缩放下 = CSS (300,200)，落在面板内。
    expect(hitZone({ x: 375, y: 250 }, 1.25, [panel])).toBe("files");
    // 若忘了除 dpr，(375,250) 会被当成 CSS 坐标——它仍在矩形内，看不出错；
    // 真正暴露问题的是靠近下边界的点：物理 (375,490) = CSS (300,392)，应当命中，
    // 不换算则 y=490 已超出 bottom=400，变成未命中。
    expect(hitZone({ x: 375, y: 490 }, 1.25, [panel])).toBe("files");
    expect(hitZone({ x: 375, y: 490 }, 1, [panel])).toBeNull();
  });

  it("都没命中返回 null（拖到侧栏 / 其它 tab 不响应）", () => {
    expect(hitZone({ x: 10, y: 10 }, 1, [term, panel])).toBeNull();
  });

  it("没有可接收区域时返回 null", () => {
    expect(hitZone({ x: 300, y: 200 }, 1, [])).toBeNull();
  });
});
