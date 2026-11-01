import { invoke } from "./tauri";

type InputInterceptor = (data: string) => boolean;
const interceptors = new Map<string, InputInterceptor>();

/** Observe/buffer user input before IPC; xterm onData observers cannot cancel a send. */
export function interceptTerminalUserInput(sessionId: string, intercept: InputInterceptor): () => void {
  interceptors.set(sessionId, intercept);
  return () => {
    if (interceptors.get(sessionId) === intercept) interceptors.delete(sessionId);
  };
}

/** Keyboard, paste and explicit input actions share this route; protocol replies bypass it. */
export async function sendTerminalUserInput(sessionId: string, data: string): Promise<void> {
  if (interceptors.get(sessionId)?.(data)) return;
  await invoke("ssh_input", { sessionId, data });
}
