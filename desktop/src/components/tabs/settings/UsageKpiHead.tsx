import type { TokenUsageReport } from "../../../lib/types";
import { computeKpis } from "../../../lib/usageMath";
import { fmtTokens } from "../../../lib/utils";

/**
 * 用量卡 KPI 头（TokenUsageGroup 拆出，2026-10-17 体量门禁）。
 *
 * 两态：有数据（KpiHead，四个指标卡 + 环比 + 迷你趋势）/ 无数据（EmptyKpis，
 * 零值占位撑住布局）。消费方：概览与矩阵两个维度共用同一 KPI 口径逻辑。
 */
export function KpiHead({ days }: { days: TokenUsageReport["days"] }) {
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

/** 环比行：无对比基准时显示「—」（全应用空值统一记号，宽度≈一个数字位）。 */
function Delta({ pct, vs }: { pct: number | null; vs: string }) {
  if (pct === null) {
    return <p className="usage-kpi-delta usage-kpi-delta--flat">—</p>;
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

/** 无数据占位：与 KpiHead 同构的四个零值卡，撑住布局不塌。 */
export function EmptyKpis() {
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
