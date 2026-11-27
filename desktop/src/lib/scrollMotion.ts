/** Native easing is useful within a screen. Longer jumps should land without a scroll tour. */
export function scrollMotion(distance: number, viewportHeight: number): ScrollBehavior {
  return Math.abs(distance) <= viewportHeight
    && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    ? "smooth" : "instant";
}

export function scrollToAnchor(target: HTMLElement | null | undefined, block: "start" | "center", viewport?: HTMLElement | null) {
  if (!target) return;
  viewport ??= target.closest<HTMLElement>("[data-scroll-viewport]") ?? undefined;
  const rect = target.getBoundingClientRect();
  const bounds = viewport?.getBoundingClientRect();
  const height = viewport?.clientHeight ?? window.innerHeight;
  const align = block === "center" ? (height - rect.height) / 2 : 0;
  target.scrollIntoView({ block, behavior: scrollMotion(rect.top - (bounds?.top ?? 0) - align, height) });
}

const highlights = new WeakMap<Element, number>();

export function highlightAnchor(target: Element) {
  window.clearTimeout(highlights.get(target));
  target.classList.add("anchor-highlight");
  highlights.set(target, window.setTimeout(() => {
    target.classList.remove("anchor-highlight");
    highlights.delete(target);
  }, 2000));
}
