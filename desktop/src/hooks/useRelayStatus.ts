import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import { useAppHidden } from "../lib/appVisibility";
import { useViewActive } from "../lib/viewActivity";
import { dayKey, mergeRelayHistory, shiftDay } from "../lib/relayUsage";
import type { RelayLogEntry, RelaySnapshot } from "../lib/types";

const EMPTY: RelayLogEntry[] = [];

export function useRelayStatus() {
  const active = useViewActive();
  const hidden = useAppHidden();
  const visible = active && !hidden;
  const status = useQuery<RelaySnapshot, Error>({
    queryKey: ["relay"],
    queryFn: () => invoke<RelaySnapshot>("relay_status"),
    enabled: visible,
    refetchInterval: visible ? 2000 : false,
    gcTime: 30_000,
  });
  const today = dayKey(new Date());
  const history = useQuery<RelayLogEntry[], Error>({
    queryKey: ["relay-history", today],
    queryFn: () => invoke<RelayLogEntry[]>("relay_history"),
    enabled: visible,
    // Recent requests update from the small status poll. Reconcile older rows less often.
    // A long-lived request can finish outside the most recent 50 rows, even after Stop.
    refetchInterval: visible ? 60_000 : false,
    staleTime: 30_000,
    gcTime: 300_000,
  });
  const recent = status.data?.recent ?? EMPTY;
  const rows = useMemo(() => {
    const first = shiftDay(today, -6);
    return mergeRelayHistory(history.data ?? EMPTY, recent).filter((row) => dayKey(row.tsMs) >= first);
  }, [history.data, recent, today]);
  return { status, history, rows, today };
}
