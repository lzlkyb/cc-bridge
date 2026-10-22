import { useEffect, useRef, type RefObject } from "react";
import type { SettingsSection } from "../lib/settingsSections";
import { stepSettingsSection } from "../lib/settingsNavigation";
import { useViewActive } from "../lib/viewActivity";

const NATIVE_CONTROLS = ".xterm,[data-native-scroll],input,textarea,select,[role=slider],[role=spinbutton],[role=listbox],[role=menu]";

function nestedScrollOwnsWheel(node: Element, panel: HTMLElement, delta: number): boolean {
  // Nested lists keep their own scrolling and explicit scroll-chain boundaries.
  for (let el: Element | null = node; el && el !== panel; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const style = getComputedStyle(el);
    if (!/^(auto|scroll)$/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
    const canScroll = delta > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 1;
    if (canScroll || ["contain", "none"].includes(style.overscrollBehaviorY)) return true;
  }
  return false;
}

/** Scroll the category first; only continued wheel input at its edge changes categories. */
export function useSettingsWheelNavigation(
  ref: RefObject<HTMLDivElement | null>, sections: SettingsSection[], current: string, onSelect: (id: string) => void,
) {
  const active = useViewActive();
  const gesture = useRef({ accumulated: 0, lastEvent: -Infinity, lastSwitch: -Infinity });
  useEffect(() => {
    const root = ref.current;
    if (!root || !active) return;
    const wheel = (event: WheelEvent) => {
      const state = gesture.current;
      const node = event.target;
      if (!(node instanceof Element) || event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.deltaX || Math.abs(event.deltaY) < 1 || node.closest(NATIVE_CONTROLS)) {
        state.accumulated = 0; return;
      }
      const panel = node.closest<HTMLElement>(".settings-category-panel");
      if (!panel || !root.contains(panel) || panel.closest("[hidden]") || panel.dataset.category !== current) return;
      const now = performance.now();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? panel.clientHeight || 800 : 1);
      if (now - state.lastEvent > 200 || Math.sign(delta) !== Math.sign(state.accumulated)) state.accumulated = 0;
      state.lastEvent = now;
      if (nestedScrollOwnsWheel(node, panel, delta)) { state.accumulated = 0; return; }
      const canScroll = delta > 0 ? panel.scrollTop + panel.clientHeight < panel.scrollHeight - 1 : panel.scrollTop > 1;
      if (canScroll) { state.accumulated = 0; return; }
      // Consume an edge gesture before the document's inertia listener can move another viewport.
      if (now - state.lastSwitch < 350) { event.preventDefault(); return; }
      state.accumulated += delta;
      if (Math.abs(state.accumulated) < 60) return;
      const next = stepSettingsSection(sections, current, state.accumulated > 0 ? 1 : -1);
      state.accumulated = 0;
      if (!next) return;
      event.preventDefault();
      state.lastSwitch = now;
      onSelect(next.id);
    };
    // A local non-passive listener can stop edge navigation without hijacking ordinary scrolling.
    root.addEventListener("wheel", wheel, { passive: false });
    return () => root.removeEventListener("wheel", wheel);
  }, [ref, sections, current, onSelect, active]);
}
