import { describe, expect, it } from "vitest";
import {
  CONTEXT_WARN_RATIO,
  contextBar,
  contextPercent,
  formatTokens,
  readModelUsage,
} from "./ccContextUsage";

/**
 * 锁住两件事：camelCase 读取（读错键不报错、只会永远是 0，是最安静的坏法）
 * 和「没有窗口就不显示余量」的降级路径。
 */
describe("readModelUsage", () => {
  it("按 camelCase 读 inputTokens / outputTokens / contextWindow", () => {
    expect(
      readModelUsage({
        "claude-opus-5": { inputTokens: 40779, outputTokens: 384, contextWindow: 1000000 },
      }),
    ).toEqual({ "claude-opus-5": { input: 40779, output: 384, window: 1000000 } });
  });

  it("空 / 非对象入参返回空表", () => {
    expect(readModelUsage(null)).toEqual({});
    expect(readModelUsage(undefined)).toEqual({});
    expect(readModelUsage({})).toEqual({});
  });

  it("字段缺失或类型不对时归零，窗口缺失归 null", () => {
    expect(
      readModelUsage({
        m1: { inputTokens: "很多", outputTokens: null },
        m2: { inputTokens: 10, contextWindow: 0 },
        m3: { inputTokens: 5, contextWindow: -1 },
        m4: "不是对象",
        m5: [1, 2],
      }),
    ).toEqual({
      m1: { input: 0, output: 0, window: null },
      m2: { input: 10, output: 0, window: null },
      m3: { input: 5, output: 0, window: null },
    });
  });
});

describe("contextBar", () => {
  it("多模型取 inputTokens 最大者（窗口属于主模型）", () => {
    const bar = contextBar(
      readModelUsage({
        "claude-haiku-4": { inputTokens: 900, outputTokens: 9000, contextWindow: 200000 },
        "claude-opus-5": { inputTokens: 40779, outputTokens: 384, contextWindow: 1000000 },
      }),
    );
    expect(bar).toEqual({
      used: 41163,
      window: 1000000,
      ratio: 41163 / 1000000,
      model: "claude-opus-5",
    });
  });

  it("没有窗口返回 null（界面退回只显示已用 token）", () => {
    expect(contextBar(readModelUsage({ m: { inputTokens: 100, outputTokens: 20 } }))).toBeNull();
    expect(contextBar({})).toBeNull();
  });

  it("ratio 可以 >1：窗口被超过时 CLI 自己会压缩", () => {
    const bar = contextBar(
      readModelUsage({ m: { inputTokens: 900000, outputTokens: 200000, contextWindow: 1000000 } }),
    );
    expect(bar?.ratio).toBeCloseTo(1.1);
    expect(contextPercent(bar!)).toBe(100);
    expect(bar!.ratio >= CONTEXT_WARN_RATIO).toBe(true);
  });

  it("占比未到阈值不变琥珀", () => {
    const bar = contextBar(
      readModelUsage({ m: { inputTokens: 100, outputTokens: 100, contextWindow: 1000 } }),
    );
    expect(bar!.ratio).toBeCloseTo(0.2);
    expect(bar!.ratio >= CONTEXT_WARN_RATIO).toBe(false);
    expect(contextPercent(bar!)).toBe(20);
  });
});

describe("formatTokens", () => {
  it("K / M 两档缩写，与设置页的「万」口径互不干扰", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(40200)).toBe("40.2K");
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(1500000)).toBe("1.5M");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});
