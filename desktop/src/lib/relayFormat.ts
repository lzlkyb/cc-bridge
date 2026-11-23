/**
 * 中转页的展示换算（纯函数，已单测）。
 *
 * 为什么单独一个文件：这些换算散在 7 张卡片里会有三四份「ms ≥ 1000 就换算成秒」
 * 的重复实现，而口径一旦分叉，同一屏里 1.2s 与 1200ms 会并排出现——连接页的
 * MetricCards 就踩过这个（8251 毫秒 vs 日志页的 8.25s）。
 *
 * 这里**不引入任何 React**，也不读全局状态：输入是后端字段，输出是字符串。
 */

import type { RelayLogEntry, RelayStats } from "./types";

/** 日志时间列。只到秒 —— 毫秒对排查没用，反而把这一列撑宽。 */
export function formatClock(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 耗时。≥1 秒换算成秒，与日志页的写法一致。空值统一 EM DASH。 */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function formatInt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

/**
 * 百分比。后端 `todayErrorRate` 已经是 0–100，不是 0–1 —— 这里只负责收小数位，
 * 不再乘 100（乘错的症状是「错误率 800%」，很容易在评审时被当成真数据）。
 */
export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

/** 改写标记 → 中文短标签。多个规则用 `+` 连（与后端 `rewrite_label` 同序）。 */
export function rewriteLabel(rewrite: string | null): string | null {
  if (!rewrite) return null;
  const names: Record<string, string> = {
    fold: "折叠",
    strip_suffix: "去后缀",
    clamp: "压上限",
  };
  return rewrite
    .split("+")
    .map((part) => names[part] ?? part)
    .join("+");
}

/** 来源列。回环统一叫「本机」，其余直接显示 IP（不猜是哪台机器）。 */
export function sourceLabel(source: string): string {
  return source === "local" ? "本机" : source;
}

/** 状态码 → 徽章色调。没有状态码（连接失败/被拒）算坏消息。 */
export function statusTone(status: number | null, error: string | null): "ok" | "bad" | "mute" {
  if (status == null) return error ? "bad" : "mute";
  return status >= 200 && status < 400 ? "ok" : "bad";
}

/** 状态列的文字：有码给码，没码给原因的极短形态。 */
export function statusText(entry: RelayLogEntry): string {
  if (entry.status != null) return String(entry.status);
  if (entry.error) return "失败";
  return "进行中";
}

/**
 * 今日请求 / 折叠 / 错误三档的变化量。用于指标卡的采样序列。
 *
 * 跨零点时后端把累计清零，直接相减会得到一个巨大负数——这里**钳到 0**：
 * 零点那一刻的「负吞吐」是统计口径造成的，不是真事。
 */
export function deltaOf(current: number, previous: number | null): number {
  if (previous == null) return 0;
  const diff = current - previous;
  return diff > 0 ? diff : 0;
}

/** 改写率（0–100）。分母为 0 时给 0，不产生 NaN。 */
export function foldRate(stats: RelayStats): number {
  return stats.todayRequests === 0 ? 0 : (stats.todayFolded * 100) / stats.todayRequests;
}

/** 某一档的命中占比（0–100）。 */
export function tierShare(count: number, total: number): number {
  return total <= 0 ? 0 : (count * 100) / total;
}

/**
 * 生成远端那份 settings 文件的整块命令。
 *
 * 为什么是「整块复制」而不是只给两个值：远端要改的是三条 JSON 键，让人自己拼
 * 引号与逗号是白送一次出错机会。注释第一句必须是「先备份原文件」——否则用户会
 * 担心覆盖掉自己已经配好的东西（§4.9.2）。
 */
export function buildRelaySnippet(input: {
  baseUrl: string;
  token: string;
  model: string;
}): string {
  const { baseUrl, token, model } = input;
  return [
    "# 1 写一份配置（先备份原文件，之前配过也没关系）",
    "mkdir -p ~/.claude-own && cp ~/.claude-own/own-model.json ~/.claude-own/own-model.json.bak 2>/dev/null",
    "cat > ~/.claude-own/own-model.json <<'EOF'",
    "{",
    '  "env": {',
    `    "ANTHROPIC_BASE_URL": "${baseUrl}",`,
    `    "ANTHROPIC_AUTH_TOKEN": "${token}",`,
    `    "ANTHROPIC_MODEL": "${model}"`,
    "  }",
    "}",
    "EOF",
    "",
    "# 2 加个别名，以后 claude-own 就是走中转的启动方式",
    'echo "alias claude-own=\'claude --settings ~/.claude-own/own-model.json\'" >> ~/.bashrc && source ~/.bashrc',
  ].join("\n");
}

/** 中转令牌掩码。后端已给 `tokenMasked`，这里只在前端自行缩短时用。 */
export function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 10) return `${token.slice(0, 3)}…`;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}
