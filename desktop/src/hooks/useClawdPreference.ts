import { useEffect, useSyncExternalStore, type RefObject } from "react";

const key = "cc-bridge.clawd.reduce-motion";
const listeners = new Set<() => void>();
let fallback = false;
function read() { try { return localStorage.getItem(key) === "true"; } catch { return fallback; } }
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
}
export function useClawdPreference(rootRef: RefObject<HTMLDivElement>) {
  const reduced = useSyncExternalStore(subscribe, read);
  useEffect(() => { if (rootRef.current) rootRef.current.dataset.clawdReduced = String(reduced); }, [reduced, rootRef]);
  const toggle = () => {
    fallback = !read();
    try { localStorage.setItem(key, String(fallback)); } catch { /* The preference still applies in this window. */ }
    listeners.forEach(listener => listener());
  };
  return { reduced, toggle };
}
