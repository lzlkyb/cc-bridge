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
  const errRate = (entries.filter((e) => !e.success).length / entries.length) * 100;
  return `P95 ${Math.round(p95)}ms · ${toolLabel(topTool)} 占 ${((topSum / total) * 100).toFixed(1)}% · 错误率 ${errRate.toFixed(1)}%`;
}

/** 尝试 pretty-print JSON；失败退回原文。 */
export function prettyParams(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
