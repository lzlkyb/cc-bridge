import { useEffect, useRef, useState } from "react";
import { invoke } from "../lib/tauri";
import type { StaticStatus } from "../lib/types";
import type { StableConnectState } from "./useStableConnect";
import { stableAccessIdentity, stableNeedsLogin, type StableFolders } from "../lib/stableAccess";

/** One directory per user action. Late replies cannot replace a newer folder or another server. */
export function useStableFolders(stable: StableConnectState, status: StaticStatus | undefined, path: string, enabled: boolean, signature?: string) {
  const key = JSON.stringify([stableAccessIdentity(stable.selectedId, stable.connections, status), path]);
  const [state, setState] = useState({ key: "", data: undefined as StableFolders | undefined, error: "", needsSecret: false, pending: false });
  const [revision, setRevision] = useState(0);
  const latest = useRef(stable);
  latest.current = stable;
  useEffect(() => {
    if (!enabled || !latest.current.connection) return;
    let disposed = false;
    const pinned = latest.current;
    const credentials = pinned.ui.credentialConnectionId === pinned.selectedId ? pinned.ui.credentials : {};
    setState({ key, data: undefined, error: "", needsSecret: false, pending: true });
    void invoke<StableFolders>("stable_connect_folders", { connectionId: pinned.selectedId, path: path || null, signature: signature ?? null,
      password: credentials.password ?? null, passphrase: credentials.passphrase ?? null })
      .then(data => { if (!disposed) setState({ key, data, error: "", needsSecret: false, pending: false }); })
      .catch(error => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        const needsSecret = stableNeedsLogin(message);
        if (needsSecret) pinned.update({ credentials: {} });
        setState({ key, data: undefined, error: message, needsSecret, pending: false });
      });
    return () => { disposed = true; };
  }, [key, path, enabled, signature, revision]);
  return { data: state.key === key ? state.data : undefined, error: state.key === key ? state.error : "",
    needsSecret: state.key === key && state.needsSecret, loading: enabled && (state.key !== key || state.pending), retry: () => setRevision(value => value + 1) };
}
