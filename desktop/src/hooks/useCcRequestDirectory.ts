import { useCallback, useMemo, useState } from "react";
import type { CcPaneEntry } from "./useCcPaneList";

export function useCcRequestDirectory(entries: CcPaneEntry[], setActive: (key: string) => void) {
  const [selection, setSelection] = useState<{ key: string; id: string; nonce: number } | null>(null);
  const sessions = useMemo(() => entries.flatMap(entry => entry.meta?.pendingRequests?.length
    ? [{ key: entry.key, title: entry.meta.title, requests: entry.meta.pendingRequests }] : []), [entries]);
  const select = useCallback((key: string, id: string) => {
    setSelection(previous => ({ key, id, nonce: (previous?.nonce ?? 0) + 1 }));
    setActive(key);
  }, [setActive]);
  return { sessions, selection, select };
}
