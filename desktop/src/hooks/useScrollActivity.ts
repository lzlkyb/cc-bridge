import { useCallback, useEffect, useRef, type UIEvent } from "react";

/** Only tint native page scrollbars; scrolling never triggers React renders or layout changes. */
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
    clearTimeout(timers.current.get(element));
    element.dataset.scrolling = "";
    timers.current.set(element, setTimeout(() => {
      delete element.dataset.scrolling;
      timers.current.delete(element);
    }, 700));
  }, []);
}
