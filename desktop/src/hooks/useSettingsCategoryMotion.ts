import { useLayoutEffect, useRef, type RefObject } from "react";
import type { SettingsSection } from "../lib/settingsSections";

export function settingsMotionAllowed() {
  return !document.hidden && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Animate the retained content, never the scroll viewport or its form lifecycle. */
export function useSettingsCategoryMotion(ref: RefObject<HTMLDivElement | null>, sections: SettingsSection[], current: string, active: boolean, deepLink: boolean) {
  const previous = useRef(current);
  const motion = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = current;
    motion.current?.cancel();
    motion.current = null;
    if (!active || old === current || !settingsMotionAllowed()) return;
    const panel = ref.current?.querySelector<HTMLElement>('.settings-category-panel:not([hidden]) .settings-category-content');
    if (!panel?.animate) return;
    const direction = sections.findIndex(item => item.id === current) >= sections.findIndex(item => item.id === old) ? 1 : -1;
    motion.current = panel.animate([
      { opacity: .58, transform: deepLink ? "none" : `translateY(${direction * 6}px)` },
      { opacity: 1, transform: "none" },
    ], { duration: deepLink ? 140 : 200, easing: "cubic-bezier(.16,1,.3,1)" });
  }, [ref, sections, current, active, deepLink]);
  useLayoutEffect(() => () => { motion.current?.cancel(); }, []);
}
