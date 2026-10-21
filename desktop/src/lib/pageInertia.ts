const DURATION = 160;
const NATIVE_CONTROLS = ".terminal-workspace,.xterm,[data-native-scroll],input,textarea,select,[role=slider],[role=spinbutton],[role=listbox],[role=menu]";
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

/** Short wheel easing for ordinary content; native drag, precise input and terminal ownership win. */
export function attachPageInertia(doc: Document): () => void {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0, started = 0, from = 0, target = 0, last = 0, nativeUntil = 0;
  let owner: HTMLElement | null = null;
  const stop = () => { cancelAnimationFrame(frame); frame = 0; owner = null; };
  const hidden = () => doc.hidden || doc.documentElement.hasAttribute("data-app-hidden");

  const tick = (now: number) => {
    const el = owner;
    if (!el || !el.isConnected || el.closest("[hidden]") || hidden() || motion.matches || Math.abs(el.scrollTop - last) > 1) {
      stop(); return;
    }
    const end = Math.max(0, el.scrollHeight - el.clientHeight);
    target = clamp(target, end);
    const progress = Math.min(1, Math.max(0, (now - started) / DURATION));
    el.scrollTop = clamp(from + (target - from) * (1 - (1 - progress) ** 3), end);
    last = el.scrollTop;
    if (progress >= 1) stop();
    else frame = requestAnimationFrame(tick);
  };
  const findOwner = (node: Element, direction: number): HTMLElement | null => {
    for (let el: Element | null = node; el && el !== doc.body; el = el.parentElement) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (!/^(auto|scroll)$/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
      if (direction > 0 ? el.scrollTop < el.scrollHeight - el.clientHeight - .5 : el.scrollTop > .5) return el;
      // Respect nested panels that explicitly stop scroll chaining at their edge.
      if (style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return null;
    }
    return null;
  };
  const wheel = (event: WheelEvent) => {
    const mode = event.deltaMode;
    const node = event.target;
    if (!(node instanceof Element) || event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.deltaX || !event.deltaY || node.closest(NATIVE_CONTROLS) || motion.matches || hidden()) {
      stop(); return;
    }
    const now = performance.now();
    // WheelEvent has no reliable device identity. Small/fractional pixel packets mark
    // a precision stream; let that whole gesture keep its platform-provided momentum.
    if (mode === 0 && (Math.abs(event.deltaY) < 80 || !Number.isInteger(event.deltaY))) nativeUntil = now + 350;
    if (now < nativeUntil) { nativeUntil = now + 350; stop(); return; }
    const el = findOwner(node, Math.sign(event.deltaY));
    if (!el) { stop(); return; }
    const delta = event.deltaY * (mode === 1 ? (Number.parseFloat(getComputedStyle(el).lineHeight) || 16) : mode === 2 ? el.clientHeight : 1);
    const continuing = owner === el && Math.abs(el.scrollTop - last) <= 1;
    const sameDirection = continuing && Math.sign(target - el.scrollTop) === Math.sign(delta);
    const next = clamp((sameDirection ? target : el.scrollTop) + delta, el.scrollHeight - el.clientHeight);
    if (Math.abs(next - el.scrollTop) < .5) { stop(); return; }
    event.preventDefault();
    from = el.scrollTop; last = from; target = next; owner = el; started = now;
    cancelAnimationFrame(frame); frame = requestAnimationFrame(tick);
  };

  doc.addEventListener("wheel", wheel, { passive: false });
  doc.addEventListener("pointerdown", stop, true);
  doc.addEventListener("touchstart", stop, { passive: true, capture: true });
  doc.addEventListener("keydown", stop, true);
  doc.addEventListener("visibilitychange", stop);
  motion.addEventListener("change", stop);
  return () => {
    stop(); doc.removeEventListener("wheel", wheel);
    doc.removeEventListener("pointerdown", stop, true);
    doc.removeEventListener("touchstart", stop, true);
    doc.removeEventListener("keydown", stop, true);
    doc.removeEventListener("visibilitychange", stop);
    motion.removeEventListener("change", stop);
  };
}
