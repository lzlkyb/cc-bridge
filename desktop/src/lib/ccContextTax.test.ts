import { describe, expect, it } from "vitest";
import {
  CLIENT_DROP_CHARS,
  TOOL_INLINE_CHARS,
  breakdown,
  formatBytes,
  formatK,
  percentOf,
  severityOf,
  warnLevel,
  type CcContextTax,
  type CcContextTaxHit,
} from "./ccContextTax";

const tax = (patch: Partial<CcContextTax> = {}): CcContextTax => ({
  sessionId: "s-1",
  calls: 10,
  resultBytes: 32_000,
  paramsBytes: 2_000,
  estTokens: 8_000,
  tools: [
    { tool: "read_files", calls: 3, resultBytes: 20_800, estTokens: 5_200, maxChars: 24_000 },
    // 20_800 + 11_200 = 32_000 字节 ⇒ estTokens 8_000，与顶层三个数自洽
    { tool: "run_command", calls: 5, resultBytes: 11_200, estTokens: 2_800, maxChars: 8_000 },
  ],
  oversized: [],
  oversizedTotal: 0,
  droppedTotal: 0,
  charlessCalls: 0,
  ...patch,
});

const hit = (chars: number): CcContextTaxHit => ({
  tool: "read_files",
  target: "D:/big.log",
  resultBytes: chars,
  wireChars: chars,
  timestamp: "2026-10-25T12:00:00+08:00",
});

describe("breakdown", () => {
  it("工具结果 + 其他 == 上下文总量（用户要能对上账）", () => {
    const b = breakdown(tax(), 40_000);
    const group = b.rows.find((r) => r.kind === "group")!;
    const other = b.rows.find((r) => r.kind === "other")!;
    expect(group.tokens + other.tokens).toBe(40_000);
  });

  it("「其他」把系统提示与 CC 内置工具都算进去，不是只报工具那 20%", () => {
    // 这正是这个面板存在的理由：只报工具会让用户以为「才 8K，那 32K 哪来的」
    const b = breakdown(tax(), 40_000);
    expect(b.otherTokens).toBe(32_000);
  });

  it("工具行之和等于分组行（顶层 estTokens 已排除入参）", () => {
    const b = breakdown(tax(), 40_000);
    const group = b.rows.find((r) => r.kind === "group")!;
    const items = b.rows.filter((r) => r.kind === "tool");
    expect(items.reduce((a, r) => a + r.tokens, 0)).toBe(group.tokens);
  });

  it("比例分母用总量，不是工具账（否则工具永远占 100%）", () => {
    const b = breakdown(tax(), 40_000);
    const group = b.rows.find((r) => r.kind === "group")!;
    expect(percentOf(group.share)).toBe(20);
  });

  it("/compact 之后工具账大于当前占用 ⇒ 其他归零并标记压缩过", () => {
    // 压缩前计入的工具结果已经不在上下文里，但审计还留着它们
    const b = breakdown(tax({ estTokens: 50_000 }), 20_000);
    expect(b.compressed).toBe(true);
    expect(b.otherTokens).toBe(0);
    // 分母不能让比例条超过 100%
    expect(b.rows.every((r) => r.share <= 1)).toBe(true);
  });

  it("没有经桥调用时明确报空（不是显示一堆 0 让用户以为坏了）", () => {
    const b = breakdown(tax({ calls: 0, estTokens: 0, tools: [] }), 40_000);
    expect(b.empty).toBe(true);
    expect(b.rows).toHaveLength(0);
    // 空态下「其他」就是全部
    expect(b.otherTokens).toBe(40_000);
  });

  it("还没查到（null）不炸，且不把总量算成 0", () => {
    const b = breakdown(null, 12_000);
    expect(b.empty).toBe(true);
    expect(b.total).toBe(12_000);
  });

  it("总量为 0（CLI 还没报用量）时比例是 0 不是 NaN", () => {
    const b = breakdown(tax({ estTokens: 0, calls: 0, tools: [] }), 0);
    expect(b.total).toBe(0);
    expect(b.rows).toHaveLength(0);
  });

  it("单工具越线时该行标 hot（用户要知道是哪一类调用在大口吃）", () => {
    const big = tax({
      tools: [
        { tool: "read_files", calls: 1, resultBytes: 50_000, estTokens: 12_500, maxChars: TOOL_INLINE_CHARS },
      ],
    });
    const row = breakdown(big, 60_000).rows.find((r) => r.kind === "tool")!;
    expect(row.hot).toBe(true);
  });
});

describe("severityOf", () => {
  it("45,000–49,822 是我们自己截断（内容到了，尾部丢）", () => {
    expect(severityOf(hit(TOOL_INLINE_CHARS))).toBe("clip");
    expect(severityOf(hit(CLIENT_DROP_CHARS - 1))).toBe("clip");
  });

  it("≥49,823 是客户端整条降级（模型没看到）", () => {
    expect(severityOf(hit(CLIENT_DROP_CHARS))).toBe("drop");
    expect(severityOf(hit(180_000))).toBe("drop");
  });
});

describe("warnLevel", () => {
  it("没越线就整块不出现", () => {
    expect(warnLevel(tax())).toBe("none");
    expect(warnLevel(null)).toBe("none");
  });

  it("只有裁剪时是轻一档", () => {
    expect(warnLevel(tax({ oversizedTotal: 2 }))).toBe("clip");
  });

  it("有降级时按重的说（哪怕同时也只有裁剪）", () => {
    expect(warnLevel(tax({ oversizedTotal: 5, droppedTotal: 1 }))).toBe("drop");
  });
});

describe("格式化", () => {
  it("formatK 与会话条同一口径（不用「万」，同一屏两套数会看错）", () => {
    expect(formatK(999)).toBe("999");
    expect(formatK(40_200)).toBe("40.2K");
    expect(formatK(1_500_000)).toBe("1.5M");
    expect(formatK(0)).toBe("0");
    expect(formatK(Number.NaN)).toBe("0");
  });

  it("formatBytes 用 KB/MB（审计存的是字节，面板要说人话）", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(182_600)).toBe("178.3 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("percentOf 不吐 NaN", () => {
    expect(percentOf(0)).toBe(0);
    expect(percentOf(Number.NaN)).toBe(0);
    expect(percentOf(0.205)).toBe(21);
    expect(percentOf(1.4)).toBe(100);
  });
});
