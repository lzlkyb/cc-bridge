import { useEffect, useRef } from "react";

/**
 * 折叠块展开时平滑滚动到块头，让展开的内容进入视野。
 *
 * 规则（沿用原 ConnectGuide/TokenManager 的行为）：**首屏不自动滚动**（避免进入即
 * 跳动）——挂载后的第一次 open 变化（含初始值就是展开的）不滚，仅之后用户主动
 * 展开时才滚。滚动后回拉 60px，抵消 sticky 头部的遮挡。
 *
 * 收口来源：连接页评审修复 ⑤。此前同一段 mounted-guard + rAF + scrollBy 逻辑在
 * ConnectGuide（×3）与 TokenManager（×1）各复制一份，共四段。
 */
export function useAutoScrollOnExpand<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      window.scrollBy({ top: -60, behavior: "instant" });
    });
  }, [open]);

  return ref;
}
