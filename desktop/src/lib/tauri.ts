import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(cmd, args);
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  return tauriListen<T>(event, (e) => handler(e.payload as T));
}
