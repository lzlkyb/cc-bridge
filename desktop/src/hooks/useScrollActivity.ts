import { useCallback, useEffect, useRef, type UIEvent } from "react";

/** Track scrollbars and the page edge without React renders or layout changes. */
export function useScrollActivity() {
  const timers = useRef(new Map<HTMLElement, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const [element, timer] of pending) {
        clearTimeout(timer);
        delete element.dataset.scrolling;
      }
      pending.clear();
    };
  }, []);
  return useCallback((event: UIEvent<HTMLElement>) => {
    const element = event.target;
    if (!(element instanceof HTMLElement) || !element.classList.contains("page-scroll")) return;
    // Persistent offset belongs to the viewport, so returning to a category restores its edge too.
    element.toggleAttribute("data-scroll-started", element.scrollTop > 8);
    clearTimeout(timers.current.get(element));
    element.dataset.scrolling = "";
    timers.current.set(element, setTimeout(() => {
      delete element.dataset.scrolling;
      timers.current.delete(element);
    }, 700));
  }, []);
}
