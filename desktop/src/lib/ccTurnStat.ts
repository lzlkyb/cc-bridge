/**
 * 一轮对话的用量与速度（纯计算层，无 React）。
 *
 * ## 口径为什么不是「墙钟」
 *
 * `result.duration_ms` 是整轮墙钟：它把首 token 等待、每次工具执行、用户审批的
 * 犹豫全算进去了。拿它当分母会得出一个荒谬的数——一次跑三十个 Edit 的轮次，
 * 输出可能只有 4K token 而墙钟五分钟，显示 13 tok/s，用户以为模型在爬，实际是
 * 它在等你点「允许」。
 *
 * 所以分母用 Rust 侧算好的 `genMs`：本轮每个 API 请求「首个输出片段 →
 * `message_stop`」的时长之和（`proto.rs::GenTimer`）。这是 GitHub 上做同一件事
 * 的项目共同口径（`cc-use` 的 REQUEST_PERFORMANCE 写得最明白：输入与缓存 token、
 * 首 token 前的等待、输出后的收尾都不计入）。
 *
 * ## 为什么速度只算 output
 *
 * input 与 cache 是「喂进去的」，不是「产出的」。把它们算进分子，读一千次文件的
 * 轮次会显示成高得离谱的速度。速度只回答一个问题：模型吐字有多快。
 */

/** 一轮的用量快照。**本轮增量**，不是会话累计。 */
export type CcTurnStat = {
  /**
   * 该轮最后一条消息的 id。渲染时据此把脚注插在正确的位置。
   *
   * 空串 = 这一轮还没产出任何消息（比如只发了一句就报错）。
   */
  afterId: string;
  /** 未命中的输入 token。 */
  input: number;
  /** 写缓存的 token（比未缓存输入贵 25%）。 */
  cacheWrite: number;
  /** 命中缓存的 token（比未缓存输入便宜 90%）。 */
  cacheRead: number;
  /** 产出的 token。 */
  output: number;
  /**
   * 纯生成时长（ms）。`null` = 没测到：老版本 CLI 不发 `message_stop`、
   * 或者这一轮压根没有流式输出。**不要拿墙钟顶替**——那会把工具时间算进速度。
   */
  genMs: number | null;
  /** 整轮墙钟。明细里与 `genMs` 对比，能看出「等了多久、真正生成了多久」。 */
  durationMs: number | null;
  /** 首 token 延迟。 */
  ttftMs: number | null;
  /** CLI 累计 API 时长。 */
  apiMs: number | null;
  /** 本轮成本（USD）。由累计值相减得出；`null` = CLI 没报。 */
  costUsd: number | null;
  /** 这一轮是错误结束（`result.is_error`）。 */
  isError: boolean;
};

/** `usage` 拆出来的四类。 */
export type CcUsageParts = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

const EMPTY_PARTS: CcUsageParts = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

/** 只收正有限数：CLI 会给 `null`、字符串、负数，一律按 0。 */
function pos(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 从 `result.usage` / `message_delta.usage` 拆出四类 token。字段名是 API 原样的
 * snake_case。
 *
 * 🔴 **必须拆开，不能把 cache 并进 input**：`cache_read_input_tokens` 是每轮都会
 * 重报的缓存命中量（实测一轮就有 89K）。并进 input 再跨轮累加，会话跑几轮后那个
 * 数字会虚高到完全失去意义——而这正是本次改动前 `ccReducer` 的做法。
 */
export function readUsageParts(usage: Record<string, unknown> | null | undefined): CcUsageParts {
  if (!usage || typeof usage !== "object") return EMPTY_PARTS;
  return {
    input: pos(usage.input_tokens),
    cacheWrite: pos(usage.cache_creation_input_tokens),
    cacheRead: pos(usage.cache_read_input_tokens),
    output: pos(usage.output_tokens),
  };
}

/** 四类相加 = 这一轮进出模型的总 token。 */
export function totalTokens(p: CcUsageParts): number {
  return p.input + p.cacheWrite + p.cacheRead + p.output;
}

/**
 * 输出速度（tok/s）。
 *
 * `genMs <= 0` 时返回 `null` 而不是 0 或 Infinity：不到 1ms 的「生成」只可能是
 * 数据异常，编一个数比不显示更糟。
 *
 * 🔴 还必须有**上界**。`gen_ms` 的分子分母都来自 CLI 的流式事件，而链路不一定
 * 真流式：2026-10-26 探针实测，当前网关一次把全文给完 —— 整轮只有 1 条
 * `content_block_delta`，它到 `message_stop` 的间隔只有几毫秒。这时
 * `gen_ms > 0` 完全成立，300 token / 3ms 会算出 `100000 tok/s` 印在界面上。
 * 判据取 400：Opus/Sonnet 的峰值在 100~150 tok/s，四倍余量足够容下最激进的
 * 模型，超出的只可能是计时失真。
 */
const MAX_PLAUSIBLE_SPEED = 400;

export function turnSpeed(output: number, genMs: number | null): number | null {
  if (genMs === null || genMs <= 0) return null;
  if (!Number.isFinite(output) || output <= 0) return null;
  const speed = output / (genMs / 1000);
  if (!Number.isFinite(speed) || speed > MAX_PLAUSIBLE_SPEED) return null;
  return speed;
}

/**
 * 缓存命中率（0~1）：命中量 ÷ 全部输入侧 token。
 *
 * `null` = 这一轮没有输入（纯模型自说自话）或数据缺失。用比例而不是「省了多少钱」，
 * 是因为 CLI 只给总成本、不给单价 —— 编一个单价去乘，得到的数字没法核对。
 */
export function cacheHitRatio(p: CcUsageParts): number | null {
  const denom = p.input + p.cacheWrite + p.cacheRead;
  if (denom <= 0) return null;
  return p.cacheRead / denom;
}

/** `38 tok/s`。100 以上取整（小数位是噪音），10 以下保留一位。 */
export function formatSpeed(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (v >= 100) return `${Math.round(v)} tok/s`;
  if (v >= 10) return `${v.toFixed(0)} tok/s`;
  return `${v.toFixed(1)} tok/s`;
}

/** 紧凑时长：`0.4s` / `12.3s` / `1m12s`。与设置页的中文口径刻意分开。 */
export function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

/** `$0.28` / `$0.003`。小于 1 分时多给一位，否则永远显示 `$0.00`。 */
export function formatUsd(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v < 0) return "—";
  if (v > 0 && v < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** 缓存命中率 → `96%`（整数，百分比的小数位没人读）。 */
export function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}
