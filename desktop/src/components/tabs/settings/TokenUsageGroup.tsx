import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../../lib/tauri";
import type { TokenUsageReport, TokenUsageSession } from "../../../lib/types";
import {
  buildHeatmap,
  buildTrend,
  rankTools,
  type RankRow,
} from "../../../lib/usageMath";
import { fmtTokens, toolLabel } from "../../../lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Skeleton } from "../../ui/Skeleton";
import { InfoPopover } from "../../ui/InfoPopover";
import { useAppHidden } from "../../../lib/appVisibility";
import { useViewActive } from "../../../lib/viewActivity";
import { SettingsChoice } from "../../ui/SettingsChoice";
import { UsageMatrixSection } from "./UsageMatrixSection";
import { KpiHead, EmptyKpis } from "./UsageKpiHead";
import { ConversationUsageSection } from "./ConversationUsageSection";

/** `data` 未就绪时的占位。模块级常量：内联 `?? []` 每次渲染都是新引用，
 *  会让子组件的 useMemo（按 sessionId join）每次渲染都失效重算。 */
const NO_SESSIONS: TokenUsageSession[] = [];

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
  const appHidden = useAppHidden();
  const active = useViewActive();
  const hidden = appHidden || !active;
  // 维度切换（批D）：概览（趋势+热力+排行）/ 按天×工具矩阵。KPI 头两态共用。
  const [view, setView] = useState<"overview" | "matrix">("overview");
  // 矩阵视图独立时间范围（默认 30 天）。概览保持 90 天长窗（热力图设计意图）；
  // 矩阵是明细表——铺 90 列首屏全是保留期外的零列（默认保留 30 天），没有信息量。
  // 30 对齐 audit_retention_days 默认值：窗口内基本都有真实数据。
  const [matrixDays, setMatrixDays] = useState<7 | 30 | 90>(30);
  const { data, isLoading } = useQuery<TokenUsageReport>({
    queryKey: ["token-usage", 90],
    queryFn: () => invoke<TokenUsageReport>("get_token_usage", { days: 90 }),
    enabled: !hidden,
    refetchInterval: hidden ? false : 30_000,
  });
  const { data: data7 } = useQuery<TokenUsageReport>({
    queryKey: ["token-usage", 7],
    queryFn: () => invoke<TokenUsageReport>("get_token_usage", { days: 7 }),
    enabled: !hidden,
    refetchInterval: hidden ? false : 30_000,
  });
  // 矩阵按所选范围取数：只在矩阵视图激活时拉（切档即换 key 重查）。
  // 与主查询同族 key——matrixDays=90 时自动与主查询去重共用，零额外成本。
  const { data: matrixReport, isLoading: matrixLoading } = useQuery<TokenUsageReport>({
    queryKey: ["token-usage", matrixDays],
    queryFn: () => invoke<TokenUsageReport>("get_token_usage", { days: matrixDays }),
    enabled: view === "matrix" && !hidden,
    refetchInterval: view === "matrix" && !hidden ? 30_000 : false,
  });

  const days = data?.days ?? [];
  const hasData = days.some((d) => d.calls > 0);

  return (
    <Card id="set-tokenusage">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle icon={<Icon name="activity" />}>Token 用量（估算）</CardTitle>
        {/* 维度切换：分段控件（两个 state 的小视图，不值得上 Tabs）。 */}
        <SettingsChoice label="用量统计维度" value={view} onChange={value => setView(value as "overview" | "matrix")} options={[{value:"overview",label:"概览"},{value:"matrix",label:"按天×工具"}]} />
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          /* Skeleton（2026-10-17）：替代「加载中…」纯文本——骨架形状预示即将出现的
             KPI 卡布局，加载完成内容原地接上，不再「空白→内容跳出」。 */
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-3 w-24" />
            <div className="usage-kpis">
              {[0, 1, 2, 3].map((i) => (
                <div className="usage-kpi" key={i}>
                  <Skeleton className="h-2.5 w-16" />
                  <Skeleton className="mt-2 h-5 w-20" />
                </div>
              ))}
            </div>
          </div>
        ) : !hasData ? (
          <>
            <EmptyKpis />
            <p className="text-xs text-muted-foreground">
              暂无调用记录。远程 AI 工具接入并调用工具后，这里会出现趋势、节奏与工具排行。
            </p>
          </>
        ) : view === "matrix" ? (
          matrixLoading || !matrixReport ? (
            /* 矩阵按需取数有自己的加载窗口（切档/首次进入），骨架形状预示 KPI + 表。 */
            <div className="space-y-2" aria-hidden="true">
              <div className="usage-kpis">
                {[0, 1, 2, 3].map((i) => (
                  <div className="usage-kpi" key={i}>
                    <Skeleton className="h-2.5 w-16" />
                    <Skeleton className="mt-2 h-5 w-20" />
                  </div>
                ))}
              </div>
              <Skeleton className="h-28 w-full" />
            </div>
          ) : (
            <>
              {/* KPI 跟随矩阵口径：表是「最近 30 天」而 KPI 是 90 天会互相打架。 */}
              <KpiHead days={matrixReport.days} />
              <UsageMatrixSection
                report={matrixReport}
                rangeDays={matrixDays}
                onRangeChange={setMatrixDays}
              />
            </>
          )
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
        {/* 对话账（批 2-6）：独立数据源，刻意放在视图切换之外——工具账全空
            （没人调过工具）时这里仍有东西可看，且两个视图下都该看得到。 */}
        <ConversationUsageSection toolSessions={data?.sessions ?? NO_SESSIONS} />
        <div className="flex items-start justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2">
          <span className="text-xs leading-relaxed text-muted-foreground">
            按「约 4 字节 ≈ 1 token」折算的<strong className="text-foreground">估算值</strong>，不是账单
          </span>
          <InfoPopover label="Token 用量口径">
            按「约 4 字节 ≈ 1 token」折算的估算值，反映经桥交互的上下文增量；模型侧的真实消耗（系统提示词、对话历史等）不经过桥，无法统计，因此它不是账单值。
          </InfoPopover>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── ② 近 14 天堆叠趋势 ── */

function TrendSection({ days }: { days: TokenUsageReport["days"] }) {
  const cols = buildTrend(days, 14);
  return (
    <div>
      <div className="mb-2 text-xs font-semibold">
        近 14 天趋势<span className="ml-1.5 text-[11px] font-medium text-muted-foreground">输入 + 输出（估）</span>
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
      <div className="mb-2 text-xs font-semibold">
        近 90 天节奏<span className="ml-1.5 text-[11px] font-medium text-muted-foreground">深度 = 当日用量分位</span>
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
      <div className="mb-2 text-xs font-semibold">
        按工具排行<span className="ml-1.5 text-[11px] font-medium text-muted-foreground">近 7 天</span>
      </div>
      {rows.map((r) => (
        <RankRowView key={r.label} row={r} />
      ))}
      <p className="mt-1 text-[11px] text-muted-foreground">仅显示 Top 4，其余并入「其他」</p>
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
