import { useEffect, type RefCallback } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/**
 * useAutoAnimate 的「减弱动效」安全封装。
 * - 正常情况：对容器直接子元素增删/移动/排序自动做 FLIP 平滑过渡。
 * - 用户开启「减弱动效」时：调用 auto-animate 的 enable(false) 关闭动画，
 *   退化为即时增删（与全局 reduced-motion 守卫一致）。
 *
 * 用法：const parent = useAutoAnimateRM<HTMLDivElement>(); 然后 <div ref={parent}>...</div>
 */
export function useAutoAnimateRM<T extends HTMLElement = HTMLDivElement>(): RefCallback<T> {
  const [parent, enable] = useAutoAnimate<T>();
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    enable(!reduced);
  }, [reduced, enable]);

  return parent;
}
