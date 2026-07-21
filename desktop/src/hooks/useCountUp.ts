import { useEffect, useRef, useState } from "react";

interface CountUpOptions {
  /** 入场动画时长(ms)，默认 700 */
  duration?: number;
  /** 是否启用数字滚动；关闭（如减弱动效）时直接显示终值 */
  enabled?: boolean;
}

/**
 * 数字滚动（count-up）：组件首次挂载时从 0 缓动到 target。
 * - 仅播一次入场动画，后续 target 变化（如 5s 轮询）直接跟随终值，不再重播，避免数字乱跳。
 * - enabled=false（减弱动效 / 未运行）时直接显示 target。
 * 用于 Hero 指标数字入场，提升「质感」。
 */
export function useCountUp(target: number, { duration = 700, enabled = true }: CountUpOptions = {}): number {
  const [val, setVal] = useState(enabled ? 0 : target);
  const isFirst = useRef(true);

  useEffect(() => {
    if (!enabled) {
      setVal(target);
      return;
    }
    if (isFirst.current) {
      // 首帧真实值还未到达（target=0，如异步轮询未回）时不消耗入场动画，
      // 否则真实值到达后只会直接 setVal(target)、不再从 0 滚动。
      if (target === 0) {
        setVal(0);
        return;
      }
      isFirst.current = false;
      const start = performance.now();
      let raf = 0;
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
        setVal(target * eased);
        if (p < 1) raf = requestAnimationFrame(tick);
        else setVal(target);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    // 后续更新：直接跟随，不重播
    setVal(target);
  }, [target, enabled, duration]);

  return val;
}
