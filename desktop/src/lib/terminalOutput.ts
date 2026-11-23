import { invoke, listen } from "./tauri";
import { sshOutputEvent } from "./terminalEvents";
import type { SshOutput } from "./types";

interface Output extends SshOutput { streamId?: string; sequence?: number }

/** ACK 表示已解析而非已收包：隐藏窗口的定时器变慢时，后端必须等 xterm 消化完再续传。 */
export async function listenTerminalOutput(sessionId: string, write: (data: string, parsed: () => void) => void, isCancelled = () => false): Promise<() => void> {
  const streamId = crypto.randomUUID();
  let disposed = false;
  let lastSequence = 0;
  const off = await listen<Output>(sshOutputEvent(sessionId), p => {
    if (disposed || isCancelled() || p.sessionId !== sessionId || (p.streamId && p.streamId !== streamId)) return;
    if (p.sequence != null && p.sequence <= lastSequence) return;
    if (p.sequence != null) lastSequence = p.sequence;
    write(p.data, () => {
      if (disposed || isCancelled() || p.streamId !== streamId || p.sequence == null) return;
      void invoke("ssh_output_ack", { sessionId, streamId, sequence: p.sequence }).catch(() => {});
    });
  });
  if (isCancelled()) { disposed = true; off(); return () => {}; }
  // 先装监听再开额度，避免首个受控包在监听器挂好前丢失、后端永远等不到 ACK。
  try { await invoke("ssh_output_attach", { sessionId, streamId }); }
  catch (e) { disposed = true; off(); throw e; }
  return () => {
    if (disposed) return;
    disposed = true;
    off();
    void invoke("ssh_output_detach", { sessionId, streamId }).catch(() => {});
  };
}
