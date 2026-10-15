import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useViewActive } from "../lib/viewActivity";

/** 点击定位不被途中经过的分类抢走高亮；用户开始滚轮/拖动/翻页键时恢复跟随。 */
export function useSettingsScrollSpy(ref: RefObject<HTMLDivElement | null>, onActive: (id: string) => void) {
  const active = useViewActive();
  const programmatic = useRef(false);
  const markNavigation = useCallback(() => { programmatic.current = true; }, []);
  useEffect(() => {
    const container = ref.current;
    if (!container || !active) return;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (programmatic.current) return;
        const sections = [...container.querySelectorAll<HTMLElement>("[data-settings-section]")];
        const line = container.getBoundingClientRect().top + 88;
        let current = sections[0];
        for (const section of sections) if (section.getBoundingClientRect().top <= line) current = section;
        if (container.scrollHeight > container.clientHeight && container.scrollTop + container.clientHeight >= container.scrollHeight - 3) current = sections[sections.length - 1];
        if (current?.dataset.settingsSection) onActive(current.dataset.settingsSection);
      });
    };
    const resume = () => { programmatic.current = false; update(); };
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches("input,textarea,select")) return;
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) resume();
    };
    container.addEventListener("scroll", update, { passive: true });
    container.addEventListener("wheel", resume, { passive: true });
    container.addEventListener("touchstart", resume, { passive: true });
    container.addEventListener("pointerdown", resume);
    container.addEventListener("keydown", onKey);
    const resize = new ResizeObserver(update);
    resize.observe(container);
    update();
    return () => {
      cancelAnimationFrame(frame); resize.disconnect();
      container.removeEventListener("scroll", update); container.removeEventListener("wheel", resume);
      container.removeEventListener("touchstart", resume); container.removeEventListener("pointerdown", resume);
      container.removeEventListener("keydown", onKey);
    };
  }, [ref, onActive, active]);
  return markNavigation;
}
