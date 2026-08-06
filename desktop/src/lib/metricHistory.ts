import { useSyncExternalStore } from "react";
import type { StatusResponse } from "./types";

/**
 * 指标历史环形缓冲（连接页 Bento 指标卡的 sparkline 数据源）。
 *
 * **数据从哪来**：后端 `stats` 全是标量，**没有任何时间序列**。硬画折线就是编数据。
 * 所以序列由前端自己累积：现有的 5s `["status"]` 轮询每回一次，推一个点。
 * **后端零改动，也不新增任何轮询**——它搭的是已经在跑的那一条。
 *
 * **两个写在脸上的局限**（已与使用方确认过的取舍）：
 * 1. 序列存在 webview 内存里。「关窗时释放界面内存」开关打开时，重开窗口历史归零。
 * 2. 窗口隐藏期间不采样（轮询本来就停了，见 `appVisibility.ts`）。恢复后若距上次
 *    采样超过 {@link MAX_GAP_MS}，**清空重来**——而不是把断层当连续数据接上去。
 *    后者会让图上相邻两点看起来相隔 5s、实际可能隔了半小时，那是**对时间轴撒谎**。
 *
 * **为何是模块级 store 而不是 Context**：与 `appVisibility.ts` 同理——采样只能有一个写入方，
 * 而读取方是四张彼此无关的卡。模块级 store + `useSyncExternalStore` 让每张卡只订阅
 * 自己那一条序列，不用包 Provider、也不会因为容器持有数据而把整个 Bento 子树拖下水。
 */

/** 保留的采样点数。× 5s 轮询 = 五分钟趋势。 */
export const MAX_POINTS = 60;

/**
 * 两次采样的最大允许间隔。超过它说明中间断过（窗口隐藏 / 休眠 / 请求堆积），
 * 序列作废重来。取 15s = 5s 轮询周期的 3 倍，给偶尔的慢请求留余地，
 * 又不至于把真实的断层放过去。
 */
export const MAX_GAP_MS = 15_000;

/** 一次采样里四条序列各自的值。 */
export interface MetricSample {
  /** 请求速率（次/分）。后端已是 60s 滑动窗口，相邻采样重叠很多 → 曲线平滑但有滞后。 */
  rpm: number;
  /** P95 延迟（ms）。 */
  p95: number;
  /** 调用增量：相邻两次采样的 totalRequests 差值。累计值画出来是单调上升直线，零信息量。 */
  delta: number;
  /** 活跃后台命令数。取值小且离散，曲线呈阶梯状——这就是它真实的样子，不做平滑。 */
  active: number;
}

/** 可读的序列名。 */
export type MetricKey = keyof MetricSample;

interface HistoryState {
  series: Record<MetricKey, number[]>;
  /** 上一次采样的壁钟（ms），用于断层判定。 */
  lastAt: number;
  /** 上一次的 totalRequests，用于算增量。 */
  lastTotal: number;
  /**
   * 本会话最近一次观测到 totalRequests 上涨的壁钟（ms）；null = 本会话未观测到。
   *
   * 链路图第三段用它开口说「N 秒前」。**为 null 时绝不能编一个时间**——
   * 只能说「本次运行已调用 N 次」。
   */
  lastIncreaseAt: number | null;
}

function emptyState(): HistoryState {
  return {
    series: { rpm: [], p95: [], delta: [], active: [] },
    lastAt: 0,
    lastTotal: 0,
    lastIncreaseAt: null,
  };
}

let state: HistoryState = emptyState();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/**
 * 推入一次采样。由 `<MetricSampler />` 在每次 status 轮询回来时调用。
 *
 * `now` 显式传入而不是内部调 `Date.now()`：单测要能控制时间推进来验证断层逻辑。
 */
export function pushSample(stats: StatusResponse["stats"], now: number) {
  const gap = now - state.lastAt;
  // 首次采样（lastAt=0）或断层：丢掉旧序列重来。不这么做就是对时间轴撒谎。
  // 注意这里也重置 lastIncreaseAt：断层期间可能发生过调用，但我们没看到，
  // 继续拿旧时间说「N 秒前」会是错的。
  const broken = state.lastAt === 0 || gap > MAX_GAP_MS;
  if (broken) {
    state = {
      ...emptyState(),
      // 🔴 首次（或断层后重建）**不是什么都不产出**：
      // rpm / p95 / active 都是**绝对量**，第一次采样就是一个完全有效的值。
      // 之前一律置空，导致要等 3 次轮询（15s）才能凑出 2 个点画图——
      // 加上 HMR / 切 Tab / 窗口隐藏导致的重建，就变成“大半时间在采样中”。
      //
      // 只有 delta 必须留空：它是相邻两次的差值，首次**无从得知**。
      // 填 0 是编数据（“这 5s 没有新调用”并非事实），宁可少一个点。
      series: {
        rpm: [stats.requestsPerMin],
        p95: [stats.p95LatencyMs],
        active: [stats.activeCommands],
        delta: [],
      },
      lastAt: now,
      lastTotal: stats.totalRequests,
    };
    emit();
    return;
  }

  const delta = Math.max(0, stats.totalRequests - state.lastTotal);
  const next: MetricSample = {
    rpm: stats.requestsPerMin,
    p95: stats.p95LatencyMs,
    delta,
    active: stats.activeCommands,
  };

  const series = {} as Record<MetricKey, number[]>;
  for (const k of Object.keys(state.series) as MetricKey[]) {
    const arr = state.series[k].concat(next[k]);
    // 定长窗口：超出从头丢。slice 会建新数组，这是故意的——
    // useSyncExternalStore 靠引用变化判定更新，原地 push 会让订阅者看不到变化。
    series[k] = arr.length > MAX_POINTS ? arr.slice(arr.length - MAX_POINTS) : arr;
  }

  state = {
    series,
    lastAt: now,
    lastTotal: stats.totalRequests,
    lastIncreaseAt: delta > 0 ? now : state.lastIncreaseAt,
  };
  emit();
}

/** 仅测试用：重置模块级状态，避免用例间污染。 */
export function __resetMetricHistoryForTest() {
  state = emptyState();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** getServerSnapshot / 无 document 环境的稳定空引用（每次新建会触发无限重渲）。 */
const EMPTY: number[] = [];
const EMPTY_ACTIVITY: RemoteActivity = { lastIncreaseAt: null };

/** 链路图第三段要的“远程活跃度”。 */
export interface RemoteActivity {
  /**
   * 本会话最近一次观测到新调用的壁钟（ms）。
   * **为 null 时调用方只能说「本次运行已调用 N 次」，不得编一个时间。**
   */
  lastIncreaseAt: number | null;
}

/**
 * 读一条序列的当前快照（非 React）。
 *
 * 不足 {@link MAX_POINTS} 时返回的就是已有的那几个点，**不补零、不拉伸**。
 * 画图时左对齐即可；少于 2 点不该画线。
 */
export function getSeries(key: MetricKey): number[] {
  return state.series[key];
}

/** 读远程活跃度快照（非 React）。 */
export function getRemoteActivity(): RemoteActivity {
  // 缓存对象：useSyncExternalStore 要求 getSnapshot 幂等，每次新建对象会无限循环。
  if (activityCache.lastIncreaseAt !== state.lastIncreaseAt) {
    activityCache = { lastIncreaseAt: state.lastIncreaseAt };
  }
  return activityCache;
}
let activityCache: RemoteActivity = EMPTY_ACTIVITY;

/**
 * 订阅一条序列。返回的数组引用仅在新采样时变化，可直接做 `useMemo` 依赖。
 */
export function useMetricSeries(key: MetricKey): number[] {
  return useSyncExternalStore(
    subscribe,
    () => getSeries(key),
    () => EMPTY,
  );
}

/** 订阅远程活跃度。 */
export function useRemoteActivity(): RemoteActivity {
  return useSyncExternalStore(subscribe, getRemoteActivity, () => EMPTY_ACTIVITY);
}
