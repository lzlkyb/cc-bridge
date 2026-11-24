import { useEffect, useRef } from "react";
import type { SshConnection } from "../lib/types";

export type TerminalOpenRequest = { anchor: string; nonce: number };

export function useTerminalOpenRequest(request: TerminalOpenRequest | null | undefined,
  connections: SshConnection[], open: (connection: SshConnection) => void) {
  const handled = useRef<number>();
  useEffect(() => {
    const prefix = "relay-ssh:";
    if (!request?.anchor.startsWith(prefix) || handled.current === request.nonce) return;
    const id = request.anchor.slice(prefix.length);
    const connection = connections.find((item) => item.id === id);
    if (!connection) return;
    // The terminal workspace stays mounted when switching tabs, so consume each request once.
    handled.current = request.nonce;
    open(connection);
  }, [request, connections, open]);
}
