import { describe, expect, it } from "vitest";
import type { TokenUsageDay, TokenUsageTool } from "./types";
import {
  buildHeatmap,
  buildTrend,
  computeKpis,
  dayTotal,
  deltaPct,
  fmtWan,
  localDateKey,
  rankTools,
} from "./usageMath";

const day = (date: string, calls: number, estInput: number, estOutput: number): TokenUsageDay => ({
  date,
  calls,
  estInput,
  estOutput,
});

const tool = (name: string, estInput: number, estOutput: number, calls = 1): TokenUsageTool => ({
  tool: name,
  calls,
  estInput,
  estOutput,
});

describe("localDateKey", () => {
  it("补零格式化", () => {
    expect(localDateKey(new Date(2026, 9, 5))).toBe("2026-10-05");
    expect(localDateKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("dayTotal / deltaPct", () => {
  it("dayTotal 是输入加输出", () => {
    expect(dayTotal({ estInput: 3, estOutput: 4 })).toBe(7);
  });

  it("deltaPct 正常环比取整", () => {
    expect(deltaPct(123, 100)).toBe(23);
    expect(deltaPct(92, 100)).toBe(-8);
  });

  it("deltaPct 无基准 / 非法输入返回 null（UI 隐藏）", () => {
    expect(deltaPct(10, 0)).toBeNull();
    expect(deltaPct(10, -5)).toBeNull();
    expect(deltaPct(-1, 5)).toBeNull();
    expect(deltaPct(NaN, 5)).toBeNull();
  });
});

describe("computeKpis", () => {
  const days14 = [
    day("2026-09-22", 1, 10_000, 1_000),
    day("2026-09-23", 1, 20_000, 2_000),
    day("2026-09-24", 1, 30_000, 3_000),
    day("2026-09-25", 1, 10_000, 1_000),
    day("2026-09-26", 1, 10_000, 1_000),
    day("2026-09-27", 1, 10_000, 1_000),
    day("2026-09-28", 1, 10_000, 1_000), // 上周合计 100k+7k
    day("2026-09-29", 1, 20_000, 2_000),
    day("2026-09-30", 1, 20_000, 2_000),
    day("2026-10-01", 1, 20_000, 2_000),
    day("2026-10-02", 1, 20_000, 2_000),
    day("2026-10-03", 1, 20_000, 2_000),
    day("2026-10-04", 1, 20_000, 2_000),
    day("2026-10-05", 1, 30_000, 5_000), // 本周 150k+15k
  ];

  it("今日与周环比、输入输出占比", () => {
    const k = computeKpis(days14);
    expect(k.today).toBe(35_000);
    expect(k.week).toBe(167_000);
    // 本周 167k vs 上周 110.2k → +52%
    expect(k.weekDelta).toBe(52);
    expect(k.input7).toBe(150_000);
    expect(k.output7).toBe(17_000);
    expect(k.inputShare).toBe(90);
    expect(k.outputShare).toBe(10);
  });

  it("只有一天时今日环比为 null、周环比 null", () => {
    const k = computeKpis([day("2026-10-05", 3, 100, 10)]);
    expect(k.today).toBe(110);
    expect(k.todayDelta).toBeNull();
    expect(k.weekDelta).toBeNull();
  });

  it("空序列全 0 不抛错", () => {
    const k = computeKpis([]);
    expect(k.today).toBe(0);
    expect(k.todayDelta).toBeNull();
    expect(k.week).toBe(0);
    expect(k.inputShare).toBe(0);
  });
});

describe("buildTrend", () => {
  it("取尾部 n 天，比例相对列内最大日", () => {
    const days = [
      day("2026-10-03", 2, 40_000, 10_000),
      day("2026-10-04", 0, 0, 0),
      day("2026-10-05", 4, 80_000, 20_000),
    ];
    const cols = buildTrend(days, 14);
    expect(cols).toHaveLength(3);
    // 堆叠以「列内最大日合计」为基准：最大日(100k) 填满整列，输入 80% + 输出 20%
    expect(cols[2].inPct).toBe(80);
    expect(cols[2].outPct).toBe(20);
    // 零调用日保留但高度为 0
    expect(cols[1].inPct).toBe(0);
    expect(cols[1].tip).toContain("无");
  });

  it("n 大于数据长度时全量返回；今天行标记 isToday", () => {
    const today = localDateKey();
    const cols = buildTrend([day(today, 1, 100, 10)]);
    expect(cols).toHaveLength(1);
    expect(cols[0].isToday).toBe(true);
    expect(cols[0].label).toBe("今天");
  });
});

describe("fmtWan", () => {
  it("万级缩写", () => {
    expect(fmtWan(500)).toBe("500");
    expect(fmtWan(84_200)).toBe("8.4万");
    expect(fmtWan(842_000)).toBe("84万");
    expect(fmtWan(1_234_567)).toBe("123万");
  });
});

describe("buildHeatmap", () => {
  it("四分位分档，0 调用为 level 0", () => {
    const days = [
      day("2026-10-01", 1, 100, 0), // P25 基准
      day("2026-10-02", 1, 200, 0),
      day("2026-10-03", 1, 300, 0),
      day("2026-10-04", 1, 400, 0),
      day("2026-10-05", 0, 0, 0),
    ];    const cells = buildHeatmap(days);
    expect(cells.find((c) => c.date === "2026-10-05")?.level).toBe(0);
    expect(cells.find((c) => c.date === "2026-10-01")?.level).toBe(1);
    expect(cells.find((c) => c.date === "2026-10-04")?.level).toBe(4);
  });

  it("全零序列不抛错、全为 0 档", () => {
    const cells = buildHeatmap([day("2026-10-01", 0, 0, 0), day("2026-10-02", 0, 0, 0)]);
    expect(cells.every((c) => c.level === 0)).toBe(true);
  });

  it("tip 含日期与数值/无调用", () => {
    const cells = buildHeatmap([day("2026-10-01", 2, 84_200, 100), day("2026-10-02", 0, 0, 0)]);
    expect(cells[0].tip).toContain("10/1");
    expect(cells[0].tip).toContain("8.4万");
    expect(cells[1].tip).toContain("无调用");
  });
});

describe("rankTools", () => {
  it("Top 4 + 其余并入其他，比例相对最大值", () => {
    const rows = rankTools([
      tool("a", 40, 0),
      tool("b", 20, 0),
      tool("c", 8, 0),
      tool("d", 4, 0),
      tool("e", 2, 0),
      tool("f", 1, 0),
    ]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ label: "a", value: 40, ratio: 1, colorIdx: 0 });
    expect(rows[4]).toMatchObject({ label: "__other__", value: 3, colorIdx: -1 });
    expect(rows[1].ratio).toBeCloseTo(0.5, 5);
  });

  it("不足 topN 时不产生其他行", () => {
    const rows = rankTools([tool("a", 10, 0), tool("b", 5, 0)]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.colorIdx >= 0)).toBe(true);
  });

  it("空列表返回空数组", () => {
    expect(rankTools([])).toEqual([]);
  });
});
