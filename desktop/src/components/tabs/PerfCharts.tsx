import { useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Icon } from "../ui/icon";
import { toolLabel } from "../../lib/utils";
import type { AuditEntry } from "../../lib/types";

/**
 * 审计日志「性能分析」面板：纯前端、零依赖、手绘 SVG（不引入图表库，
 * 保持二进制体积）。数据来自 LogTab 已拉取的 AuditEntry[]，无需后端改动。
 *
 * 向前兼容：一旦 O1 在 AuditEntry 上写入 ioMs/serverMs/netMs/auditMs/overheadMs，
 * 面板会自动多渲染一张「单次调用耗时拆解」堆叠条，无需改此文件以外的逻辑。
 */

// 固定调色板：在浅色/深色主题下都清晰，不随主题反色。
const PALETTE = [
  "#6366f1", // indigo
  "#14b8a6", // teal
  "#f59e0b", // amber
  "#ef4444", // rose
  "#10b981", // emerald
  "#8b5cf6", // violet
  "#0ea5e9", // sky
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
];

interface ToolStat {
  tool: string;
  count: number;
  sumMs: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  share: number; // 0..1 of total time
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

// ── SVG 几何辅助 ──────────────────────────────────────────────────────
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function annular(
  cx: number,
  cy: number,
  rOut: number,
  rIn: number,
  start: number,
  end: number
): string {
  const [sxO, syO] = polar(cx, cy, rOut, end);
  const [exO, eyO] = polar(cx, cy, rOut, start);
  const [sxI, syI] = polar(cx, cy, rIn, start);
  const [exI, eyI] = polar(cx, cy, rIn, end);
  const large = end - start > 180 ? 1 : 0;
  return `M ${sxO.toFixed(2)} ${syO.toFixed(2)} A ${rOut} ${rOut} 0 ${large} 0 ${exO.toFixed(
    2
  )} ${eyO.toFixed(2)} L ${sxI.toFixed(2)} ${syI.toFixed(2)} A ${rIn} ${rIn} 0 ${large} 1 ${exI.toFixed(
    2
  )} ${eyI.toFixed(2)} Z`;
}

const HIST_BUCKETS: [string, number, number][] = [
  ["0–10", 0, 10],
  ["10–50", 10, 50],
  ["50–100", 50, 100],
  ["100–500", 100, 500],
  ["500–1k", 500, 1000],
  ["1k–5k", 1000, 5000],
  [">5k", 5000, Infinity],
];

export function PerfCharts({ entries }: { entries: AuditEntry[] }) {
  const stats = useMemo(() => {
    const valid = entries.filter(
      (e): e is AuditEntry & { durationMs: number } => typeof e.durationMs === "number"
    );
    if (valid.length === 0) return null;

    const durations = valid.map((e) => e.durationMs).sort((a, b) => a - b);
    const totalMs = durations.reduce((s, d) => s + d, 0);
    const overall = {
      count: valid.length,
      totalMs,
      p50: percentile(durations, 0.5),
      p90: percentile(durations, 0.9),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: durations[durations.length - 1],
      errorRate: (entries.filter((e) => !e.success).length / entries.length) * 100,
    };

    // 按工具分组
    const byTool = new Map<string, number[]>();
    for (const e of valid) {
      const arr = byTool.get(e.tool) ?? [];
      arr.push(e.durationMs);
      byTool.set(e.tool, arr);
    }
    const tools: ToolStat[] = [...byTool.entries()]
      .map(([tool, ds]) => {
        ds.sort((a, b) => a - b);
        const sum = ds.reduce((s, d) => s + d, 0);
        return {
          tool,
          count: ds.length,
          sumMs: sum,
          mean: sum / ds.length,
          p50: percentile(ds, 0.5),
          p90: percentile(ds, 0.9),
          p95: percentile(ds, 0.95),
          p99: percentile(ds, 0.99),
          max: ds[ds.length - 1],
          share: totalMs > 0 ? sum / totalMs : 0,
        };
      })
      .sort((a, b) => b.sumMs - a.sumMs);

    // 直方图
    const hist = HIST_BUCKETS.map(([label, lo, hi]) => ({
      label,
      count: valid.filter((e) => e.durationMs >= lo && e.durationMs < hi).length,
    }));

    // 最慢 N 次
    const topN = [...valid].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);

    // 向前兼容：若已写入结构化耗时字段
    const hasSplit = valid.some(
      (e) => (e as AuditEntry & Record<string, unknown>).serverMs != null
    );
    let split: { label: string; ms: number; color: string }[] | null = null;
    if (hasSplit) {
      const f = (k: string) =>
        valid.reduce(
          (s, e) => s + (((e as AuditEntry & Record<string, unknown>)[k] as number) ?? 0),
          0
        ) / valid.length;
      split = [
        { label: "调度逻辑", ms: f("durationMs"), color: "#6366f1" },
        { label: "文件读写 I/O", ms: f("ioMs"), color: "#14b8a6" },
        { label: "审计写盘", ms: f("auditMs"), color: "#f59e0b" },
        { label: "网络往返", ms: f("netMs"), color: "#ef4444" },
        { label: "传输/序列化", ms: f("overheadMs"), color: "#8b5cf6" },
      ].filter((x) => x.ms > 0);
    }

    // 自动结论
    const dom = tools[0];
    let verdict: string;
    if (overall.p95 < 20) verdict = "网络 RTT 主导（架构层）—— 应减少往返，而非优化服务端";
    else if (overall.p95 < 100) verdict = "网络 RTT 与服务端处理混合 —— 双管齐下";
    else verdict = "服务端处理偏慢 —— 优先优化高占比工具（见下）";
    const conclusion = [
      `总体：调用 ${overall.count} 次，合计 ${fmt(overall.totalMs)}，P50 ${overall.p50.toFixed(
        0
      )}ms / P95 ${overall.p95.toFixed(0)}ms / P99 ${overall.p99.toFixed(0)}ms，错误率 ${overall.errorRate.toFixed(
        1
      )}%。`,
      dom
        ? `耗时主因：「${toolLabel(dom.tool)}」(${dom.tool}) 占 ${(dom.share * 100).toFixed(
            1
          )}%（${fmt(dom.sumMs)}），平均 ${dom.mean.toFixed(0)}ms、P95 ${dom.p95.toFixed(0)}ms。\n    建议：参照功能优化清单对应条目优先处理该工具。`
        : "",
      `瓶颈判定：${verdict}。`,
    ]
      .filter(Boolean)
      .join("\n");

    return { overall, tools, hist, topN, split, conclusion };
  }, [entries]);

  if (!stats) {
    return (
      <Card className="bg-muted/30">
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          <Icon name="activity" size={20} className="mx-auto mb-2 opacity-40" />
          暂无带「耗时」的审计记录，连接远程 Claude Code 并操作后将自动生成性能分析。
        </CardContent>
      </Card>
    );
  }

  const { overall, tools, hist, topN, split, conclusion } = stats;
  const maxP95 = Math.max(1, ...tools.map((t) => t.p95));
  const maxHist = Math.max(1, ...hist.map((h) => h.count));
  const maxTop = Math.max(1, ...topN.map((e) => e.durationMs));
  const groupW = Math.max(240, tools.length * 56);

  return (
    <Card className="bg-muted/20">
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <CardTitle icon={<Icon name="activity" />}>性能分析</CardTitle>
        <span className="text-xs text-muted-foreground">
          基于全部 {overall.count} 条带耗时记录 · 自动诊断
        </span>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 概要统计条 */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="调用总数" value={String(overall.count)} />
          <StatTile label="总耗时" value={fmt(overall.totalMs)} />
          <StatTile label="P50" value={`${overall.p50.toFixed(0)}ms`} />
          <StatTile label="P95" value={`${overall.p95.toFixed(0)}ms`} />
          <StatTile label="错误率" value={`${overall.errorRate.toFixed(1)}%`} />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* 耗时占比环形图 */}
          <Panel title="各工具耗时占比（按总耗时）">
            <div className="flex items-center gap-4">
              <svg viewBox="0 0 120 120" className="h-36 w-36 shrink-0">
                {tools.length === 1 ? (
                  <circle cx="60" cy="60" r="42" fill={PALETTE[0]} />
                ) : (
                  tools.map((t, i) => {
                    const start = tools
                      .slice(0, i)
                      .reduce((s, x) => s + x.share * 360, 0);
                    const end = start + t.share * 360;
                    if (t.share <= 0) return null;
                    return (
                      <path
                        key={t.tool}
                        d={annular(60, 60, 52, 30, start, Math.min(end, start + 359.99))}
                        fill={PALETTE[i % PALETTE.length]}
                      />
                    );
                  })
                )}
              </svg>
              <div className="space-y-1 text-xs">
                {tools.slice(0, 8).map((t, i) => (
                  <div key={t.tool} className="flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ background: PALETTE[i % PALETTE.length] }}
                    />
                    <span className="w-24 truncate text-muted-foreground">
                      {toolLabel(t.tool)}
                    </span>
                    <span className="font-mono">{(t.share * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </Panel>

          {/* 各工具 P50/P95 对比 */}
          <Panel title="各工具 P50 / P95 对比（ms）">
            <svg viewBox={`0 0 ${groupW} 170`} className="w-full" preserveAspectRatio="xMidYMid meet">
              {tools.map((t, i) => {
                const x = i * 56 + 14;
                const w = 16;
                const h50 = (t.p50 / maxP95) * 130;
                const h95 = (t.p95 / maxP95) * 130;
                const y = 150;
                return (
                  <g key={t.tool}>
                    <rect x={x} y={y - h50} width={w} height={h50} fill={PALETTE[i % PALETTE.length]} rx={2} />
                    <rect x={x + w + 4} y={y - h95} width={w} height={h95} fill="#94a3b8" rx={2} />
                    <text x={x + w + 2} y={y + 12} fontSize="9" textAnchor="middle" className="fill-muted-foreground">
                      {toolLabel(t.tool).slice(0, 6)}
                    </text>
                  </g>
                );
              })}
              {/* 图例 */}
              <rect x={groupW - 150} y={6} width={10} height={10} fill={PALETTE[0]} rx={2} />
              <text x={groupW - 136} y={15} fontSize="9" className="fill-muted-foreground">P50</text>
              <rect x={groupW - 90} y={6} width={10} height={10} fill="#94a3b8" rx={2} />
              <text x={groupW - 76} y={15} fontSize="9" className="fill-muted-foreground">P95</text>
              <text x={0} y={166} fontSize="8" className="fill-muted-foreground">
                纵轴峰值 {maxP95.toFixed(0)}ms
              </text>
            </svg>
          </Panel>

          {/* 延迟分布直方图 */}
          <Panel title="整体延迟分布（调用次数）">
            <svg viewBox="0 0 320 170" className="w-full" preserveAspectRatio="xMidYMid meet">
              {hist.map((h, i) => {
                const bw = 320 / hist.length;
                const hgt = (h.count / maxHist) * 130;
                const x = i * bw + 4;
                return (
                  <g key={h.label}>
                    <rect
                      x={x}
                      y={150 - hgt}
                      width={bw - 8}
                      height={hgt}
                      fill={PALETTE[i % PALETTE.length]}
                      rx={2}
                    />
                    <text x={x + (bw - 8) / 2} y={162} fontSize="9" textAnchor="middle" className="fill-muted-foreground">
                      {h.label}
                    </text>
                    {h.count > 0 && (
                      <text x={x + (bw - 8) / 2} y={150 - hgt - 3} fontSize="9" textAnchor="middle" className="fill-foreground">
                        {h.count}
                      </text>
                    )}
                  </g>
                );
              })}
              <line x1="0" y1="150" x2="320" y2="150" className="stroke-muted-foreground/30" strokeWidth="1" />
            </svg>
          </Panel>

          {/* 耗时拆解（O1 后自动出现） */}
          {split && split.length > 0 && (
            <Panel title="单次调用耗时拆解（O1 结构化日志）">
              <div className="space-y-2">
                {split.map((s) => {
                  const max = Math.max(...split.map((x) => x.ms));
                  return (
                    <div key={s.label} className="flex items-center gap-2 text-xs">
                      <span className="w-24 shrink-0 text-muted-foreground">{s.label}</span>
                      <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                        <div
                          className="h-full rounded"
                          style={{ width: `${(s.ms / max) * 100}%`, background: s.color }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right font-mono">{s.ms.toFixed(1)}ms</span>
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}
        </div>

        {/* 最慢 N 次 */}
        <Panel title="最慢的 10 次调用">
          <div className="space-y-1.5">
            {topN.map((e, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-5 shrink-0 text-right font-mono text-muted-foreground">{i + 1}</span>
                <span className="w-24 shrink-0 truncate text-muted-foreground">{toolLabel(e.tool)}</span>
                <div className="h-3.5 flex-1 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full rounded bg-rose-500/80"
                    style={{ width: `${(e.durationMs / maxTop) * 100}%` }}
                  />
                </div>
                <span className="w-20 shrink-0 text-right font-mono">{e.durationMs}ms</span>
              </div>
            ))}
          </div>
        </Panel>

        {/* 自动结论 */}
        <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-primary">
            <Icon name="alertTriangle" size={13} />
            自动诊断结论
          </div>
          <pre className="whitespace-pre-wrap font-sans text-muted-foreground">{conclusion}</pre>
        </div>
      </CardContent>
    </Card>
  );
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background/60 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-semibold">{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background/60 p-3">
      <div className="mb-2 text-xs font-medium text-foreground">{title}</div>
      {children}
    </div>
  );
}
