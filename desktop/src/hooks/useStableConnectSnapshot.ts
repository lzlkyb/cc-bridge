import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, listen } from "../lib/tauri";
import type { StableConnectSnapshot } from "../lib/stableConnect";
import type { StaticStatus } from "../lib/types";
import { toast } from "../components/ui/toast";

export const stableConnectKey = ["stable-connect"];

/** Event driven across pages; no background polling or credentials in the query cache. */
export function useStableConnectSnapshot(status?: StaticStatus) {
  const client = useQueryClient();
  const previousConfig = useRef("");
  const query = useQuery({ queryKey: stableConnectKey, queryFn: async ({ signal }) => {
    const snapshot = await invoke<StableConnectSnapshot>("stable_connect_get");
    signal.throwIfAborted();
    return snapshot;
  } });
  const configKey = JSON.stringify([status?.token, status?.host, status?.port, status?.transport, status?.remoteTlsEnabled, status?.deviceId]);
  useEffect(() => {
    if (previousConfig.current && previousConfig.current !== configKey) void client.invalidateQueries({ queryKey: stableConnectKey });
    previousConfig.current = configKey;
  }, [client, configKey]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("stable_connect_changed", () => {
      void client.invalidateQueries({ queryKey: stableConnectKey });
      void client.invalidateQueries({ queryKey: ["status"] });
    })
      .then(stop => { if (disposed) stop(); else { unlisten = stop; void client.invalidateQueries({ queryKey: stableConnectKey }); } })
      .catch(error => { if (!disposed) toast(`无法订阅隧道连接状态，请重新打开连接页：${error}`, "error"); });
    return () => { disposed = true; unlisten?.(); };
  }, [client]);
  useEffect(() => client.getQueryCache().subscribe(event => {
    // TLS and saved SSH edits have their own caches, not necessarily a tunnel event.
    if (event.type === "updated" && event.action.type === "success" && ["tls-status", "sshConnections"].includes(String(event.query.queryKey[0]))) {
      void client.invalidateQueries({ queryKey: stableConnectKey });
      void client.invalidateQueries({ queryKey: ["status"] });
    }
  }), [client]);
  return query;
}
