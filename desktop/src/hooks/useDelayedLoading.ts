import { useEffect, useState } from "react";

/** 骨架屏的延迟门阈值（毫秒）。
 *
 *  为何是 150：本地 SQLite / invoke 通常 30~90ms 就回来了，骨架只会闪一下，
 *  比不显示更难看清（业界把 100~200ms 当作「用户开始感知等待」的分界）。
 *  超过这条线才画骨架，短于它就直接出内容 —— 消除「闪一下灰块」。 */
export const SKELETON_DELAY_MS = 150;

/** 延迟显示骨架：`loading` 持续超过 `delay` 才返回 true。
 *
 *  - `loading` 转 false 立即返回 false，不残留（避免内容已出、骨架还在淡出）；
 *  - 每次 `loading` 重新变 true 都从零计时，快速切档不会继承上一轮的 true；
 *  - 计时器随 effect 清理，卸载后不会再 setState。
 *
 *  用法：`const showSkeleton = useDelayedLoading(isLoading); ... {showSkeleton && <Skeleton/>}`
 */
export function useDelayedLoading(loading: boolean, delay = SKELETON_DELAY_MS): boolean {
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!loading) {
      setExpired(false);
      return;
    }
    // 重置放在计时之前：loading 连续为 true 但 delay 变了（热更新）时也能重新计。
    setExpired(false);
    const timer = window.setTimeout(() => setExpired(true), delay);
    return () => window.clearTimeout(timer);
  }, [loading, delay]);

  return loading && expired;
}
