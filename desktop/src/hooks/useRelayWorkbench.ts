import { useEffect, useState } from "react";

export const RELAY_WORKBENCH_KEY = "ccbridge.relay.workbench";
export const EMPTY_RELAY_FILTERS = { model: "", provider: "", dimension: "" };
export type RelayWorkbenchView = "route" | "usage";
export type RelayUsageRange = { mode: "week" | "today" | "custom"; from: string; to: string };
export type RelayUsageScope = { range: RelayUsageRange; filters: typeof EMPTY_RELAY_FILTERS; bucket: string | null; page: number };
export type RelayRequestScope = { errors: boolean; full: boolean; page: number };

function initialWorkbench() {
  const fallback = { view: "route" as RelayWorkbenchView,
    usage: { range: { mode: "week", from: "", to: "" }, filters: EMPTY_RELAY_FILTERS, bucket: null, page: 0 } as RelayUsageScope,
    requests: { errors: false, full: false, page: 0 } };
  try {
    const stored = JSON.parse(sessionStorage.getItem(RELAY_WORKBENCH_KEY) ?? "null") as typeof fallback | null;
    if (stored?.usage?.range && stored?.usage?.filters && stored?.requests) return stored;
  } catch { /* Storage can be unavailable in a restricted webview. */ }
  return fallback;
}

export function useRelayWorkbench() {
  const [state, setState] = useState(initialWorkbench);
  useEffect(() => {
    try { sessionStorage.setItem(RELAY_WORKBENCH_KEY, JSON.stringify(state)); } catch { /* Optional session state. */ }
  }, [state]);
  return {
    ...state,
    setView: (view: RelayWorkbenchView) => setState((current) => ({ ...current, view })),
    setUsage: (patch: Partial<RelayUsageScope>) => setState((current) => ({ ...current, usage: { ...current.usage, page: 0, ...patch } })),
    setRequests: (patch: Partial<RelayRequestScope>) => setState((current) => ({ ...current, requests: { ...current.requests, page: 0, ...patch } })),
  };
}
