import {
  sparklinePath,
  sparkBars,
  sparkStep,
  sparkHeat,
  SPARK_W,
  SPARK_H,
  BAR_FULL_H,
  BAR_TOP,
} from "../../lib/sparkline";
import { MAX_POINTS } from "../../lib/metricHistory";
import { useChangeClass } from "../../hooks/useChangeClass";

/**
 * 指标卡里的趋势小图，按形态分派到四种画法。坐标全部由 `lib/sparkline.ts` 算（已单测）。
 *
 * 从 `MetricCards.tsx` 拆出来的原因很实在：合在一起 303 行，破了 300 行上限。
 * 拆开后职责也更清楚——那边管数据与卡片外壳，这边只管把序列画成图。
 */

/** 四种图形形态。 */
export type ChartKind = "area" | "bars" | "heat" | "step";

/**
 * 趋势小图，按 `kind` 分派到四种形态。坐标全部由 `lib/sparkline.ts` 算（已单测）。
 *
 * 点不够时**不画图**，而是写“采样中…”。为何不随便画一条横线充数：
 * 那会让人误以为“一直平稳”，而事实是“还没攒够数据”——两回事。
 */
export function Sparkline({
  series,
  kind,
  threshold,
}: {
  series: number[];
  kind: ChartKind;
  threshold?: number;
}) {
  // 阶梯线的“重画”触发：只看末值（当前活跃命令数）变没变。
  // hook 必须在任何 return 之前调用。
  const stepRedraw = useChangeClass(
    series.length > 0 ? series[series.length - 1] : -1,
    "metric-spark__step--redraw",
    500,
  );

  // 🔴 出图门槛按形态区分，而不是一律 2 点。
  //
  // 折线 / 阶梯线**必须**两个点才连得成线；柱状与热力条一个点就能画（一根柱、一格色块），
  // 而且那一格是真实数据，不是占位。之前一律要求 2 点，配合“首次采样不产出”，
  // 意味着最快也要 15s 才出图——这是“大半时间在采样中”的另一半原因。
  const minPoints = kind === "area" || kind === "step" ? 2 : 1;
  if (series.length < minPoints) {
    return (
      <div className="flex min-h-[30px] flex-1 items-end pb-1 text-[9.5px] text-muted-foreground opacity-70">
        采样中…
      </div>
    );
  }

  return (
    // 包一层相对容器：面积图的末端标点是绝对定位的 HTML 圆点，不能放进 SVG
    // （preserveAspectRatio="none" 会把正圆抻成椭圆，详见 index.css 里的说明）。
    <div className="relative flex min-h-[30px] flex-1">
      <svg
        className="metric-spark"
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {kind === "area" && <AreaShape series={series} threshold={threshold} />}
        {/* 柱：画满高的 rect + scaleY 缩放。为何不直接给 height——
            height 变化是重绘，transform 走纯合成，过渡才不掉帧。 */}
        {kind === "bars" &&
          sparkBars(series, MAX_POINTS).map((b, i) => (
            <rect
              key={i}
              className="metric-spark__bar"
              x={b.x}
              y={BAR_TOP}
              width={b.w}
              height={BAR_FULL_H}
              style={{ transform: `scaleY(${b.ratio})` }}
            />
          ))}
        {kind === "heat" &&
          sparkHeat(series, MAX_POINTS).map((c, i) => (
            <rect
              key={i}
              className="metric-spark__heat"
              x={c.x}
              y={PAD_HEAT}
              width={c.w}
              height={SPARK_H - PAD_HEAT * 2}
              opacity={c.level}
            />
          ))}
        {/* 阶梯线：points 无法过渡，所以值变化时用「重画一遍」表达变化
            （redraw 类由下方 useChangeClass 在末值变化时挂 450ms）。 */}
        {kind === "step" && (
          <polyline
            className={`metric-spark__line metric-spark__step ${stepRedraw}`}
            points={sparkStep(series, MAX_POINTS) ?? ""}
          />
        )}
      </svg>
      {kind === "area" && <AreaTip series={series} />}
    </div>
  );
}

/** 热力条上下留白，让它读起来是一条“带”而不是铺满整块。 */
const PAD_HEAT = 9;

/** 面积折线 + 阈值虚线。 */
function AreaShape({ series, threshold }: { series: number[]; threshold?: number }) {
  const path = sparklinePath(series, MAX_POINTS, threshold);
  if (!path) return null;
  return (
    <>
      <polyline className="metric-spark__area" points={path.area} />
      <polyline className="metric-spark__line" points={path.line} />
      {/* 阈值线只在落进可视范围时才有值（见 sparklinePath 注释：
          线的出现本身就是“接近限流”的预警）。 */}
      {path.thresholdY != null && (
        <line
          className="metric-spark__threshold"
          x1={0}
          x2={SPARK_W}
          y1={path.thresholdY}
          y2={path.thresholdY}
        />
      )}
    </>
  );
}

/** 面积图的末端标点（HTML 圆点，避免被 SVG 非等比拉伸成椭圆）。 */
function AreaTip({ series }: { series: number[] }) {
  const path = sparklinePath(series, MAX_POINTS);
  if (!path) return null;
  return (
    <span
      aria-hidden="true"
      className="metric-spark__tip"
      style={{ left: `${path.lastX}%`, top: `${(path.lastY / SPARK_H) * 100}%` }}
    />
  );
}
