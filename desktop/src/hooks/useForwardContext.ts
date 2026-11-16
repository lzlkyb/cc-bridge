import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, listen } from "../lib/tauri";
import type { ForwardContext } from "../lib/forwardOwnership";

export const forwardContextKey = ["ssh-forward-context"];

export function useForwardContext(connectionId: string) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: [...forwardContextKey, connectionId], queryFn: async ({ signal }) => {
    const context = await invoke<ForwardContext>("ssh_forward_context", { connectionId });
    signal.throwIfAborted();
    return context;
  } });
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const refresh = () => { if (!disposed) void client.invalidateQueries({ queryKey: forwardContextKey }); };
    for (const event of ["stable_connect_changed", "ssh_tunnel_status", "mcp-status-changed"]) {
      void listen(event, refresh).then(stop => {
        if (disposed) stop(); else { stops.push(stop); refresh(); }
      }).catch(() => {});
    }
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "success" && event.query.queryKey[0] === "sshConnections") refresh();
    });
    return () => { disposed = true; unsubscribe(); for (const stop of stops) stop(); };
  }, [client]);
  return query;
}
