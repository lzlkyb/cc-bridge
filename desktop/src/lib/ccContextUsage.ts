/**
 * 上下文余量条的纯计算层（对话 GUI 批 2-1）。
 *
 * 唯一数据源是 `result.modelUsage.<model>`（探针 0-3 实测：每轮 `result` 都带，
 * 字段是 **camelCase**——`inputTokens` / `outputTokens` / `contextWindow`，
 * 与 `usage` 的 snake_case 不是一套命名，读错键不会报错、只会永远是 0）。
 *
 * 🔴 口径（设计稿定，改一处要连测试一起改）：
 *    - 一个模型的「已用」= 它的 `inputTokens + outputTokens`（该模型累计，
 *      **不是**本轮增量——CLI 给的就是累计值）；
 *    - 多模型同时出现（主模型 + 子代理模型）时取 `inputTokens` 最大者：
 *      上下文窗口属于主模型，拿小模型的账去比大窗口会显示得过分富裕；
 *    - `contextWindow` 缺失 ⇒ `window = null` ⇒ 余量条不显示，退回「只显示
 *      已用 token」的旧形态。没有窗口就没有「余量」可言，编一个默认值比不显示更糟。
 */

/** 一个模型的累计用量。 */
export type CcModelUsage = {
  input: number;
  output: number;
  /** 上下文窗口。`null` = CLI 没报（老版本 / 未知模型）。 */
  window: number | null;
};

/** 余量条的显示数据。 */
export type CcContextBar = {
  used: number;
  window: number;
  /** `used / window`，**可以 > 1**：窗口被超过时 CLI 会自己压缩，条子溢满只是视觉。 */
  ratio: number;
  /** 取的是哪个模型的账（多模型时是 input 最大者，tooltip 里说明）。 */
  model: string;
};

/** 已用占比达到这个值就变琥珀并提示 `/compact`。 */
export const CONTEXT_WARN_RATIO = 0.8;

/** 只收正有限数：CLI 会给 `null`、字符串、乃至负数（探测期见过），一律按 0。 */
function posNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 读 `result.modelUsage`。键是模型名，原样保留（界面只在 tooltip 里展示）。
 *
 * 逐字段判型而不整个信任：协议版本间还在加键，读不出来的字段归零/归 null，
 * 整个模型条目只有连值都不是对象时才丢。
 */
export function readModelUsage(
  raw: Record<string, unknown> | null | undefined,
): Record<string, CcModelUsage> {
  const out: Record<string, CcModelUsage> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [model, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const m = v as Record<string, unknown>;
    const window = posNum(m.contextWindow);
    out[model] = {
      input: posNum(m.inputTokens),
      output: posNum(m.outputTokens),
      window: window > 0 ? window : null,
    };
  }
  return out;
}

/**
 * 选出要显示的那个模型并算余量。没有可用窗口时返回 `null`（界面退回旧形态）。
 */
export function contextBar(usage: Record<string, CcModelUsage>): CcContextBar | null {
  let best: string | null = null;
  for (const [model, u] of Object.entries(usage)) {
    if (best === null || u.input > usage[best].input) best = model;
  }
  if (best === null) return null;
  const u = usage[best];
  if (u.window === null) return null;
  const used = u.input + u.output;
  return { used, window: u.window, ratio: used / u.window, model: best };
}

/** 条子宽度百分比（0-100 整数）。ratio > 1 时夹到 100——溢出靠颜色说，不靠超出容器。 */
export function contextPercent(bar: CcContextBar): number {
  return Math.min(100, Math.max(0, Math.round(bar.ratio * 100)));
}

/**
 * 会话条的紧凑 token 格式：`999 → "999"`、`40200 → "40.2K"`、`1500000 → "1.5M"`。
 *
 * 与设置页 `fmtTokens`（utils.ts）的「万」口径**刻意不同**：会话条是等宽紧凑行、
 * 既有显示一直是 K/M，换口径会让老用户对不上账；设置页是中文仪表盘，用万。
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
