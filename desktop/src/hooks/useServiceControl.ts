import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "../lib/tauri";
import type { StaticStatus } from "../lib/types";
import { toast } from "../components/ui/toast";

type Action = "start" | "stop" | "restart";
let snapshot: { pending: Action | null; error: string | null } = { pending: null, error: null };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;
const publish = (next: typeof snapshot) => { snapshot = next; listeners.forEach(listener => listener()); };

/** All visible controls share the same pending action; the backend serializes native tray actions too. */
export async function runServiceAction(action: Action, onChanged?: () => void): Promise<boolean> {
  if (snapshot.pending) return false;
  publish({ pending: action, error: null });
  try {
    await invoke(action === "restart" ? "restart_mcp_server" : action === "stop" ? "stop_mcp_server" : "start_mcp_server");
    publish({ pending: null, error: null });
    onChanged?.();
    return true;
  } catch (error) {
    publish({ pending: null, error: String(error) });
    toast(`本机服务${action === "start" ? "启动" : action === "stop" ? "停止" : "重启"}失败：${error}`, "error");
    onChanged?.();
    return false;
  }
}

export function useServiceControl(status?: StaticStatus, onChanged?: () => void) {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const saved = status?.serviceControl;
  useEffect(() => {
    if (saved && !snapshot.pending && snapshot.error !== saved.error) publish({ pending: null, error: saved.error });
  }, [saved]);
  const pending = state.pending ?? status?.serviceControl?.pending ?? null;
  return { pending, busy: pending !== null, error: state.error ?? status?.serviceControl?.error ?? null,
    run: (action: Action) => pending ? Promise.resolve(false) : runServiceAction(action, onChanged) };
}
