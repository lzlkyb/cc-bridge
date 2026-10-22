import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/tauri";
import { cleanErr } from "../lib/utils";
import type { SshFileEntry } from "../lib/types";

interface Listing {
  connectionId: string; path: string; entries: SshFileEntry[];
  loading: boolean; error: string | null;
}

/** A directory and its rows are one snapshot; late responses never cross navigation boundaries. */
export function useSshFileListing(connectionId: string, path: string) {
  const [snapshot, setSnapshot] = useState<Listing>({ connectionId, path, entries: [], loading: true, error: null });
  const request = useRef({ id: 0 });
  const active = useRef(true);
  const latest = useRef({ connectionId, path });
  latest.current = { connectionId, path };
  const refresh = useCallback(async () => {
    // An upload may finish after navigation. Its old refresh callback must not claim the new view.
    if (!active.current || latest.current.connectionId !== connectionId || latest.current.path !== path) return;
    const id = ++request.current.id;
    const current = () => request.current.id === id && latest.current.connectionId === connectionId && latest.current.path === path;
    setSnapshot(old => ({ connectionId, path, entries: old.connectionId === connectionId && old.path === path ? old.entries : [], loading: true, error: null }));
    try {
      const entries = await invoke<SshFileEntry[]>("ssh_sftp_list", { connectionId, path });
      if (!current()) return;
      const sorted = [...entries].sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
      setSnapshot({ connectionId, path, entries: sorted, loading: false, error: null });
    } catch (error) {
      if (current()) setSnapshot({ connectionId, path, entries: [], loading: false, error: `列目录失败：${cleanErr(error)}` });
    }
  }, [connectionId, path]);
  useEffect(() => {
    active.current = true;
    const requests = request.current;
    void refresh();
    return () => { active.current = false; requests.id++; };
  }, [refresh]);
  const matches = snapshot.connectionId === connectionId && snapshot.path === path;
  // Mask the old snapshot during render, before the navigation effect starts its request.
  return { entries: matches ? snapshot.entries : [], loading: !matches || snapshot.loading, error: matches ? snapshot.error : null, refresh };
}
