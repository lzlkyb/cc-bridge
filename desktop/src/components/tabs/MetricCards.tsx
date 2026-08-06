import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { StatusResponse, StaticStatus, LiveStatus } from "../../lib/types";
import { useMetricSeries, type MetricKey } from "../../lib/metricHistory";
import { usePopClass } from "../../hooks/useChangeClass";
import { Sparkline, type ChartKind } from "./MetricSparkline";
import { NavTarget } from "../ui/NavTarget";

/**
 * Bento 右侧的四张指标卡（各 2/12 列）。
 *
 * **四个指标为何是这四个**：旧设计里的“累计调用”画成曲线是单调上升直线（零信息量），
 * 换成了**增量**；“失败次数”与健康环卡的成功率互为补集（重复），换成了“活跃命令”。
 *
 * **四张卡的图形形态不同，而且是由数据性质决定的**（不是为了好看而换）：
 * | 指标 | 形态 | 理由 |
 * | 请求速率 | 面积折线 + 限流阈值虚线 | 唯一有真实阈值的指标 |
 * | P95 延迟 | 柱状 | 5s 一个离散采样，连线会暗示中间有连续变化 |
 * | 调用增量 | 热力条 | 要回答的是“什么时候忙”，不是“具体多少” |
 * | 活跃命令 | 阶梯线 | 小整数瞬时跳变，折线把阶梯画成斜坡**是错的** |
 * 坐标计算全在 `lib/sparkline.ts`（已单测）。
 *
 * **每张卡自己订阅序列**（`useMetricSeries`）而不是从父层接数据：序列每 5s 变，
 * 从父层传会把整个 Bento 子树拖着重渲。采样则由 `<MetricSampler />` 单点写入。
 */
export function MetricCards({
  status,
  onNavigate,
}: {
  status?: StaticStatus;
  /** 各卡点击后跳到对应设置项 / 页面；不传则整卡不可点。 */
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  // live 字段在本组件订阅（共享 App 层的 ["status"] 缓存与轮询，不多发请求）。
  const { data: live } = useQuery<StatusResponse, Error, LiveStatus>({
    queryKey: ["status"],
    queryFn: () => invoke<StatusResponse>("get_status"),
    select: (s) => ({ uptimeSeconds: s.uptimeSeconds, stats: s.stats }),
  });

  const s = live?.stats;
  const running = status?.running ?? false;
  const fmt = (n: number) => n.toLocaleString("en-US");

  // 未运行时实时类指标置 "--"：显示 0 会让人以为“在跑但没流量”。
  const dash = (v: string) => (running ? v : "--");
  const p95 = s?.p95LatencyMs ?? 0;
  const avg = s?.avgLatencyMs ?? 0;
  // 尾部倍数：P95 ÷ 平均。比孤零零的 142ms 有信息量——它告诉你尾延迟拉得多长。
  const tailRatio = avg > 0 ? p95 / avg : 0;

  // “调用增量”的主数字就是序列末项（后端没这个标量，只能从采样里取）。
  // 必须在组件顶层调 hook，不能写在 JSX 属性里——那样一旦那张卡被包进条件分支，
  // hook 调用顺序就乱了。
  const deltaNow = lastOf(useMetricSeries("delta"));

  return (
    <>
      <MetricCard
        label="请求速率"
        value={dash(String(s?.requestsPerMin ?? 0))}
        unit=" 次/分"
        sub={status ? `限流 ${fmt(status.rateLimit.maxRequests)} 次/${Math.round(status.rateLimit.windowMs / 1000)}秒` : "—"}
        seriesKey="rpm"
        color="text-primary"
        chart="area"
        threshold={status?.rateLimit.maxRequests}
        onNavigate={onNavigate}
        nav={{ tab: "settings", anchor: "ratelimit", title: "去设置调整限流阈值" }}
      />
      <MetricCard
        label="P95 延迟"
        value={dash(String(p95))}
        unit=" 毫秒"
        sub={avg > 0 ? `平均 ${avg}毫秒 · 尾部慢 ${tailRatio.toFixed(1)} 倍` : "暂无数据"}
        seriesKey="p95"
        color="text-success"
        chart="bars"
        onNavigate={onNavigate}
        nav={{ tab: "log", anchor: "perf", title: "去日志页看性能分析" }}
      />
      <MetricCard
        label="调用增量"
        value={dash(`+${deltaNow}`)}
        unit=" 次/5秒"
        sub={s ? `累计 ${fmt(s.totalRequests)} · 失败 ${fmt(s.totalErrors)}` : "—"}
        seriesKey="delta"
        color="text-primary"
        chart="heat"
        onNavigate={onNavigate}
        nav={{ tab: "log", title: "去日志页看调用明细" }}
      />
      <MetricCard
        label="活跃命令"
        value={running ? String(s?.activeCommands ?? 0) : "0"}
        sub={(s?.activeCommands ?? 0) > 0 ? "后台运行中" : "当前无后台命令"}
        seriesKey="active"
        color="text-warning"
        chart="step"
        onNavigate={onNavigate}
        nav={{ tab: "security", title: "去安全页看运行中的后台命令" }}
      />
    </>
  );
}

/** 取序列末项（最新一次采样）；空序列返回 0。 */
function lastOf(series: number[]): number {
  return series.length > 0 ? series[series.length - 1] : 0;
}

function MetricCard({
  label,
  value,
  unit,
  sub,
  seriesKey,
  color,
  chart,
  threshold,
  onNavigate,
  nav,
}: {
  label: string;
  value: string;
  unit?: string;
  sub: string;
  seriesKey: MetricKey;
  /** 图形颜色。用 currentColor 驱动描边与填充，一处定色。 */
  color: string;
  /** 图形形态。由数据性质决定，见组件头注释的对照表。 */
  chart: ChartKind;
  /** 仅 area 用：阈值参考线的数值（限流阈值）。 */
  threshold?: number;
  onNavigate?: (tab: string, anchor?: string) => void;
  /** 点击后跳哪。内部无交互元素，所以整卡可点。 */
  nav: { tab: string; anchor?: string; title: string };
}) {
  const series = useMetricSeries(seriesKey);
  // 值变化时弹一下（300ms）。事件驱动：数字不变就完全不动。
  const pop = usePopClass(value);
  return (
    // 整卡可点：这张卡内部没有任何交互元素，所以不需要 StopClick。
    <NavTarget
      onNavigate={onNavigate}
      tab={nav.tab}
      anchor={nav.anchor}
      title={nav.title}
      className={`metric-card ${color}`}
    >
      <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-[24px] font-extrabold leading-none tracking-tight text-foreground">
        <span className={pop}>{value}</span>
        {unit && <small className="text-[12px] font-bold text-muted-foreground">{unit}</small>}
      </div>
      <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground" title={sub}>
        {sub}
      </div>
      <Sparkline series={series} kind={chart} threshold={threshold} />
    </NavTarget>
  );
}

