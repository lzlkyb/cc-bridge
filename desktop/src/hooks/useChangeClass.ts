import { useEffect, useRef, useState } from "react";

/**
 * 值发生变化时临时挂上一个 class，`ms` 后自动摘除。
 *
 * 用来做**事件驱动**的一次性动画：值不变就完全不动，零常驻开销。
 * 这是本项目对待动画的基本立场：`index.css` 里有三条带实测数字的删除记录
 * （整卡呼吸 ~3% / 地址流光 ~2% / 顶部流光 ~1% CPU）——常驻 paint 动画是真金白银买的。
 *
 * 不需要在这里处理 `prefers-reduced-motion`：`index.css` 已有全局兜底
 * （把所有元素的 `animation-duration` 压到 0.001ms）。JS 驱动的动画（如 `useCountUp`）
 * 才需要自己查该偏好。
 */
export function useChangeClass(value: string | number, cls: string, ms = 300): string {
  const prev = useRef(value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return on ? cls : "";
}

/**
 * 数值变化时弹一下（scale 1 → 1.08 → 1，300ms）。
 *
 * 从已删的 `HeroStats.tsx` 里救回来的——它配套的 `.hero-metric-pop` / `@keyframes metric-pop`
 * 一直还在 `index.css` 里（A2），只是用它的组件被换掉了。
 */
export function usePopClass(value: string | number): string {
  return useChangeClass(value, "metric-pop", 300);
}
