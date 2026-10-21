/** Build-time preview adapter only: never opens a PTY, writes files, or sends remote input. */
let sequence = 0;
export async function invoke<T>(command: string): Promise<T> {
  return (command === "ssh_connect" ? `preview-${++sequence}` : null) as T;
}
export const invokeOrToast = invoke;
export async function listen<T>(_event: string, _handler: (payload: T) => void): Promise<() => void> {
  return () => {};
}
