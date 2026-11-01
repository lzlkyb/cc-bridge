import { useEffect, useState } from "react";

/**
 * 「现在」的每秒快照。`active` 为假时**不建定时器**。
 *
 * 抽出来是为了让「停滞提示」这类纯展示的计时不把整个消息流带着每秒重渲染 ——
 * 用它的人是小浮条 / 状态行，`MessageList` 一个字节都不用动。
 * 与 `useExpiryCountdown` 的区别：那个是倒计时（有终点、要按身份重来），
 * 这个是单调时钟（起点无关），别合并。
 */
export function useNowTick(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // 立刻对齐一次：`active` 刚从假变真时，state 里还留着上一次的旧值，
    // 不刷新会让头一秒的文案停在上次的时刻。
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [active, ms]);
  return now;
}
