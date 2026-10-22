import { useLayoutEffect, useRef, type RefObject } from "react";
import { settingsMotionAllowed } from "./useSettingsCategoryMotion";

/** A single selection plate follows categories without moving their hit targets. */
export function useSettingsMenuMotion(ref: RefObject<HTMLElement | null>, activeId: string, query: string, collapsed: boolean) {
  const plate = useRef<HTMLDivElement>(null);
  const motion = useRef<Animation | null>(null);
  const previous = useRef("");
  useLayoutEffect(() => {
    const nav = ref.current, indicator = plate.current;
    if (!nav || !indicator) return;
    const measure = (animate = false) => {
      const selected = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!animate && selected) {
        const box = selected.getBoundingClientRect(), parent = nav.getBoundingClientRect();
        if (indicator.style.top === `${box.top - parent.top + nav.scrollTop}px` && indicator.style.width === `${box.width}px` && indicator.style.height === `${box.height}px`) return;
      }
      const old = indicator.hidden ? null : indicator.getBoundingClientRect();
      motion.current?.cancel(); motion.current = null;
      indicator.hidden = !selected;
      nav.toggleAttribute("data-selection-plate", !!selected);
      if (!selected) { previous.current = ""; return; }
      selected.scrollIntoView({ block: "nearest" });
      const box = selected.getBoundingClientRect(), parent = nav.getBoundingClientRect();
      Object.assign(indicator.style, { top: `${box.top - parent.top + nav.scrollTop}px`, left: `${box.left - parent.left + nav.scrollLeft}px`, width: `${box.width}px`, height: `${box.height}px` });
      if (animate && old && box.height > 0 && previous.current && previous.current !== activeId && indicator.animate && settingsMotionAllowed()) {
        motion.current = indicator.animate([
          { transform: `translateY(${old.top - box.top}px) scaleY(${old.height / box.height})` },
          { transform: "none" },
        ], { duration: 180, easing: "cubic-bezier(.16,1,.3,1)" });
      }
      previous.current = activeId;
    };
    measure(true);
    // Responsive/sidebar changes resize the plate without replaying category navigation.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    resize?.observe(nav);
    return () => resize?.disconnect();
  }, [ref, activeId, query, collapsed]);
  useLayoutEffect(() => () => { motion.current?.cancel(); }, []);
  return plate;
}
