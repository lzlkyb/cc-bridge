/**
 * sparkline 坐标计算（纯函数，与渲染分离以便单测）。
 *
 * 两个关键取舍，都是为了**不让图撒谎**：
 *
 * 1. **从零缩放，而不是 min-max 归一化**。min-max 是 sparkline 最常见的谎：
 *    140ms → 142ms 的微小波动会被拉成满幅山峰，读者以为出了大事。
 *    从零缩放后，平稳就是平的、空闲就贴底，幅度与量级直接对应。
 * 2. **不足 maxPoints 时左对齐，不拉伸填满**。刚开窗只有 3 个点时，拉满全宽会
 *    让人以为已经看到了完整的五分钟趋势。左对齐后，“数据还没攒够”是能看得出来的。
 */

/** viewBox 宽。固定 100 方便算百分位；实际宽度由 CSS 拉伸。 */
export const SPARK_W = 100;
/** viewBox 高。 */
export const SPARK_H = 30;

/** 顶部留白：避免最高点的描边被 viewBox 上沿削掉。 */
const PAD_TOP = 2;
/** 底部基线：同理留 1px。 */
const BASELINE = SPARK_H - 1;

export interface SparkPath {
  /** 折线的 points。 */
  line: string;
  /** 填充区的 points（折线 + 回到底边闭合）。 */
  area: string;
  /** 末端（最新一个采样）的坐标，用来画一个标点标明“这是当前值”。 */
  lastX: number;
  lastY: number;
  /**
   * 阈值参考线的 y；`null` = 阈值超出当前可视范围，**不该画**。
   * 详见 `sparklinePath` 里的说明：“线的出现”本身就是预警信号。
   */
  thresholdY: number | null;
}

const r = (n: number) => Math.round(n * 100) / 100;

/**
 * 共用的缩放器。四种图形全走同一套“从零缩放”，否则同一张卡换个形态
 * 高低就变了，读者会以为数据变了。
 */
function scaleOf(values: number[]) {
  const hi = Math.max(...values, 0);
  const span = BASELINE - PAD_TOP;
  return {
    hi,
    yOf: (v: number) => (hi <= 0 ? BASELINE : BASELINE - (Math.max(0, v) / hi) * span),
  };
}

/** 四种图形共用的步长。按 maxPoints 算 → 点没攒满时左对齐不拉伸。 */
const stepXOf = (maxPoints: number) => SPARK_W / (maxPoints - 1);

/**
 * 算出折线与填充区的 SVG points。
 *
 * 返回 `null` 表示**不应该画线**（少于 2 个点）——单个点连不成趋势，
 * 画一条横线只会让人误以为“一直平稳”。调用方此时应该显示“采样中…”。
 *
 * @param values 时间序列，最旧在前。
 * @param maxPoints 满幅对应的点数（= `metricHistory` 的 MAX_POINTS）。
 */
export function sparklinePath(
  values: number[],
  maxPoints: number,
  /** 参考线的数值（如限流阈值）。不传则不算。 */
  threshold?: number,
): SparkPath | null {
  if (values.length < 2 || maxPoints < 2) return null;

  // 从零缩放：上界取序列最大值。全零（或全负，理论上不应出现）时贴底画平线——
  // 那确实就是“什么都没发生”的真实样子。
  const { hi, yOf } = scaleOf(values);

  // 步长按 maxPoints 算，而不是按 values.length——这就是“不拉伸”的具体体现。
  const stepX = stepXOf(maxPoints);
  const pts = values.map((v, i) => `${r(i * stepX)},${r(yOf(v))}`);
  const line = pts.join(" ");
  const lastX = r((values.length - 1) * stepX);
  const lastY = r(yOf(values[values.length - 1]));

  return {
    line,
    // 填充区：从左下角起、走完折线、再从最后一个点落回底边闭合。
    // 注意终点用 lastX 而非 SPARK_W：否则点没攒满时填充区会凭空多出一块。
    area: `0,${SPARK_H} ${line} ${lastX},${SPARK_H}`,
    lastX,
    lastY,
    // 🔴 阈值线**只在落在可视范围内时才给**。
    //
    // 为何不改成按阈值缩放（0..threshold）：那样当前速率 18 / 限流 120 时
    // 曲线会被压到底部 15% 高，完全看不出趋势形状。
    // 也不能把超出范围的阈值线夹到顶边——那是对位置撒谎。
    //
    // 返回 null 对调用方反而是个好信号：线没出现 = 离限流还很远；
    // 线一出现 = 已经接近阈值。“线的出现”本身就是预警。
    thresholdY:
      threshold != null && threshold > 0 && hi > 0 && threshold <= hi ? r(yOf(threshold)) : null,
  };
}

/** 单根柱。 */
export interface SparkBar {
  x: number;
  w: number;
  /**
   * 高度比例 0..1。
   *
   * 🔴 **为何给比例而不是直接给 y/height**：柱高变化要能平滑过渡，
   * 而 `height` 就算能过渡也是重绘。改成画满高的 rect + `transform: scaleY(ratio)`，
   * transform 走纯合成。几何由 CSS 的 `transform-box: fill-box` 定位。
   */
  ratio: number;
}

/** 柱的完整高（viewBox 单位）。组件画 rect 时用：y=PAD_TOP、height=BAR_FULL_H。 */
export const BAR_FULL_H = BASELINE - PAD_TOP;
/** 柱顶的 y。 */
export const BAR_TOP = PAD_TOP;

/** 柱数。 */
export const BAR_CELLS = 20;

/**
 * 柱状（P95 延迟用）。
 *
 * **为何用柱而不是折线**：P95 是每 5s 一个**离散采样**，连线会暗示
 * 两次采样之间存在连续变化，而那段根本没有数据。柱不做这个暗示。
 *
 * 🔴 **为何聚合到 {@link BAR_CELLS} 根**：60 根柱挤在 span-2 的卡里（约 140px）
 * 每根只有 1.4px，根本看不见。聚成 20 根后每根约 4.3px。
 * 顺带把 SVG 节点从 60 降到 20。
 *
 * 🔴 **用 max 而不是均值聚合**（与热力条相反）：
 * - 热力条问的是“忙不忙”（强度）→ 均值对；
 * - P95 问的是“有没有卡顿”（极值）→ **均值会把尖峰抹平，而尖峰正是
 *   这个指标要暴露的东西**。取 max = “这 15 秒里最慢的一次 P95”。
 * max 的另一个好处：末组不完整也直接可比（不像求和会天然偏小）。
 */
export function sparkBars(values: number[], maxPoints: number): SparkBar[] {
  if (values.length === 0 || maxPoints < 2) return [];
  const groupSize = Math.max(1, Math.ceil(maxPoints / BAR_CELLS));
  const slotW = SPARK_W / BAR_CELLS;

  // 左对齐分组（与其它形态一致）：第 i 根盖 [i*groupSize, (i+1)*groupSize)。
  const peaks: number[] = [];
  for (let i = 0; i * groupSize < values.length; i++) {
    const g = values.slice(i * groupSize, (i + 1) * groupSize);
    peaks.push(Math.max(...g.map((v) => Math.max(0, v))));
  }

  const hi = Math.max(...peaks, 0);
  // 柱宽取槽位的 62%，留出缝隙才看得出“一根一段时间窗”。
  const w = r(slotW * 0.62);
  // 最小比例对应约 0.5 个 viewBox 单位：值为 0 时仍留一道极细的底纹，
  // 读作“有采样但值是 0”；完全不画会让空闲时整张卡看起来像坏了。
  const minRatio = 0.5 / BAR_FULL_H;
  return peaks.map((v, i) => ({
    x: r(i * slotW),
    w,
    ratio: hi <= 0 ? r(minRatio) : r(Math.max(minRatio, v / hi)),
  }));
}

/**
 * 阶梯线（活跃命令用）。step-after 语义：值保持不变直到下一次采样。
 *
 * **为何不用普通折线**：活跃命令数是 0/1/2/3 这种小整数，从 0 变 2 是
 * **瞬时跳变**，不存在 1.4 个命令这回事。折线把阶梯画成斜坡，是错的。
 */
export function sparkStep(values: number[], maxPoints: number): string | null {
  if (values.length < 2 || maxPoints < 2) return null;
  const { yOf } = scaleOf(values);
  const stepX = stepXOf(maxPoints);
  const pts: string[] = [];
  values.forEach((v, i) => {
    const y = r(yOf(v));
    const x = r(i * stepX);
    pts.push(`${x},${y}`);
    // 向右平推到下一个采样点（最后一个也推一格，表示“当前值仍在持续”）。
    pts.push(`${r((i + 1) * stepX)},${y}`);
  });
  return pts.join(" ");
}

/** 热力条的一格。 */
export interface HeatCell {
  x: number;
  w: number;
  /** 0..1，映射到不透明度。 */
  level: number;
}

/** 热力条的格数。 */
export const HEAT_CELLS = 15;

/**
 * 热力条（调用增量用）。
 *
 * **为何用热力而不是折线**：这个指标要回答的是“**什么时候忙**”，
 * 而不是“具体多少”（具体值已经写在主数字里）。深浅条扫一眼就能看出节奏。
 *
 * 🔴 **为何要聚合而不是一采样一格**：60 个采样挤在 span-2 的卡里（约 140px）
 * 每格只有 2.3px，根本看不清。聚成 {@link HEAT_CELLS} 格后每格约 9px。
 *
 * **用均值而不是求和**：最后一组往往是不完整的（比如只攒了 2 个采样），
 * 求和会让它天然偏小、与前面的完整组不可比；均值（每 5s 平均增量）同量纲，
 * 不完整组也能直接上图。
 */
export function sparkHeat(values: number[], maxPoints: number): HeatCell[] {
  if (values.length === 0 || maxPoints < 2) return [];
  const groupSize = Math.max(1, Math.ceil(maxPoints / HEAT_CELLS));
  const slotW = SPARK_W / HEAT_CELLS;

  // 左对齐分组（与其他三种图形一致）：第 i 格盖 [i*groupSize, (i+1)*groupSize)。
  const means: number[] = [];
  for (let i = 0; i * groupSize < values.length; i++) {
    const g = values.slice(i * groupSize, (i + 1) * groupSize);
    means.push(g.reduce((a, b) => a + Math.max(0, b), 0) / g.length);
  }

  const hi = Math.max(...means, 0);
  return means.map((m, i) => ({
    x: r(i * slotW),
    // 留 0.4 的缝：完全紧贴会糊成一条渐变，分不出格。
    w: r(slotW - 0.4),
    // hi<=0（全空闲）时全部给一个极浅的底色，读作“有采样但都是 0”。
    level: hi <= 0 ? 0.08 : r(Math.max(0.08, m / hi)),
  }));
}
