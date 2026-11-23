/**
 * 中转页的数据订阅：一份快照 + 四条采样序列。
 *
 * 为什么把采样放在这里而不是各张指标卡自己攒：四张卡要的是**同一批采样点**
 * （同一个 2 秒节拍上取的今日累计），各攒一份会在时间轴上错开，四张图的
 * 横坐标就不是同一段时间了。
 *
 * 轮询口径：
 * - 2 秒一次（§4.9 的常驻看板；比连接页的 5 秒密，因为这一页的数字增速是每秒级）
 * - 窗口隐藏时不轮询（`useAppHidden`）——后台常转的定时器在这个常驻托盘应用里
 *   是真花钱的，连接页那边有实测数字。
 * - **不缓存过期数据**：`gcTime` 让页面卸载 30 秒后丢掉缓存，重新进来是新的一轮
 *   采样，而不是接上一段早就过期的曲线。
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import { useAppHidden } from "../lib/appVisibility";
import { MAX_POINTS } from "../lib/metricHistory";
import { deltaOf, foldRate } from "../lib/relayFormat";
import type { RelaySnapshot } from "../lib/types";

/** 四条序列，与四张指标卡一一对应。 */
export interface RelaySeries {
  /** 每个采样区间内新增的请求数（面积）。 */
  requests: number[];
  /** 该采样的首字 P50（柱状）。 */
  firstByte: number[];
  /** 该采样的改写率 0–100（热力）。 */
  fold: number[];
  /** 每个采样区间新增的错误数（阶梯）。 */
  errors: number[];
}

const EMPTY_SERIES: RelaySeries = { requests: [], firstByte: [], fold: [], errors: [] };

/** 与 `MAX_POINTS` 对齐：图表几何按这个点数算宽度，序列更长会被截断。 */
function push(series: number[], value: number): number[] {
  const next = [...series, value];
  return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
}

export function useRelayStatus() {
  const appHidden = useAppHidden();
  const query = useQuery<RelaySnapshot, Error>({
    queryKey: ["relay"],
    queryFn: () => invoke<RelaySnapshot>("relay_status"),
    refetchInterval: appHidden ? false : 2000,
    gcTime: 30_000,
    // 失败时不要把上一次的成功快照清掉：那会让整页在一秒内闪成空态再填回来。
    placeholderData: (prev) => prev,
  });

  const [series, setSeries] = useState<RelaySeries>(EMPTY_SERIES);
  // 上一次的累计值。第一拍只建基线、不产出样本 —— 否则首屏会凭空冒出一根
  // 「今日全部请求都在这一瞬间发生」的柱子。
  const prevRef = useRef<{ requests: number; errors: number } | null>(null);
  const stats = query.data?.stats;

  useEffect(() => {
    if (!stats) return;
    const prev = prevRef.current;
    prevRef.current = { requests: stats.todayRequests, errors: stats.todayErrors };
    if (!prev) return;
    setSeries((cur) => ({
      requests: push(cur.requests, deltaOf(stats.todayRequests, prev.requests)),
      firstByte: push(cur.firstByte, stats.firstByteP50Ms ?? 0),
      fold: push(cur.fold, foldRate(stats)),
      errors: push(cur.errors, deltaOf(stats.todayErrors, prev.errors)),
    }));
  }, [stats]);

  // 换了一次运行（停止 → 重新打开）就把序列清空：那两段曲线之间没有连续性，
  // 连起来会让人以为「中间一直在跑」。
  const running = query.data?.running ?? false;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current === running) return;
    wasRunning.current = running;
    prevRef.current = null;
    setSeries(EMPTY_SERIES);
  }, [running]);

  return { ...query, series };
}
