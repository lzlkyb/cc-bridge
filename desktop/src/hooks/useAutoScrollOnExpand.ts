import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/**
 * 折叠块展开时平滑滚动到块头，让展开的内容进入视野。
 *
 * 规则（沿用原 ConnectGuide/TokenManager 的行为）：**首屏不自动滚动**（避免进入即
 * 跳动）——挂载后的第一次 open 变化（含初始值就是展开的）不滚，仅之后用户主动
 * 展开时检查入口位置。已在可视区内时不滚动，只对实际滚动容器补足必要定位。
 *
 * 收口来源：连接页评审修复 ⑤。此前同一段 mounted-guard + rAF + scrollBy 逻辑在
 * ConnectGuide（×3）与 TokenManager（×1）各复制一份，共四段。
 */
export function useAutoScrollOnExpand<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T | null>(null);
  const mounted = useRef(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      const container = el.closest<HTMLElement>("[data-scroll-viewport]");
      const bounds = container?.getBoundingClientRect();
      const top = el.getBoundingClientRect().top;
      // 已经可见时不抢滚轮；只把屏外的展开入口带回实际滚动容器。
      if (bounds && (top < bounds.top || top > bounds.bottom - 48)) {
        el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, reduced]);

  return ref;
}
