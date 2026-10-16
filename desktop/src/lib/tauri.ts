import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { toast } from "../components/ui/toast";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(cmd, args);
}

/**
 * 统一 invoke 包装（④P2-10）：fire-and-forget 风格，失败时自动弹 toast 错误并吞掉异常，
 * 调用点无需 try/catch。用于原 `.catch(console.error)` 静默失败的落盘/打开类调用。
 * 成功返回 T，失败返回 undefined（已 toast）。
 */
export async function invokeOrToast<T>(
  cmd: string,
  args?: Record<string, unknown>,
  errMsg?: string,
): Promise<T | undefined> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    toast(errMsg ?? `${cmd} 失败：${e}`, "error");
    return undefined;
  }
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  return tauriListen<T>(event, (e) => handler(e.payload as T));
}
