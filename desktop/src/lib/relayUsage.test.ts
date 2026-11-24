import { describe, expect, it } from "vitest";
import type { RelayLogEntry } from "./types";
import { estimateCost, mergeRelayHistory, rateKey, relayUsageCsv, relayUsageState, shiftDay, summarizeUsage, tokenTotal } from "./relayUsage";

const usage = { input: 1_000, cacheWrite: 200, cacheRead: 8_000, output: 300, partial: false };
const rates = { '["https://up.example.com","actual-model"]': { input: 3, cacheWrite: 4, cacheRead: 0.3, output: 15 } };
const call: RelayLogEntry = {
  id: 1, requestId: "first", tsMs: new Date(2026, 10, 24, 10).getTime(), source: "local", clientModel: "claude-sonnet-5-5",
  tier: "default", upstreamModel: "upstream-alias", upstreamProvider: "https://up.example.com", reportedModel: "actual-model",
  fellBack: false, via: "alias", rewrite: null, foldSummary: null, sanitized: false, status: 200, firstByteMs: 120,
  totalMs: 400, bytesIn: 600, bytesOut: 900, error: null, path: "/v1/messages", usage,
};

describe("中转用量与计价", () => {
  it("使用实际模型单价，分开缓存读写和普通输入", () => {
    const summary = summarizeUsage([call], rates);
    expect(summary.total).toBe(9500);
    expect(summary.input).toBe(9200);
    expect(summary.hit).toBeCloseTo(8000 / 9200 * 100);
    expect(summary.cost).toBeCloseTo(0.0107);
    expect(estimateCost({ ...call, reportedModel: null }, rates)).toBeNull();
  });

  it("保留真实的零与部分用量，费用只覆盖完整可计价记录", () => {
    const partial = { ...call, usage: { ...usage, input: 0, output: null, partial: true } };
    expect(tokenTotal({ ...usage, input: 0, cacheWrite: null, cacheRead: null, output: null })).toBe(0);
    expect(tokenTotal(undefined)).toBeNull();
    expect(relayUsageState({ ...call, usage: null, usageCollectionIssue: "responseTooLarge" })).toBe("响应过大，未采集");
    expect(relayUsageState({ ...call, usage: null, usageCollectionIssue: "unsupportedEncoding" })).toBe("响应编码不支持采集");
    expect(estimateCost(partial, rates)).toBeNull();
    expect(summarizeUsage([call, partial, { ...call, usage: null }], rates)).toMatchObject({ covered: 2, partial: 1, priced: 1, total: 17700 });
  });

  it("同一域名上的不同上游端点使用各自的美元单价", () => {
    const first = { ...call, upstreamKey: "first-endpoint" };
    const second = { ...call, upstreamKey: "second-endpoint" };
    const configured = { [rateKey(first)!]: Object.values(rates)[0] };
    expect(estimateCost(first, configured)).toBeCloseTo(0.0107);
    expect(estimateCost(second, configured)).toBeNull();
  });

  it("同一请求合并一次，重启后同序号的记录仍独立", () => {
    const waiting = { ...call, status: null, usage: null };
    const other = { ...call, requestId: "second", tsMs: call.tsMs + 1 };
    expect(mergeRelayHistory([call, other], [waiting])).toEqual([other, call]);
    expect(mergeRelayHistory([waiting], [call])).toEqual([call]);
  });

  it("保留本地日历边界与 CSV 空值，模型名按文本导出", () => {
    expect(shiftDay("2026-11-02", -6)).toBe("2026-10-27");
    const csv = relayUsageCsv([{ ...call, clientModel: '=HYPERLINK("example")', usage: null }], rates);
    expect(csv).toContain("2026-11-24");
    expect(csv).toContain(`"'=HYPERLINK(""example"")"`);
    expect(csv).toContain('"","","","","","","上游未上报"');
  });
});
