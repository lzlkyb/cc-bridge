import { useEffect, useRef } from "react";
import type { SshConnection } from "../lib/types";

export type TerminalOpenRequest = { anchor: string; nonce: number };

export function useTerminalOpenRequest(request: TerminalOpenRequest | null | undefined,
  connections: SshConnection[], open: (connection: SshConnection) => void, edit: (connection: SshConnection | null) => void) {
  const handled = useRef<number>();
  useEffect(() => {
    if (!request || handled.current === request.nonce) return;
    if (request.anchor === "relay-ssh-new") {
      handled.current = request.nonce;
      edit(null);
      return;
    }
    const editPrefix = "relay-ssh-edit:";
    const openPrefix = "relay-ssh:";
    const editing = request.anchor.startsWith(editPrefix);
    if (!editing && !request.anchor.startsWith(openPrefix)) return;
    const id = request.anchor.slice((editing ? editPrefix : openPrefix).length);
    const connection = connections.find((item) => item.id === id);
    if (!connection) return;
    // The terminal workspace stays mounted when switching tabs, so consume each request once.
    handled.current = request.nonce;
    (editing ? edit : open)(connection);
  }, [request, connections, open, edit]);
}
