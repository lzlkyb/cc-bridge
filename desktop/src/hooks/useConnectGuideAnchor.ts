import { useEffect, useRef } from "react";
import { CONNECT_GUIDE_ANCHOR } from "../lib/connectionAccess";

/** Keep every shortcut on the existing access card, including repeated navigation to this page. */
export function useConnectGuideAnchor(highlight?: { anchor: string; nonce: number } | null) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight?.anchor !== CONNECT_GUIDE_ANCHOR) return;
    const timer = window.setTimeout(() => {
      const card = region.current;
      if (!card) return;
      card.scrollIntoView({ block: "start", behavior: "smooth" });
      card.focus({ preventScroll: true });
      card.classList.remove("anchor-highlight");
      void card.offsetWidth;
      card.classList.add("anchor-highlight");
    }, 180);
    return () => window.clearTimeout(timer);
  }, [highlight?.anchor, highlight?.nonce]);
  return region;
}
