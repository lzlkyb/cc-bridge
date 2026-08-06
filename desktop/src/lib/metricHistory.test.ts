import { describe, it, expect, beforeEach } from "vitest";
import {
  pushSample,
  getSeries,
  getRemoteActivity,
  __resetMetricHistoryForTest,
  MAX_POINTS,
  MAX_GAP_MS,
} from "./metricHistory";
import type { StatusResponse } from "./types";

/** 造一份最小 stats，只填本模块读的那几个字段。 */
function stats(over: Partial<StatusResponse["stats"]> = {}): StatusResponse["stats"] {
  return {
    totalRequests: 0,
    totalErrors: 0,
    successRate: 100,
    requestsPerMin: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    rateLimitHits: 0,
    authDenies: 0,
    auditCount: 0,
    activeCommands: 0,
    topTools: [],
    ...over,
  };
}

const activity = () => getRemoteActivity().lastIncreaseAt;

describe("metricHistory", () => {
  beforeEach(() => {
    __resetMetricHistoryForTest();
  });

  it("🔴 首次采样即为绝对量指标产出一个点，只有 delta 留空", () => {
    // rpm/p95/active 是绝对量，第一次采样就有效；delta 是差值，首次无从得知。
    pushSample(stats({ totalRequests: 100, requestsPerMin: 5, p95LatencyMs: 40, activeCommands: 2 }), 1_000);
    expect(getSeries("rpm")).toEqual([5]);
    expect(getSeries("p95")).toEqual([40]);
    expect(getSeries("active")).toEqual([2]);
    expect(getSeries("delta")).toEqual([]);
  });

  it("连续采样累积点，delta 取相邻差值", () => {
    pushSample(stats({ totalRequests: 100 }), 1_000);
    pushSample(stats({ totalRequests: 106, requestsPerMin: 12, p95LatencyMs: 40 }), 6_000);
    pushSample(stats({ totalRequests: 110, requestsPerMin: 8, p95LatencyMs: 55 }), 11_000);

    expect(getSeries("delta")).toEqual([6, 4]);
    // rpm/p95 多一个首次采样的点（stats() 默认 0）
    expect(getSeries("rpm")).toEqual([0, 12, 8]);
    expect(getSeries("p95")).toEqual([0, 40, 55]);
  });

  it(`间隔超过 ${MAX_GAP_MS}ms 算断层，清空重来而不是把断层接上去`, () => {
    pushSample(stats({ totalRequests: 100 }), 1_000);
    pushSample(stats({ totalRequests: 106, requestsPerMin: 12 }), 6_000);
    expect(getSeries("rpm")).toEqual([0, 12]);

    // 窗口隐藏了半小时，回来后的第一次采样：旧序列作废，但新采样本身立即入列
    pushSample(stats({ totalRequests: 400, requestsPerMin: 30 }), 6_000 + 30 * 60_000);
    expect(getSeries("rpm")).toEqual([30]);

    // 重建基线后正常累积；delta 绝不能把断层期间的 294 次算进来
    pushSample(stats({ totalRequests: 402, requestsPerMin: 31 }), 6_000 + 30 * 60_000 + 5_000);
    expect(getSeries("delta")).toEqual([2]);
  });

  it(`超过 ${MAX_POINTS} 点后从头丢弃，长度封顶`, () => {
    let t = 1_000;
    pushSample(stats({ totalRequests: 0 }), t);
    for (let i = 1; i <= MAX_POINTS + 10; i++) {
      t += 5_000;
      pushSample(stats({ totalRequests: i, requestsPerMin: i }), t);
    }
    const rpm = getSeries("rpm");
    expect(rpm).toHaveLength(MAX_POINTS);
    expect(rpm[rpm.length - 1]).toBe(MAX_POINTS + 10); // 最新在末尾
    expect(rpm[0]).toBe(11); // 最早的已被丢
  });

  it("每次采样必须产生新数组引用（否则 useSyncExternalStore 看不到变化）", () => {
    pushSample(stats({ totalRequests: 0 }), 1_000);
    pushSample(stats({ totalRequests: 1, requestsPerMin: 1 }), 6_000);
    const first = getSeries("rpm");
    pushSample(stats({ totalRequests: 2, requestsPerMin: 2 }), 11_000);
    expect(getSeries("rpm")).not.toBe(first);
  });

  it("totalRequests 回退（服务重启计数归零）时 delta 不得为负", () => {
    pushSample(stats({ totalRequests: 500 }), 1_000);
    pushSample(stats({ totalRequests: 3 }), 6_000);
    expect(getSeries("delta")).toEqual([0]);
  });

  it("lastIncreaseAt 仅在真的有新调用时前推，断层时重置为 null", () => {
    pushSample(stats({ totalRequests: 100 }), 1_000);
    expect(activity()).toBeNull();

    pushSample(stats({ totalRequests: 100 }), 6_000); // 无新调用
    expect(activity()).toBeNull();

    pushSample(stats({ totalRequests: 103 }), 11_000); // 有新调用
    expect(activity()).toBe(11_000);

    pushSample(stats({ totalRequests: 103 }), 16_000); // 又没新调用 → 保持不变
    expect(activity()).toBe(11_000);

    // 断层：期间可能发生过调用但没观测到，再拿旧时间说「N 秒前」就是错的
    pushSample(stats({ totalRequests: 900 }), 16_000 + MAX_GAP_MS + 1);
    expect(activity()).toBeNull();
  });

  it("getRemoteActivity 快照幂等（同值时返回同一引用）", () => {
    pushSample(stats({ totalRequests: 100 }), 1_000);
    expect(getRemoteActivity()).toBe(getRemoteActivity());
  });
});
