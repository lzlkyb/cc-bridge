import { describe, it, expect } from "vitest";
import {
  sparklinePath,
  sparkBars,
  sparkStep,
  sparkHeat,
  HEAT_CELLS,
  BAR_CELLS,
  SPARK_W,
  SPARK_H,
} from "./sparkline";

/** 从 points 串里抽出坐标对，方便做数值断言。 */
function parse(points: string): Array<[number, number]> {
  return points
    .trim()
    .split(/\s+/)
    .map((p) => {
      const [x, y] = p.split(",").map(Number);
      return [x, y] as [number, number];
    });
}

describe("sparklinePath", () => {
  it("少于 2 个点返回 null（单点连不成趋势，不该画线）", () => {
    expect(sparklinePath([], 60)).toBeNull();
    expect(sparklinePath([5], 60)).toBeNull();
    expect(sparklinePath([5, 6], 60)).not.toBeNull();
  });

  it("🔴 不足 maxPoints 时左对齐，**不拉伸填满**", () => {
    // 5 个点 / 满幅 60 点 → 末点只到 4×(100/59) ≈ 6.78，绝不能是 100。
    // 拉满全宽会让人以为已经看到完整的五分钟趋势。
    const p = sparklinePath([1, 2, 3, 4, 5], 60)!;
    const pts = parse(p.line);
    expect(pts).toHaveLength(5);
    expect(pts[0][0]).toBe(0);
    expect(pts[4][0]).toBeCloseTo(4 * (SPARK_W / 59), 1);
    expect(pts[4][0]).toBeLessThan(10);
  });

  it("攒满 maxPoints 时末点恰好落在右边界", () => {
    const vals = Array.from({ length: 60 }, (_, i) => i);
    const pts = parse(sparklinePath(vals, 60)!.line);
    expect(pts[59][0]).toBeCloseTo(SPARK_W, 1);
  });

  it("🔴 从零缩放：小波动不得被拉成满幅山峰", () => {
    // min-max 归一化会把 140→142 画成从底到顶；从零缩放下它们几乎同高。
    const pts = parse(sparklinePath([140, 142, 141], 60)!.line);
    const ys = pts.map(([, y]) => y);
    const spread = Math.max(...ys) - Math.min(...ys);
    expect(spread).toBeLessThan(1);
    // 而且因为接近各自的最大值，应该都在顶部附近
    expect(Math.max(...ys)).toBeLessThan(SPARK_H / 2);
  });

  it("全零序列贴底画平线（“什么都没发生”的真实样子）", () => {
    const pts = parse(sparklinePath([0, 0, 0, 0], 60)!.line);
    const ys = pts.map(([, y]) => y);
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBe(SPARK_H - 1);
  });

  it("坐标不越界", () => {
    const vals = [0, 50, 100, 3, 77];
    const pts = parse(sparklinePath(vals, 60)!.line);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(SPARK_W);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(SPARK_H);
    }
  });

  it("🔴 填充区终点跟随最后一个数据点，不凭空多出一块", () => {
    const p = sparklinePath([1, 2, 3], 60)!;
    const pts = parse(p.area);
    const first = pts[0];
    const last = pts[pts.length - 1];
    expect(first).toEqual([0, SPARK_H]);
    expect(last[1]).toBe(SPARK_H);
    // 终点 x 必须等于折线末点的 x，而不是右边界
    // （不用 .at(-1)：本项目的 tsconfig lib 目标低于 es2022，tsc 会报 TS2550）
    const linePts = parse(p.line);
    const lineLast = linePts[linePts.length - 1];
    expect(last[0]).toBeCloseTo(lineLast[0], 2);
    expect(last[0]).not.toBeCloseTo(SPARK_W, 1);
  });

  it("负值被夹到 0（防御性：计数差值理论上不应为负）", () => {
    const pts = parse(sparklinePath([-5, 10], 60)!.line);
    expect(pts[0][1]).toBe(SPARK_H - 1);
  });

  it("maxPoints < 2 时返回 null（避免除零）", () => {
    expect(sparklinePath([1, 2, 3], 1)).toBeNull();
  });

  it("末端坐标与折线末点一致（标点要恰好落在线上）", () => {
    const p = sparklinePath([10, 40, 25], 60)!;
    const pts = parse(p.line);
    const last = pts[pts.length - 1];
    expect(p.lastX).toBeCloseTo(last[0], 2);
    expect(p.lastY).toBeCloseTo(last[1], 2);
  });
});

describe("阈值参考线", () => {
  it("🔴 阈值超出可视范围时返回 null，**不得夹到顶边**", () => {
    // 速率最大 18、限流 120 → 线在图外。夹到顶边就是对位置撒谎。
    expect(sparklinePath([12, 18, 15], 60, 120)!.thresholdY).toBeNull();
  });

  it("阈值落在范围内时给出 y", () => {
    const p = sparklinePath([40, 100, 60], 60, 80)!;
    expect(p.thresholdY).not.toBeNull();
    // 阈值 80 < 峰值 100，所以它应在峰值之下（y 更大）、底线之上
    expect(p.thresholdY!).toBeGreaterThan(SPARK_H * 0.1);
    expect(p.thresholdY!).toBeLessThan(SPARK_H - 1);
  });

  it("不传阈值 / 阈值为 0 时均为 null", () => {
    expect(sparklinePath([1, 2, 3], 60)!.thresholdY).toBeNull();
    expect(sparklinePath([1, 2, 3], 60, 0)!.thresholdY).toBeNull();
  });
});

describe("sparkBars（柱状）", () => {
  it("🔴 按组聚合而不是一采样一根（60 根挤在 140px 卡里每根只有 1.4px）", () => {
    const bars = sparkBars(Array.from({ length: 60 }, (_, i) => i), 60);
    expect(bars).toHaveLength(BAR_CELLS);
  });

  it("🔴 用 max 聚合：尖峰不被抹平", () => {
    // groupSize = ceil(60/20) = 3。一组里只要有一次慢，这根柱就得是满高——
    // 均值会把它压成 1/3，而尖峰正是 P95 要暴露的东西。
    const bars = sparkBars([0, 0, 90, 30, 30, 30], 60);
    expect(bars).toHaveLength(2);
    expect(bars[0].ratio).toBeCloseTo(1, 2);
    expect(bars[1].ratio).toBeCloseTo(30 / 90, 2);
  });

  it("末组不完整也直接可比（max 不像求和会天然偏小）", () => {
    // 第 2 组只有 1 个采样，但它与第 1 组的峰值相同 → 两根应当同高。
    const bars = sparkBars([5, 5, 5, 5], 60);
    expect(bars).toHaveLength(2);
    expect(bars[1].ratio).toBeCloseTo(bars[0].ratio, 2);
  });

  it("柱宽窄于槽位（留缝，看得出一根=一段时间窗）", () => {
    const slot = SPARK_W / BAR_CELLS;
    const w = sparkBars([1, 2, 3], 60)[0].w;
    expect(w).toBeLessThan(slot);
    expect(w).toBeGreaterThan(slot * 0.5);
  });

  it("🔴 值为 0 也留一道底纹，空闲时卡片不像坏了", () => {
    for (const b of sparkBars([0, 0, 0], 60)) expect(b.ratio).toBeGreaterThan(0);
  });

  it("左对齐不拉伸：只有一组时贴在最左", () => {
    expect(sparkBars([1, 2, 3], 60)[0].x).toBe(0);
  });
});

describe("sparkStep（阶梯线）", () => {
  it("🔴 每个采样产生两个点（平推后再跳变），而不是斜连", () => {
    const pts = parse(sparkStep([1, 3], 60)!);
    expect(pts).toHaveLength(4);
    // 前两点等高 → 水平段；第 3 点与第 2 点同 x 不同 y → 垂直跳变
    expect(pts[0][1]).toBeCloseTo(pts[1][1], 2);
    expect(pts[1][0]).toBeCloseTo(pts[2][0], 2);
    expect(pts[2][1]).not.toBeCloseTo(pts[1][1], 2);
  });

  it("少于 2 点返回 null", () => {
    expect(sparkStep([5], 60)).toBeNull();
  });
});

describe("sparkHeat（热力条）", () => {
  it("🔴 按组聚合而不是一采样一格（60 格挤在 140px 卡里每格只有 2.3px）", () => {
    // 60 个采样 → HEAT_CELLS 格
    expect(sparkHeat(Array.from({ length: 60 }, (_, i) => i), 60)).toHaveLength(HEAT_CELLS);
  });

  it("格子宽度约为一个槽位，且留了缝隙", () => {
    const cells = sparkHeat([1, 2, 3, 4, 5], 60);
    const slot = SPARK_W / HEAT_CELLS;
    expect(cells[0].w).toBeLessThan(slot);
    expect(cells[0].w).toBeGreaterThan(slot * 0.8);
  });

  it("🔴 用均值而不是求和：不完整的末组仍与完整组可比", () => {
    // groupSize = ceil(60/15) = 4。给 5 个等值采样 → 第 2 组只有 1 个，
    // 但均值相同，两格应当同深浅；若用求和，末格会只有 1/4 深。
    const cells = sparkHeat([8, 8, 8, 8, 8], 60);
    expect(cells).toHaveLength(2);
    expect(cells[1].level).toBeCloseTo(cells[0].level, 2);
  });

  it("level 归一到 0..1，最忙那格为 1", () => {
    const cells = sparkHeat([0, 0, 0, 0, 9, 9, 9, 9], 60);
    expect(cells).toHaveLength(2);
    expect(cells[1].level).toBeCloseTo(1, 2);
    for (const c of cells) {
      expect(c.level).toBeGreaterThan(0);
      expect(c.level).toBeLessThanOrEqual(1);
    }
  });

  it("全零时给极浅底色，而不是完全不可见", () => {
    for (const c of sparkHeat([0, 0, 0], 60)) {
      expect(c.level).toBeGreaterThan(0);
      expect(c.level).toBeLessThan(0.2);
    }
  });
});
