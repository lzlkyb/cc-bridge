import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { toast } from "../components/ui/toast";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(cmd, args);
}

/**
 * 统一 invoke 包装（④P2-10）：失败归一化并可选重试，不直接展示 UI。
 * - retries：失败重试次数（指数退避），用于限流 429 等可重试场景。
 * - onError：传入则在最终失败时回调（如上报），但仍会 rethrow 归一化 Error。
 * 仅做错误归一化/重试，UI 反馈交给调用方或 invokeOrToast。
 */
export async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
  opts?: { retries?: number; onError?: (message: string) => void },
): Promise<T> {
  const retries = opts?.retries ?? 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await tauriInvoke<T>(cmd, args);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  const message = errToMessage(lastErr);
  opts?.onError?.(message);
  throw new Error(message);
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

function errToMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  return tauriListen<T>(event, (e) => handler(e.payload as T));
}
