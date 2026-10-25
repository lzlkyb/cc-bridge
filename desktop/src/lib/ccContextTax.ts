/**
 * 上下文税仪表的纯计算层（批 4-1）。不碰 React、不碰 IPC。
 *
 * ## 数据从哪来
 *
 * - **总量** `used`：`lib/ccContextUsage.ts::contextBar(usage)` 给的，与余量条同源；
 * - **构成**：`cc_context_tax` 命令从 `audit.log` 里按 `ccSessionId` 聚合出来的。
 *
 * ## 为什么不做「本轮」
 *
 * 审计条目只有会话归属、没有轮次号；而 `used` 是累计值、工具结果也是累计占用
 * （进了上下文就一直占着，不是每轮清零）。两者天然对齐 —— 硬切「本轮」会造出
 * 「本轮工具 2K、上下文 40K」这种没法解释的组合。所以这一屏叫「上下文构成」。
 *
 * ## 与批 2-6 的「两套账」关系
 *
 * 2-6 定死「工具账 ≈ 对话账的子集，不能相加」。本面板不破坏它：它把同一个
 * `est_tokens` 估算摆进一张分解里，并且**显式列出「其他」**——那一档就是
 * 系统提示 + 对话正文 + CC 内置工具（Read/Bash/Grep 不走桥，进不了工具账）。
 * 少了这一档，用户会问「工具才 8K，那 40K 哪来的」。
 */

/** Rust 侧 `context_tax::ContextTax` 的镜像（camelCase 契约，改名要连 Rust 一起改）。 */
export type CcContextTax = {
  sessionId: string;
  calls: number;
  resultBytes: number;
  paramsBytes: number;
  /** 只算工具**结果**的估算 token（不含入参）—— 各工具行之和就是它。 */
  estTokens: number;
  tools: CcContextTaxTool[];
  oversized: CcContextTaxHit[];
  oversizedTotal: number;
  droppedTotal: number;
  /** 老日志里没有 `resultChars` 的条数（> 0 时告警只能按「可能」说）。 */
  charlessCalls: number;
};

export type CcContextTaxTool = {
  tool: string;
  calls: number;
  resultBytes: number;
  estTokens: number;
  /** 该工具里最大的一次 wire 字符数。 */
  maxChars: number;
};

export type CcContextTaxHit = {
  tool: string;
  target: string;
  resultBytes: number;
  wireChars: number;
  timestamp: string;
};

/**
 * 客户端分档线（**字符**）：越过就整条降级成 2KB 预览，模型当轮看不到内容。
 *
 * 与 `desktop/src-tauri/src/cc_session/context_tax.rs::CLIENT_DROP_CHARS` 同源，
 * 改一处必须同步。前端也留一份是**故意的**：面板要按它分级着色，
 * 为这事每次多跑一个 IPC 不值得。
 */
export const CLIENT_DROP_CHARS = 49_823;

/** 我们自己主动裁剪到的线（同源：`mcp::tools::MAX_INLINE_CHARS`）。 */
export const TOOL_INLINE_CHARS = 45_000;

/** 一条越线告警的严重度：`drop` 是真的看不见内容，`clip` 只是尾部被截。 */
export type TaxSeverity = "clip" | "drop";

export function severityOf(hit: CcContextTaxHit): TaxSeverity {
  return hit.wireChars >= CLIENT_DROP_CHARS ? "drop" : "clip";
}

/** 面板上的一行。 */
export type TaxRow = {
  key: string;
  kind: "group" | "tool" | "other";
  label: string;
  /** 估算 token。 */
  tokens: number;
  /** 占上下文的比例（0–1）。分母是 `Math.max(used, toolTokens)`。 */
  share: number;
  /** 调用次数。只有 `tool` 行有。 */
  calls?: number;
  /** 该工具存在越线调用（行标黄）。 */
  hot?: boolean;
};

/** 分解结果 + 需要提示的边界情况。 */
export type TaxBreakdown = {
  rows: TaxRow[];
  /** 上下文中「不是经桥工具结果」的那部分（系统提示 / 正文 / CC 内置工具）。 */
  otherTokens: number;
  /** 分母：`used` 与工具账取大者（压缩过时工具账会大于当前占用）。 */
  total: number;
  /**
   * `/compact` 过：工具账超过了当前占用 ⇒ 压缩前计入的工具结果已不在上下文里。
   * 这时「其他」显示 0，并且要说清原因（否则用户会以为 80% 凭空消失了）。
   */
  compressed: boolean;
  /** 这条会话压根没有经桥调用（CC 内置工具不计入本面板）。 */
  empty: boolean;
};

/**
 * 把「上下文总量」拆成「工具结果（按工具）+ 其他」。
 *
 * @param tax  `cc_context_tax` 的返回值（`null` = 还没查到）
 * @param used 当前上下文已用 token（`contextBar(usage)?.used`，`0` = CLI 还没报）
 */
export function breakdown(tax: CcContextTax | null, used: number): TaxBreakdown {
  const toolTokens = tax?.estTokens ?? 0;
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
  // 分母取大者：正常情况 used 远大于工具账；/compact 之后工具账可能反而更大，
  // 那时比例条按工具账铺满，「其他」为 0 并给出压缩提示。
  const total = Math.max(safeUsed, toolTokens);
  const share = (n: number) => (total > 0 ? Math.min(1, n / total) : 0);

  if (!tax || (tax.calls === 0 && toolTokens === 0)) {
    return {
      rows: [],
      otherTokens: safeUsed,
      total,
      compressed: false,
      empty: true,
    };
  }

  const compressed = toolTokens > safeUsed;
  const otherTokens = compressed ? 0 : Math.max(0, safeUsed - toolTokens);

  const rows: TaxRow[] = [
    {
      key: "group:tools",
      kind: "group",
      label: "工具结果（经桥）",
      tokens: toolTokens,
      share: share(toolTokens),
    },
    ...tax.tools.map<TaxRow>((t) => ({
      key: `tool:${t.tool}`,
      kind: "tool",
      label: t.tool,
      tokens: t.estTokens,
      share: share(t.estTokens),
      calls: t.calls,
      hot: t.maxChars >= TOOL_INLINE_CHARS,
    })),
    {
      key: "other",
      kind: "other",
      label: "其他",
      tokens: otherTokens,
      share: share(otherTokens),
    },
  ];

  return { rows, otherTokens, total, compressed, empty: false };
}

/** 紧凑 K/M 格式。与会话条 `formatTokens` 同一口径（不引「万」，同一屏两套数会看错）。 */
export function formatK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 字节 → 人能读的 `KB` / `MB`（审计里存的是字节，面板要说「多大」）。 */
export function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${Math.round(b)} B`;
}

/** 百分比（整数）。0 分母返回 0，不返回 NaN。 */
export function percentOf(share: number): number {
  if (!Number.isFinite(share) || share <= 0) return 0;
  return Math.min(100, Math.round(share * 100));
}

/**
 * 告警区要不要显示，以及该用什么语气。
 *
 * - `none`：没有越线调用，整块不出现（常态）；
 * - `clip`：只有顶到裁剪线的（尾部被截，但内容到了）；
 * - `drop`：有被客户端整条降级的（模型真的没看到）。
 *
 * `charless > 0` 时前端必须把话说软一档：那些老日志只能按字节判，
 * 中文内容会偏高，不能当成「确定降级」。
 */
export function warnLevel(tax: CcContextTax | null): "none" | "clip" | "drop" {
  if (!tax) return "none";
  if (tax.droppedTotal > 0) return "drop";
  if (tax.oversizedTotal > 0) return "clip";
  return "none";
}
