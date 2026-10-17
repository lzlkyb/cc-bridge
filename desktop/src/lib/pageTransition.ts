import { flushSync } from "react-dom";

let current: ViewTransition | undefined;
let revision = 0;

/** Animate captured pixels, so terminal canvases and fixed overlays never move. */
export function transitionPage(update: () => void, animate = true): void {
  const request = ++revision;
  current?.skipTransition();
  if (!animate || !document.startViewTransition || document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  // Persist this mode: removing it after exit would replay the CSS fallback.
  document.documentElement.dataset.pageTransitions = "true";
  const transition = document.startViewTransition(() => {
    // skipTransition still runs its update callback; an old click must not win.
    if (request === revision) flushSync(update);
  });
  current = transition;
  // Rapid navigation intentionally rejects ready when skipping the old capture.
  void transition.ready.catch(() => {});
  void transition.finished.finally(() => {
    if (current === transition) current = undefined;
  }).catch(() => {});
}
