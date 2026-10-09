import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../../lib/tauri";
import type { TokenUsageReport } from "../../../lib/types";
import {
  buildHeatmap,
  buildTrend,
  computeKpis,
  rankTools,
  type RankRow,
} from "../../../lib/usageMath";
import { fmtTokens, toolLabel } from "../../../lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";

/**
 * 设置页「Token 用量（估算）」分区（卡级 id: set-tokenusage，首页用量卡点进来）。
 *
 * 组合方案 A+B（设计稿 design/设置-Token用量-组合AB-设计稿.html）：
 * ① KPI 头（今日/近7天 + 环比 + sparkline）② 近 14 天堆叠趋势
 * ③ 90 天热力图 + 工具排行双栏 ④ 卡底一行口径说明。
 *
 * 两个查询都走后端同一份 AUDIT_CACHE（稳态零解析）：
 * - ["token-usage"]   days=90：喂 KPI / 趋势 / 热力图（与首页用量卡共享缓存），30s 轮询
 * - ["token-usage-7"] days=7 ：喂工具排行（设计稿口径是近 7 天，tools 按请求窗口聚合）
 * 环比/分位/占比是纯函数，收口在 lib/usageMath.ts（带单测），本文件只负责取数与布局。
 */
export function TokenUsageGroup() {
  const { data, isLoading } = useQuery<TokenUsageReport>({
    queryKey: ["token-usage"],
    queryFn: () => invoke<TokenUsageReport>("get_token_usage", { days: 90 }),
    refetchInterval: 30_000,
  });
  const { data: data7 } = useQuery<TokenUsageReport>({
    queryKey: ["token-usage-7"],
    queryFn: () => invoke<TokenUsageReport>("get_token_usage", { days: 7 }),
    refetchInterval: 30_000,
  });

  const days = data?.days ?? [];
  const hasData = days.some((d) => d.calls > 0);

  return (
    <Card id="set-tokenusage">
      <CardHeader>
        <CardTitle icon={<Icon name="activity" />}>Token 用量（估算）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-[12px] text-muted-foreground">加载中…</p>
        ) : !hasData ? (
          <>
            <EmptyKpis />
            <p className="text-[12px] text-muted-foreground">
              暂无调用记录。远程 Claude Code 接入并调用工具后，这里会出现趋势、节奏与工具排行。
            </p>
          </>
        ) : (
          <>
            <KpiHead days={days} />
            <TrendSection days={days} />
            <div className="usage-duo">
              <HeatSection days={days} />
              <RankSection tools={data7?.tools ?? []} />
            </div>
          </>
        )}
        <p className="rounded-lg bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          按「约 4 字节 ≈ 1 token」折算的<strong className="text-foreground">估算值</strong>，
          反映经桥交互的上下文增量；模型侧的真实消耗（系统提示词、对话历史等）不经过桥，
          无法统计，因此它不是账单值。
        </p>
      </CardContent>
    </Card>
  );
}

/* ── ① KPI 头 ── */

function KpiHead({ days }: { days: TokenUsageReport["days"] }) {
  const k = computeKpis(days);
  const spark = days.slice(-7).map((d) => d.estInput + d.estOutput);
  const sparkMax = Math.max(...spark, 1);
  return (
    <div className="usage-kpis">
      <div className="usage-kpi">
        <div className="usage-kpi-lb">今日估算</div>
        <div className="usage-kpi-v">{fmtTokens(k.today)}</div>
        <Delta pct={k.todayDelta} vs="vs 昨日" />
        <Spark values={spark} max={sparkMax} />
      </div>
      <div className="usage-kpi">
        <div className="usage-kpi-lb">近 7 天合计</div>
        <div className="usage-kpi-v">{fmtTokens(k.week)}</div>
        <Delta pct={k.weekDelta} vs="vs 上周" />
        <Spark values={spark} max={sparkMax} />
      </div>
      <div className="usage-kpi">
        <div className="usage-kpi-lb">输入(估) · 7天</div>
        <div className="usage-kpi-v">{fmtTokens(k.input7)}</div>
        <p className="usage-kpi-delta usage-kpi-delta--flat">占 {k.inputShare}%</p>
      </div>
      <div className="usage-kpi">
        <div className="usage-kpi-lb">输出(估) · 7天</div>
        <div className="usage-kpi-v">{fmtTokens(k.output7)}</div>
        <p className="usage-kpi-delta usage-kpi-delta--flat">占 {k.outputShare}%</p>
      </div>
    </div>
  );
}

/** 环比行：无对比基准时显示占位空白，保持四卡视觉对齐。 */
function Delta({ pct, vs }: { pct: number | null; vs: string }) {
  if (pct === null) {
    return <p className="usage-kpi-delta usage-kpi-delta--flat">&nbsp;</p>;
  }
  const up = pct >= 0;
  return (
    <p className={`usage-kpi-delta ${up ? "usage-kpi-delta--up" : "usage-kpi-delta--down"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct)}% {vs}
    </p>
  );
}

function Spark({ values, max }: { values: number[]; max: number }) {
  return (
    <div className="usage-spark">
      {values.map((v, i) => (
        <i key={i} style={{ height: `${Math.max(v > 0 ? 12 : 3, (v / max) * 100)}%` }} />
      ))}
    </div>
  );
}

function EmptyKpis() {
  return (
    <div className="usage-kpis">
      {["今日估算", "近 7 天合计", "输入(估) · 7天", "输出(估) · 7天"].map((lb) => (
        <div className="usage-kpi" key={lb}>
          <div className="usage-kpi-lb">{lb}</div>
          <div className="usage-kpi-v">0</div>
        </div>
      ))}
    </div>
  );
}

/* ── ② 近 14 天堆叠趋势 ── */

function TrendSection({ days }: { days: TokenUsageReport["days"] }) {
  const cols = buildTrend(days, 14);
  return (
    <div>
      <div className="mb-2 text-[12px] font-semibold">
        近 14 天趋势<span className="ml-1.5 text-[10px] font-medium text-muted-foreground">输入 + 输出（估）</span>
      </div>
      <div className="usage-trend">
        {cols.map((c, i) => (
          <div
            key={c.date}
            className={`usage-trend-col${c.isToday ? " usage-trend-col--today" : ""}`}
            style={{ animationDelay: `${i * 35}ms` }}
            title={c.tip}
          >
            <div className="usage-trend-in" style={{ height: `${c.inPct}%` }} />
            <div className="usage-trend-out" style={{ height: `${c.outPct}%` }} />
          </div>
        ))}
      </div>
      <div className="usage-xdays">
        {cols.map((c) => (
          <span key={c.date} className={c.isToday ? "usage-xdays--today" : undefined}>
            {c.label}
          </span>
        ))}
      </div>
      <div className="usage-legend">
        <span>
          <i style={{ display: "inline-block", height: 9, width: 9, borderRadius: 3, background: "hsl(var(--primary) / 0.28)" }} />
          输入(估)
        </span>
        <span>
          <i style={{ display: "inline-block", height: 9, width: 9, borderRadius: 3, background: "hsl(var(--primary))" }} />
          输出(估)
        </span>
      </div>
    </div>
  );
}

/* ── ③ 90 天热力图 ── */

function HeatSection({ days }: { days: TokenUsageReport["days"] }) {
  const cells = buildHeatmap(days);
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[12px] font-semibold">
        近 90 天节奏<span className="ml-1.5 text-[10px] font-medium text-muted-foreground">深度 = 当日用量分位</span>
      </div>
      <div className="usage-heat">
        {cells.map((c) => (
          <i key={c.date} className={c.level > 0 ? `l${c.level}` : undefined} title={c.tip} />
        ))}
      </div>
      <div className="usage-heat-scale">
        少 <i /> <i className="l1" /> <i className="l2" /> <i className="l3" /> <i className="l4" /> 多
      </div>
    </div>
  );
}

/* ── ④ 工具排行（近 7 天，独立 7 天查询）── */

function RankSection({ tools }: { tools: TokenUsageReport["tools"] }) {
  const rows = rankTools(tools, 4);
  if (rows.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[12px] font-semibold">
        按工具排行<span className="ml-1.5 text-[10px] font-medium text-muted-foreground">近 7 天</span>
      </div>
      {rows.map((r) => (
        <RankRowView key={r.label} row={r} />
      ))}
      <p className="mt-1 text-[9.5px] text-muted-foreground">仅显示 Top 4，其余并入「其他」</p>
    </div>
  );
}

function RankRowView({ row }: { row: RankRow }) {
  const isOther = row.colorIdx < 0;
  const title = isOther ? "其他工具" : toolLabel(row.label);
  const cls = isOther ? "usage-c-other" : `usage-c${row.colorIdx}`;
  return (
    <div className="usage-rank-row">
      <span className={`usage-rank-dot ${cls}`} />
      <span className="usage-rank-name" title={title}>
        {title}
      </span>
      <span className="tool-bar">
        <i className={cls} style={{ transform: `scaleX(${row.ratio})` }} />
      </span>
      <span className="usage-rank-val">~{fmtTokens(row.value)}</span>
    </div>
  );
}
