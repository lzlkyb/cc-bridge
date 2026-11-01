import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export function findClawdMessage(scroll: HTMLElement | null, id?: string): HTMLElement | undefined {
  return id ? [...(scroll?.querySelectorAll<HTMLElement>("[data-cc-message], [data-cc-tool]") ?? [])].find(el => el.dataset.ccMessage === id || el.dataset.ccTool === id) : undefined;
}

/** The character has one DOM identity. Landing slots, never message text, reserve its space. */
export function useClawdMotion({ rootRef, scrollRef, homeRef, petRef, targetId, reduced }: {
  rootRef: RefObject<HTMLDivElement>; scrollRef: RefObject<HTMLDivElement>;
  homeRef: RefObject<HTMLDivElement>; petRef: RefObject<HTMLButtonElement>;
  targetId?: string; reduced: boolean;
}) {
  const previous = useRef("");
  const [ready, setReady] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current, scroll = scrollRef.current, pet = petRef.current, home = homeRef.current;
    if (!root || !scroll || !pet || !home) {
      // The parent ref may be attached after this child's layout effect.
      const retry = requestAnimationFrame(() => setReady(value => value + 1));
      return () => cancelAnimationFrame(retry);
    }
    let frame = 0, travel = 0, scrolling = false;
    const target = findClawdMessage(scroll, targetId);
    const position = () => {
      const base = root.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
      root.style.setProperty("--clawd-dock-height", `${home.closest(".cc-clawd-dock")?.getBoundingClientRect().height ?? 64}px`);
      root.style.setProperty("--clawd-detail-height", `${Math.max(80, viewport.height - 16)}px`);
      const box = target?.getBoundingClientRect();
      const inset = pet.dataset.landing === "task" ? 2 : 18;
      const visible = box && target?.querySelector("[data-cc-tool]") && viewport.width >= 600 && box.top >= viewport.top + inset && box.top + pet.offsetHeight + 4 <= viewport.bottom - inset;
      const landing = visible ? box : home.getBoundingClientRect();
      if (!landing.width || !base.width) return;
      const x = Math.max(0, Math.min(landing.left - base.left, base.width - pet.offsetWidth));
      const y = landing.top - base.top + (visible ? 4 : 0);
      const next = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
      if (next !== previous.current) {
        const initial = !previous.current;
        if (initial) pet.style.transition = "none";
        const systemReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        pet.dataset.travel = String(!!previous.current && !reduced && !systemReduced && !document.hidden && !scrolling);
        if (scrolling) pet.style.transition = "none";
        window.clearTimeout(travel);
        travel = window.setTimeout(() => { pet.dataset.travel = "false"; }, 310);
        pet.style.transform = next;
        if (scrolling) { pet.getBoundingClientRect(); pet.style.transition = ""; }
        if (initial) {
          // Commit the first landing before enabling travel; never fly in from (0,0).
          pet.getBoundingClientRect(); pet.style.transition = "";
        }
        previous.current = next;
      }
      pet.dataset.landing = visible ? "task" : "home";
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { position(); scrolling = false; }); };
    const onScroll = () => { scrolling = true; schedule(); };
    const visibility = () => { root.dataset.clawdPaused = String(document.hidden || !root.getClientRects().length); if (!document.hidden) schedule(); };
    const pointer = (event: PointerEvent) => {
      if (event.pointerType === "touch" || reduced || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || document.hidden) return;
      const box = pet.getBoundingClientRect();
      pet.style.setProperty("--clawd-look-x", `${Math.max(-2, Math.min(2, (event.clientX - box.left - box.width / 2) / 100))}px`);
      pet.style.setProperty("--clawd-look-y", `${Math.max(-1.5, Math.min(1.5, (event.clientY - box.top - box.height / 2) / 150))}px`);
    };
    const leave = () => { pet.style.setProperty("--clawd-look-x", "0px"); pet.style.setProperty("--clawd-look-y", "0px"); };
    const focus = (event: Event) => { if ((event.target as HTMLElement)?.tagName === "TEXTAREA") root.dataset.clawdTyping = "true"; };
    const blur = (event: Event) => { if ((event.target as HTMLElement)?.tagName === "TEXTAREA") root.dataset.clawdTyping = "false"; };
    const selection = () => {
      const selected = document.getSelection();
      root.dataset.clawdReading = String(!!selected?.toString() && !!selected.anchorNode && scroll.contains(selected.anchorNode));
    };
    document.addEventListener("selectionchange", selection);
    const panel = root.closest("[data-cc-panel]");
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(root); resize?.observe(home); if (target) resize?.observe(target);
    const intersection = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      root.dataset.clawdPaused = String(!entry.isIntersecting || document.hidden);
      if (entry.isIntersecting) schedule();
    });
    intersection?.observe(root);
    scroll.addEventListener("scroll", onScroll, { passive: true });
    panel?.addEventListener("pointermove", pointer as EventListener, { passive: true });
    panel?.addEventListener("focusin", focus); panel?.addEventListener("focusout", blur);
    root.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("resize", schedule);
    visibility(); position();
    return () => {
      cancelAnimationFrame(frame); window.clearTimeout(travel); pet.dataset.travel = "false";
      resize?.disconnect(); intersection?.disconnect();
      scroll.removeEventListener("scroll", onScroll); window.removeEventListener("resize", schedule);
      panel?.removeEventListener("pointermove", pointer as EventListener);
      panel?.removeEventListener("focusin", focus); panel?.removeEventListener("focusout", blur);
      document.removeEventListener("selectionchange", selection);
      root.removeEventListener("pointerleave", leave); document.removeEventListener("visibilitychange", visibility);
    };
  }, [rootRef, scrollRef, homeRef, petRef, targetId, reduced, ready]);
}
