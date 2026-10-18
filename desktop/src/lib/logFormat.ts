import type { AuditEntry } from "./types";
import { toolLabel } from "./utils";

/**
 * 审计日志的「JSON 参数 → 展示字符串」纯函数。
 *
 * 为什么单独成文件而不是塞进 `lib/utils.ts`（规则 11）：utils.ts 已 307 行，
 * 且 `lib/` 下早已按主题分模块（`sshErrors` / `uploadDir` / `auditError` /
 * `terminalPaste` …）。这里收的是**同一件事的三种粒度**，放一起才能看出它们是
 * 一套降级策略（parse 失败一律退回原文，绝不抛异常）：
 *   - `summarizeParams`：表格行内一句话摘要
 *   - `perfSummaryLine`：性能折叠条的全局统计
 *   - `prettyParams`：展开详情的完整美化
 *
 * 2026-09-16：三者原本散在 `LogTab.tsx` 与 `LogDetailPanel.tsx`，两边各自实现
 * 了一遍「parse 失败怎么退」。抽出后一并补上单测——之前零覆盖。
 */

/** 截断到 n 个字符，超出补省略号。 */
function clip(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * 参数原始 JSON → 表格行内简短摘要。只挑人真正关心的字段：
 * 文件批量操作的项数、路径末段、oldString 片段。parse 失败退回原文截断。
 */
export function summarizeParams(raw: string): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return clip(raw);
  }
  if (!obj || typeof obj !== "object") return clip(raw);
  const parts: string[] = [];
  if (Array.isArray(obj.files)) {
    parts.push(`files: ${obj.files.length} 项`);
    if (typeof obj.encoding === "string") parts.push(`encoding: ${obj.encoding}`);
  } else if (typeof obj.path === "string") {
    parts.push(`path: …/${obj.path.split(/[\\/]/).pop() || obj.path}`);
  }
  if (typeof obj.oldString === "string") parts.push(`oldString: "${clip(obj.oldString, 20)}"`);
  return parts.length ? parts.join(" · ") : clip(raw);
}

/**
 * 折叠条上的实时摘要：自动加载后的关键信号，无需展开即可判断瓶颈。
 *
 * 没有 `duratioMs` 的条目（旧后端写入的）被整体排除在统计外——把它们当 0
 * 会稀释 P95、把错误率算歪。
 */
export function perfSummaryLine(entries: AuditEntry[]): string {
  const valid = entries.filter(
    (e): e is AuditEntry & { durationMs: number } => typeof e.durationMs === "number",
  );
  if (valid.length === 0) return "暂无耗时数据";
  const ds = valid.map((e) => e.durationMs).sort((a, b) => a - b);
  const p95 = ds[Math.min(ds.length - 1, Math.floor((ds.length - 1) * 0.95))];
  const total = ds.reduce((s, d) => s + d, 0);
  const byTool = new Map<string, number>();
  for (const e of valid) byTool.set(e.tool, (byTool.get(e.tool) ?? 0) + e.durationMs);
  let topTool = "";
  let topSum = -1;
  for (const [t, s] of byTool)
    if (s > topSum) {
      topSum = s;
      topTool = t;
    }
  const errRate = entries.length ? (entries.filter((e) => !e.success).length / entries.length) * 100 : 0;
  // 🔴 全 0 耗时（or 全部条目耗时为 0）时 total=0 → topSum/total = NaN，界面上会出现
  // 「占 NaN%」（审查 P2）。占比无意义时直接写 0.0%（而不是隐藏整段——其余指标仍有用）。
  const topShare = total > 0 ? ((topSum / total) * 100).toFixed(1) : "0.0";
  return `P95 ${Math.round(p95)}ms · ${toolLabel(topTool)} 占 ${topShare}% · 错误率 ${errRate.toFixed(1)}%`;
}

/** 尝试 pretty-print JSON；失败退回原文。 */
export function prettyParams(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * 审计条目的**稳定**行 key：时间 + 工具 + 来源 IP + params 短哈希。
 *
 * 曾用过「拼上 durationMs」的版本——10s 轮询重拉数据后，凡 key 的任一段变化
 * 就整行（连同展开的详情行）重挂载，展开态静默收起。durationMs 是**同一条
 * 历史记录的固有属性**，不该进身份；timestamp+tool+sourceIp 才是它「是哪一次
 * 调用」的标识。
 *
 * 🔴 但只有这三段仍会撞（审查 P2）：batch / 循环里同一秒调用同一工具两次很常见，
 * 撞了之后两条行共用一个 key → React 认为同一条，展开一条另一条跟着展开、详情串位。
 * 加入 params 短哈希后，碰撞要求「同秒同工具同 IP 且参数完全一致」——那种情况两行
 * 内容本来就一样，共用展开态无副作用。params 是历史记录的固定值，不随轮询变化，
 * 因此仍满足「稳定」要求。（不用 durationMs：它从「进行中」变「已完成」时会变。）
 */
export function auditRowKey(e: AuditEntry): string {
  return `${e.timestamp}-${e.tool}-${e.sourceIp ?? ""}-${hash32(e.params)}`;
}

/** 32 位 FNV-1a：只为把 params 压成短串当 key 用，不用于安全场景。 */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
