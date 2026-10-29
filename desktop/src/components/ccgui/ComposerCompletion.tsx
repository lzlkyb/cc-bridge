import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Keep completion next to the draft, with room measured inside the clipped conversation pane. */
export function ComposerCompletion({ label, active, children }: {
  label: string;
  active: number;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const surface = el?.closest<HTMLElement>(".cc-composer-surface");
    const pane = el?.closest<HTMLElement>("[data-cc-panel]");
    if (!el || !surface) return;
    const place = () => {
      const top = pane?.getBoundingClientRect().top ?? 0;
      // The queue can grow above the draft; anchoring to the dock would push the list out of view.
      el.style.maxHeight = `${Math.max(0, surface.getBoundingClientRect().top - top - 20)}px`;
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(surface);
    if (pane) observer?.observe(pane);
    const dock = surface.closest(".cc-composer-dock");
    if (dock) observer?.observe(dock);
    window.addEventListener("resize", place);
    return () => { observer?.disconnect(); window.removeEventListener("resize", place); };
  }, []);
  useLayoutEffect(() => {
    const list = box.current?.querySelector<HTMLElement>(".cc-completion-options");
    if (!list) return;
    const reveal = () => {
      const item = list.querySelectorAll("button")[active];
      if (!item) return;
      // Only scroll this list; scrollIntoView can also move the conversation behind it.
      const row = item.getBoundingClientRect(), viewport = list.getBoundingClientRect();
      if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top;
      else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
    };
    reveal();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(list);
    return () => observer?.disconnect();
  }, [active, children]);
  return <div ref={box} aria-label={label} className="cc-completion rounded-xl border border-border bg-card shadow-xl">{children}</div>;
}
