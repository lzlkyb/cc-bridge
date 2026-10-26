import { describe, expect, it } from "vitest";
import {
  cacheHitRatio,
  formatElapsed,
  formatPercent,
  formatSpeed,
  formatUsd,
  readUsageParts,
  totalTokens,
  turnSpeed,
} from "./ccTurnStat";

/**
 * 口径测试。这些数字会直接显示给用户，算错了没人能一眼看出来 ——
 * 只会在「速度怎么这么低」的困惑里慢慢失去信任。
 */
describe("readUsageParts", () => {
  it("拆出四类，cache 不并进 input", () => {
    const p = readUsageParts({
      input_tokens: 28307,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 89500,
      output_tokens: 4200,
    });
    expect(p).toEqual({ input: 28307, cacheWrite: 1200, cacheRead: 89500, output: 4200 });
  });

  it("拆开之后的 input 只算未命中的部分（这是与旧口径的关键差别）", () => {
    const p = readUsageParts({ input_tokens: 100, cache_read_input_tokens: 9000 });
    expect(p.input).toBe(100);
    expect(p.cacheRead).toBe(9000);
    expect(totalTokens(p)).toBe(9100);
  });

  it("缺字段 / 负值 / 非数字一律按 0", () => {
    expect(readUsageParts(null)).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    expect(
      readUsageParts({ input_tokens: null, output_tokens: -5, cache_read_input_tokens: "9000" }),
    ).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });
});

describe("turnSpeed", () => {
  it("只算 output，按生成时长折算", () => {
    // 400 token / 4 秒 = 100 tok/s（真实量级，不虚构上千的数字）
    expect(turnSpeed(400, 4000)).toBe(100);
    expect(turnSpeed(300, 10_000)).toBe(30);
  });

  it("没有生成时长就是 null，不拿墙钟顶替", () => {
    expect(turnSpeed(4000, null)).toBeNull();
    expect(turnSpeed(4000, 0)).toBeNull();
    expect(turnSpeed(4000, -1)).toBeNull();
  });

  it("没有输出也是 null（0 tok/s 会被读成「卡住了」）", () => {
    expect(turnSpeed(0, 5000)).toBeNull();
  });

  /// 🔴 计时失真时宁可显示「—」：伪流式网关一次把全文给完（2026-10-26 探针实测
  /// 整轮 1 条 `content_block_delta`），`message_stop` 紧跟其后 ⇒ 分母只有几毫秒，
  /// 300 token 会印成 `100000 tok/s`。上界 400 留了四倍余量（Opus/Sonnet 峰值
  /// 100~150 tok/s），超过的只可能是计时坏了。
  it("🔴 速度超过物理上界就返回 null，不印荒谬值", () => {
    expect(turnSpeed(300, 3)).toBeNull();
    expect(turnSpeed(4000, 4000)).toBeNull(); // 1000 tok/s：不可能
    expect(turnSpeed(390, 1000)).toBe(390); // 上界内仍保留
  });

  it("🔴 它是「吐字速度」，不是「整轮速度」", () => {
    // 同样 400 token：生成 4 秒 vs 墙钟 60 秒（大半在跑工具）。
    // 用墙钟算会显示 6.7 tok/s，用生成时长算才是 100。
    expect(turnSpeed(400, 4000)).toBe(100);
    expect(turnSpeed(400, 60_000)).toBeCloseTo(6.67, 1);
  });
});

describe("cacheHitRatio", () => {
  it("命中量 ÷ 全部输入侧 token", () => {
    expect(
      cacheHitRatio({ input: 100, cacheWrite: 0, cacheRead: 900, output: 50 }),
    ).toBeCloseTo(0.9, 5);
  });

  it("没有输入时不给比例", () => {
    expect(cacheHitRatio({ input: 0, cacheWrite: 0, cacheRead: 0, output: 10 })).toBeNull();
  });
});

describe("格式化", () => {
  it("速度：100 以上取整，10 以下留一位", () => {
    expect(formatSpeed(1234.6)).toBe("1235 tok/s");
    expect(formatSpeed(38.4)).toBe("38 tok/s");
    expect(formatSpeed(3.14)).toBe("3.1 tok/s");
    expect(formatSpeed(null)).toBe("—");
  });

  it("时长：秒 / 分，与设置页的中文口径分开", () => {
    expect(formatElapsed(400)).toBe("0.4s");
    expect(formatElapsed(12_300)).toBe("12s");
    expect(formatElapsed(72_000)).toBe("1m12s");
    expect(formatElapsed(null)).toBe("—");
  });

  it("金额：不足一分时多给一位，避免全是 $0.00", () => {
    expect(formatUsd(0.28)).toBe("$0.28");
    expect(formatUsd(0.0031)).toBe("$0.003");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(null)).toBe("—");
  });

  it("百分比取整", () => {
    expect(formatPercent(0.9634)).toBe("96%");
    expect(formatPercent(null)).toBe("—");
  });
});
