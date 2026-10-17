import type { TokenUsageDay, TokenUsageReport, TokenUsageTool } from "./types";
import { shortDateKey } from "./utils";

/**
 * 设置页「Token 用量」分区的纯计算层（组合方案 A+B 设计稿）：
 * KPI 环比、14 天堆叠趋势、90 天热力图分位、工具排行 Top N。
 * 全部为纯函数、无 IO，单测在 usageMath.test.ts。
 */

/** 单日合计（输入 + 输出）。 */
export function dayTotal(d: Pick<TokenUsageDay, "estInput" | "estOutput">): number {
  return d.estInput + d.estOutput;
}

/** 本地日期键（与后端 audit.rs 的本地日期口径一致）："YYYY-MM-DD"。 */
export function localDateKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 环比涨跌百分比。prev 为 0 / 负或 cur 为负时返回 null（无对比基准，UI 隐藏该行）。
 * 返回整数百分比（四舍五入），符号带正负。
 */
export function deltaPct(cur: number, prev: number): number | null {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0 || cur < 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** KPI 头的四个指标（设计稿方案 A）。 */
export interface UsageKpis {
  /** 今日估算 tokens。 */
  today: number;
  /** 今日 vs 昨日 环比百分比，无基准时 null。 */
  todayDelta: number | null;
  /** 近 7 天合计。 */
  week: number;
  /** 近 7 天 vs 前 7 天 环比百分比，无基准时 null。 */
  weekDelta: number | null;
  /** 近 7 天输入（估）。 */
  input7: number;
  /** 近 7 天输出（估）。 */
  output7: number;
  /** 输入占近 7 天合计的百分比（0-100，无数据时 0）。 */
  inputShare: number;
  /** 输出占比。 */
  outputShare: number;
}

/**
 * 从按日序列（旧→新，含今天）算 KPI。days 不足 2 天时环比为 null，不足 14 天时
 * 周环比退化为「有几天比几天」——数据从今天开始积累，前几天这是常态，UI 照实显示。
 */
export function computeKpis(days: TokenUsageDay[]): UsageKpis {
  const sum = (arr: TokenUsageDay[]) => arr.reduce((a, d) => a + dayTotal(d), 0);
  const last = days[days.length - 1];
  const prev = days[days.length - 2];
  const week = days.slice(-7);
  const prevWeek = days.slice(-14, -7);
  const input7 = week.reduce((a, d) => a + d.estInput, 0);
  const output7 = week.reduce((a, d) => a + d.estOutput, 0);
  const total7 = input7 + output7;
  return {
    today: last ? dayTotal(last) : 0,
    todayDelta: last && prev ? deltaPct(dayTotal(last), dayTotal(prev)) : null,
    week: sum(week),
    weekDelta: prevWeek.length > 0 ? deltaPct(sum(week), sum(prevWeek)) : null,
    input7,
    output7,
    inputShare: total7 > 0 ? Math.round((input7 / total7) * 100) : 0,
    outputShare: total7 > 0 ? Math.round((output7 / total7) * 100) : 0,
  };
}

/** 趋势图的一根柱。inPct/outPct 为相对列内最大日合计的高度百分比。 */
export interface TrendCol {
  date: string;
  /** 短标签（"10/5"），最后一天为「今天」。 */
  label: string;
  isToday: boolean;
  calls: number;
  inPct: number;
  outPct: number;
  /** hover 明细文案。 */
  tip: string;
}

/** 近 n 天堆叠柱数据（取 days 尾部，旧→新；输入浅色在下、输出深色在上）。 */
export function buildTrend(days: TokenUsageDay[], n = 14): TrendCol[] {
  const win = days.slice(-n);
  const max = Math.max(...win.map(dayTotal), 1);
  const todayKey = localDateKey();
  return win.map((d) => {
    const total = dayTotal(d);
    const isToday = d.date === todayKey;
    return {
      date: d.date,
      label: isToday ? "今天" : shortDateKey(d.date),
      isToday,
      calls: d.calls,
      inPct: max > 0 ? Math.max(total > 0 ? 3 : 0, (d.estInput / max) * 100) : 0,
      outPct: max > 0 ? Math.max(total > 0 ? 2 : 0, (d.estOutput / max) * 100) : 0,
      tip:
        total > 0
          ? `${isToday ? "今天" : shortDateKey(d.date)} · 输入~${fmtWan(d.estInput)} 输出~${fmtWan(d.estOutput)} · ${d.calls} 次调用`
          : `${isToday ? "今天" : shortDateKey(d.date)} · 无调用`,
    };
  });
}

/** 万级缩写（热力/趋势 tooltip 专用；KPI 大数字由 fmtTokens 负责）。 */
export function fmtWan(v: number): string {
  if (v >= 1_000_000) return `${Math.round(v / 10_000)}万`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(v >= 100_000 ? 0 : 1)}万`;
  return String(Math.round(v));
}

/** 热力图格子：level 0（无调用/灰）~ 4（最深）。 */
export interface HeatCell {
  date: string;
  /** 短标签 "10/5"。 */
  key: string;
  /** 估算 tokens 合计。 */
  total: number;
  level: 0 | 1 | 2 | 3 | 4;
  tip: string;
}

/**
 * 90 天热力图分位着色：对「有调用」的日子取 P25/P50/P75 三分位切 4 档。
 * 全为 0（新装用户）时全部落在 level 0。旧→新输入，返回同序。
 */
export function buildHeatmap(days: TokenUsageDay[]): HeatCell[] {
  const totals = days.map((d) => ({ ...d, total: dayTotal(d) }));
  const active = totals.filter((d) => d.total > 0).map((d) => d.total).sort((a, b) => a - b);
  const q = (p: number) =>
    active.length > 0 ? active[Math.max(0, Math.ceil(p * active.length) - 1)] : 0;
  const t1 = q(0.25);
  const t2 = q(0.5);
  const t3 = q(0.75);
  return totals.map((d) => {
    const level =
      d.total <= 0 ? 0 : d.total <= t1 ? 1 : d.total <= t2 ? 2 : d.total <= t3 ? 3 : 4;
    return {
      date: d.date,
      key: shortDateKey(d.date),
      total: d.total,
      level: level as HeatCell["level"],
      tip: d.total > 0 ? `${shortDateKey(d.date)} · ~${fmtWan(d.total)} · ${d.calls} 次调用` : `${shortDateKey(d.date)} · 无调用`,
    };
  });
}

/** 排行榜行。colorIdx 0-3 对应固定四色，-1 = 「其他」灰。 */
export interface RankRow {
  label: string;
  value: number;
  /** 相对最大值的 0-1 比例（bar scaleX 用）。 */
  ratio: number;
  colorIdx: number;
  calls: number;
}

/** 工具排行：Top N + 其余并入「其他」。tools 已是合计降序（后端保证），这里再兜底排一次。 */
export function rankTools(tools: TokenUsageTool[], topN = 4): RankRow[] {
  const total = (t: Pick<TokenUsageTool, "estInput" | "estOutput">) => t.estInput + t.estOutput;
  const sorted = [...tools].sort((a, b) => total(b) - total(a));
  const max = Math.max(...sorted.map(total), 1);
  const head = sorted.slice(0, topN).map((t, i) => ({
    label: t.tool,
    value: total(t),
    ratio: Math.max(0.02, total(t) / max),
    colorIdx: i,
    calls: t.calls,
  }));
  const rest = sorted.slice(topN);
  if (rest.length === 0) return head;
  const restAgg = rest.reduce(
    (a, t) => ({ estInput: a.estInput + t.estInput, estOutput: a.estOutput + t.estOutput, calls: a.calls + t.calls }),
    { estInput: 0, estOutput: 0, calls: 0 },
  );
  return [
    ...head,
    {
      label: "__other__",
      value: restAgg.estInput + restAgg.estOutput,
      ratio: Math.max(0.02, (restAgg.estInput + restAgg.estOutput) / max),
      colorIdx: -1,
      calls: restAgg.calls,
    },
  ];
}

/* ── 按天×工具矩阵 + CSV 导出（2026-10-17 四项增强·批D）── */

/** 矩阵视图数据：行 = 工具（按合计降序），列 = 日期（旧→新），格值 = 估算 tokens。 */
export interface UsageMatrix {
  tools: string[];
  dates: string[];
  /** key = `${tool}|${date}`。 */
  cell: Map<string, { calls: number; estTokens: number }>;
  /** 全表最大格值（热力底色归一化用）。 */
  max: number;
  /** 每个工具的合计（行尾汇总列），与 tools 同序。 */
  toolTotals: number[];
}

/**
 * 从报告搭矩阵。工具全集取自 byDayTool（比 tools 排行更全——排行只留 Top10），
 * 按各自合计降序；日期取 days 序列（与后端窗口一致，旧→新）。
 */
export function buildMatrix(report: TokenUsageReport): UsageMatrix {
  const cell = new Map<string, { calls: number; estTokens: number }>();
  const totals = new Map<string, number>();
  for (const c of report.byDayTool ?? []) {
    cell.set(`${c.tool}|${c.date}`, { calls: c.calls, estTokens: c.estTokens });
    totals.set(c.tool, (totals.get(c.tool) ?? 0) + c.estTokens);
  }
  const tools = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  let max = 1;
  for (const v of cell.values()) max = Math.max(max, v.estTokens);
  return {
    tools,
    dates: (report.days ?? []).map((d) => d.date),
    cell,
    max,
    toolTotals: tools.map((t) => totals.get(t) ?? 0),
  };
}

/** CSV 单元格转义：含逗号 / 引号 / 换行时包引号并把内部引号翻倍（RFC 4180）。 */
function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 三张表打包一个 CSV（UTF-8 **含 BOM**——Excel 直接双击打开中文才不乱码）。
 * 纯字符串拼装，下载触发在组件层。
 */
export function buildUsageCsv(report: TokenUsageReport, generatedAt: Date = new Date()): string {
  const L: string[] = [];
  L.push(`# cc-bridge Token 用量导出（估算值，按 约4字节≈1token 折算；生成于 ${generatedAt.toLocaleString("zh-CN")}）`);
  L.push("# ## 按天");
  L.push("date,calls,estInput,estOutput");
  for (const d of report.days ?? []) {
    L.push(`${d.date},${d.calls},${d.estInput},${d.estOutput}`);
  }
  L.push("# ## 按工具（合计降序）");
  L.push("tool,calls,estInput,estOutput");
  for (const t of report.tools ?? []) {
    L.push(`${csvField(t.tool)},${t.calls},${t.estInput},${t.estOutput}`);
  }
  L.push("# ## 按天×工具（仅非零格）");
  L.push("date,tool,calls,estTokens");
  for (const c of report.byDayTool ?? []) {
    L.push(`${c.date},${csvField(c.tool)},${c.calls},${c.estTokens}`);
  }
  return "\uFEFF" + L.join("\r\n") + "\r\n";
}
