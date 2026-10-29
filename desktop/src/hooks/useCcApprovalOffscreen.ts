import { useEffect, useState, type RefObject } from "react";

/** Prefer the first card whose content is clipped; all cards are pending at this point. */
export function firstOffscreenApproval(root: HTMLElement) {
  const viewport = root.getBoundingClientRect();
  const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-cc-approval]"));
  return cards.find(card => {
    const rect = card.getBoundingClientRect();
    return rect.top < viewport.top || rect.bottom > viewport.bottom;
  }) ?? cards[0];
}

/** Keep the approval shortcut when any pending card cannot be fully read in the stream. */
export function useCcApprovalOffscreen(scrollRef: RefObject<HTMLDivElement>, pendingKey: string) {
  const [offscreen, setOffscreen] = useState(true);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !pendingKey || typeof IntersectionObserver === "undefined") return;
    const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-cc-approval]"));
    if (!cards.length) return;
    const visible = new Map(cards.map(card => [card, false]));
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) visible.set(entry.target as HTMLElement, entry.intersectionRatio >= 0.99);
      setOffscreen([...visible.values()].some(value => !value));
    }, { root, threshold: [0, 0.99, 1] });
    cards.forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [scrollRef, pendingKey]);
  return offscreen;
}
