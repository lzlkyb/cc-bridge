import { useEffect, useRef } from "react";
import { CONNECT_GUIDE_ANCHOR } from "../lib/connectionAccess";
import { highlightAnchor, scrollToAnchor } from "../lib/scrollMotion";

/** Keep every shortcut on the existing access card, including repeated navigation to this page. */
export function useConnectGuideAnchor(highlight?: { anchor: string; nonce: number } | null) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight?.anchor !== CONNECT_GUIDE_ANCHOR) return;
    const frame = requestAnimationFrame(() => {
      const card = region.current;
      if (!card) return;
      scrollToAnchor(card, "start");
      card.focus({ preventScroll: true });
      highlightAnchor(card);
    });
    return () => cancelAnimationFrame(frame);
  }, [highlight?.anchor, highlight?.nonce]);
  return region;
}
