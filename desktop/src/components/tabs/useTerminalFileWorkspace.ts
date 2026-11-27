import { createContext, useContext, useEffect, useState } from "react";
import type { SshConnection } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";

type Layout = "remote" | "terminal" | "local";
type Location = { connectionId: string; path: string; ready: boolean; refresh: () => void };

export function useTerminalFileWorkspace(conn: SshConnection | null, cwd: string | null, sessions: SshSessionRef[], activeId: string | null, activate: (id: string) => void) {
  const [layout, setLayout] = useState<{ connectionId: string; mode: Layout; follow: boolean } | null>(null);
  const [localLocation, setLocalLocation] = useState<{ connectionId: string; path: string } | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const current = layout?.connectionId === conn?.id ? layout : null;
  const mode = current?.mode ?? "remote";
  return {
    mode, localPath: localLocation?.connectionId === conn?.id ? localLocation?.path : undefined, setLocalLocation,
    location: location?.connectionId === conn?.id ? location : null, setLocation,
    followPath: mode === "terminal" && current?.follow ? cwd : null,
    following: !!current?.follow,
    reset: () => { setLayout(null); setLocalLocation(null); },
    toggleFollow: () => { if (current) setLayout({ ...current, follow: !current.follow }); },
    toggleTerminal: () => {
      if (!conn) return;
      if (mode !== "terminal") {
        const candidates = sessions.filter(session => session.conn.id === conn.id && !session.closedReason && !session.splitOnly);
        const session = candidates.find(item => item.sessionId === activeId) ?? candidates[0];
        if (!session) return;
        activate(session.sessionId);
      }
      setLayout({ connectionId: conn.id, mode: mode === "terminal" ? "remote" : "terminal", follow: !!current?.follow });
    },
    toggleLocal: () => {
      if (conn) setLayout({ connectionId: conn.id, mode: mode === "local" ? "remote" : "local", follow: !!current?.follow });
    },
  };
}

export const TerminalFileWorkspace = createContext<ReturnType<typeof useTerminalFileWorkspace> | null>(null);

export function useFileWorkspaceLocation(connectionId: string, path: string, navigate: (path: string) => void, refresh: () => void, ready: boolean) {
  const workspace = useContext(TerminalFileWorkspace);
  const setLocation = workspace?.setLocation;
  const followPath = workspace?.followPath;
  useEffect(() => { if (followPath) navigate(followPath); }, [followPath, navigate]);
  useEffect(() => { setLocation?.({ connectionId, path, refresh, ready }); }, [setLocation, connectionId, path, refresh, ready]);
}
