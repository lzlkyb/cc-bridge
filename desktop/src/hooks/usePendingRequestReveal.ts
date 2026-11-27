import { useEffect, type RefObject } from "react";

/** Expanding the message window must precede scrolling to a pending request that aged out. */
export function usePendingRequestReveal(
  scrollRef: RefObject<HTMLDivElement>,
  request: { id: string; nonce: number } | null | undefined,
  expandAll: () => void,
) {
  useEffect(() => {
    if (!request) return;
    const root = scrollRef.current;
    const find = () => root?.querySelector<HTMLElement>(`[data-cc-message="${CSS.escape(request.id)}"] [data-cc-approval]`);
    if (!find()) expandAll();
    const frame = requestAnimationFrame(() => {
      const card = find();
      if (!card) return;
      const review = card.querySelector<HTMLButtonElement>("[data-cc-approval-focus]");
      if (review) { review.click(); return; }
      root?.dispatchEvent(new Event("cc-reading-jump"));
      card.scrollIntoView({ block: "center", behavior: "instant" });
      card.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollRef, request, expandAll]);
}
