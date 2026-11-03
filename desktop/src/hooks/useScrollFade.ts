import { useEffect, useRef } from "react";

/** 判定「已到边缘」的容差：像素对齐会让 scrollLeft 差 1，不留容差会把贴边渲染成可滚。 */
const EDGE = 1;

/**
 * 横向溢出渐隐：给滚动容器标 `data-fade-left` / `data-fade-right`，CSS 据此在对应一侧
 * 做 mask 渐变（见 `terminal-workspace.css` 的 `.terminal-tabs-scroll`）。
 *
 * WHY 直接写 DOM 属性而不是返回 state：滚动事件一秒能来几十次，走 state 会让整条标签栏
 * （含每个标签的徽标、tooltip、进度条）跟着重渲染，而这里要变的只是容器自己的两个属性。
 * 属性由 CSS 消费，React 不参与，滚动期间零渲染。
 *
 * 三种变化都要重算：
 * - `scroll`：拖动 / 滚轮 / `scrollIntoView`；
 * - `ResizeObserver`：窗口变宽变窄，可见宽度变了；
 * - `MutationObserver`：多开或关掉标签时 `scrollWidth` 变了，但容器自身宽度没变，
 *   上面那个 resize 观察器**收不到通知**——漏掉它的话，「刚溢出」的那一刻不会出现渐隐。
 */
export function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const overflow = el.scrollWidth - el.clientWidth;
      const scrollable = overflow > EDGE;
      el.toggleAttribute("data-fade-left", scrollable && el.scrollLeft > EDGE);
      el.toggleAttribute("data-fade-right", scrollable && el.scrollLeft < overflow - EDGE);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    const mo = new MutationObserver(sync);
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  return ref;
}
