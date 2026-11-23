import { MetricValue } from "../tabs/MetricValue";
import { Sparkline, type ChartKind } from "../tabs/MetricSparkline";
import type { RelaySnapshot } from "../../lib/types";
import type { RelaySeries } from "../../hooks/useRelayStatus";
import { foldRate, formatInt, formatPercent } from "../../lib/relayFormat";

/**
 * ② 四张指标卡（各 2 列，`5/7` … `11/13`）。
 *
 * **为什么是这四个**：全部由日志字段算得出来（时间 / 来源 / 档位 / 改写 / 状态 / 首字），
 * 没有一个是为了撑版面编的——今日请求答「有没有人用」，首字 P50 答「快不快」，
 * 改写率答「有多少请求被我们动过」，错误率答「上游稳不稳」。
 * token 用量要额外解析上游 `usage` 字段，留给 P1 之后。
 *
 * 未运行时实时值一律给 EM DASH 而不是 0：显示 0 会让人以为「在跑但没流量」，
 * 与「根本没在监听」是两件事。
 *
 * 图形跟着连接页走（`MetricSparkline` + `lib/sparkline` 的几何），只有数据源不同：
 * 这里的序列是 `useRelayStatus` 按 2 秒节拍采的**增量**，不是后端给的标量。
 */
export function RelayMetrics({ snapshot, series }: { snapshot?: RelaySnapshot; series: RelaySeries }) {
  const running = snapshot?.running ?? false;
  const stats = snapshot?.stats;
  const total = stats?.todayRequests ?? 0;
  const dash = (text: string) => (running ? text : "—");
  const p50 = stats?.firstByteP50Ms ?? null;
  const p95 = stats?.firstByteP95Ms ?? null;
  const errorRate = stats?.todayErrorRate ?? 0;

  return (
    <>
      <RelayMetric
        label="今日请求"
        value={dash(formatInt(total))}
        unit=" 次"
        sub={running ? `其中折叠 ${formatInt(stats?.todayFolded ?? 0)} 次` : "关闭期间不计数"}
        series={series.requests}
        kind="area"
        color="text-primary"
        motionReady={running && total > 0}
      />
      <RelayMetric
        label="首字 P50"
        value={dash(p50 == null ? "—" : splitMs(p50).value)}
        unit={running && p50 != null ? splitMs(p50).unit : undefined}
        sub={running ? (p95 == null ? "还没有采样到首字" : `P95 ${splitMs(p95).value}${splitMs(p95).unit ?? ""}`) : "打开后开始采样"}
        series={series.firstByte}
        kind="bars"
        // ≥1 秒就是「尾部慢」的坏消息 → 橙；正常 → 绿。静态绿会把 8 秒也画成好消息。
        color={p50 != null && p50 >= 1000 ? "text-warning-ink" : "text-success-ink"}
        motionReady={running && total > 0}
      />
      <RelayMetric
        label="改写率"
        value={dash(running && total > 0 ? formatPercent(foldRate(stats ?? EMPTY_STATS), 1) : "—")}
        unit={running && total > 0 ? "%" : undefined}
        sub={running ? `${formatInt(stats?.todayFolded ?? 0)} / ${formatInt(total)} 条被改过` : "关闭期间不计数"}
        series={series.fold}
        kind="heat"
        color="text-primary"
        motionReady={running && total > 0}
      />
      <RelayMetric
        label="错误率"
        value={dash(running && total > 0 ? formatPercent(errorRate) : "—")}
        unit={running && total > 0 ? "%" : undefined}
        sub={
          running
            ? (stats?.lastError ?? `今日 ${formatInt(stats?.todayErrors ?? 0)} 次`)
            : "关闭期间不计数"
        }
        series={series.errors}
        kind="step"
        color={errorRate > 0 ? "text-warning-ink" : "text-success-ink"}
        motionReady={running && total > 0}
      />
    </>
  );
}

/** 与连接页同一条口径：≥1 秒换算成秒。 */
function splitMs(ms: number): { value: string; unit: string } {
  return ms >= 1000
    ? { value: (ms / 1000).toFixed(2), unit: " 秒" }
    : { value: String(Math.round(ms)), unit: " 毫秒" };
}

const EMPTY_STATS = {
  todayRequests: 0,
  todayFolded: 0,
  todayErrors: 0,
  todayErrorRate: 0,
  firstByteP50Ms: null,
  firstByteP95Ms: null,
  avgTotalMs: null,
  tierHits: [],
  lastError: null,
  lastErrorAtMs: null,
  inFlight: 0,
};

function RelayMetric({
  label,
  value,
  unit,
  sub,
  series,
  kind,
  color,
  motionReady,
}: {
  label: string;
  value: string;
  unit?: string;
  sub: string;
  series: number[];
  kind: ChartKind;
  color: string;
  motionReady: boolean;
}) {
  return (
    <div className={`metric-card ${color}`}>
      <div className="text-xs font-bold text-muted-foreground">{label}</div>
      <MetricValue value={value} unit={unit} enabled={motionReady} />
      <div className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground" title={sub}>
        {sub}
      </div>
      <Sparkline series={series} kind={kind} noData={series.length === 0} />
    </div>
  );
}
