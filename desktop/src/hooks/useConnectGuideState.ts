import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, invokeOrToast } from "../lib/tauri";
import type { StaticStatus, TlsStatus } from "../lib/types";
import {
  type McpScope, buildDisplayHost, buildBaseCommand, buildConnectCommand,
  buildHealthCheck, buildPermissionGrantCommand, buildMultiDeviceCommand, quoteRemotePath,
} from "../lib/utils";
import { useCopyFeedback } from "./useCopyFeedback";
import { useConnectionCopy } from "./useConnectionCopy";
import { toast } from "../components/ui/toast";

/** Preserve the direct form; copies use the same saved target as all other entry points. */
export function useConnectGuideState(status: StaticStatus | undefined, selectedIp: string, defaultScope: McpScope = "project", active = true) {
  const [{ scope, projectPath }, setLocation] = useState({ scope: defaultScope, projectPath: "" });
  const setScope = (scope: McpScope) => setLocation(previous => ({ ...previous, scope }));
  const setProjectPath = (projectPath: string) => setLocation(previous => ({ ...previous, projectPath }));
  const [includeShellTools, setIncludeShellTools] = useState(false);
  const client = useQueryClient();
  const multiDevice = !!status?.multiDeviceMode && (status.connectClient ?? "claude-code") === "claude-code";
  const effectiveScope = multiDevice ? "user" : scope;
  const { data: tls } = useQuery({ queryKey: ["tls-status"], queryFn: () => invoke<TlsStatus>("get_tls_status") });
  const tlsEnabled = status?.remoteTlsEnabled ?? !!tls?.enabled;
  const displayHost = useMemo(() => buildDisplayHost(status, selectedIp), [status, selectedIp]);
  const port = status?.port ?? 7823;
  const token = status?.token ?? "";
  const identity = JSON.stringify([active, status?.connectClient, displayHost, port, token, status?.transport, tlsEnabled, effectiveScope, projectPath.trim(), multiDevice, status?.deviceId]);
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const feedback = useCopyFeedback(2000, identity);
  const connectionCopy = useConnectionCopy(status, identity);

  // Saved changes refill the form, while repeated status samples cannot overwrite a newer draft.
  const savedScope = status ? (status.scope as McpScope | null) ?? defaultScope : null;
  const savedPath = status?.projectPath ?? "";
  useEffect(() => {
    if (savedScope != null) setLocation({ scope: savedScope, projectPath: savedPath });
  }, [savedScope, savedPath]);
  useEffect(() => {
    if (!active || savedScope == null || (effectiveScope === savedScope && projectPath === savedPath)) return;
    const timer = setTimeout(() => {
      void invokeOrToast("save_config", { patch: { scope: effectiveScope, projectPath: projectPath || null } })
        .then(() => { void client.invalidateQueries({ queryKey: ["status"] }); });
    }, 300);
    return () => clearTimeout(timer);
  }, [active, effectiveScope, projectPath, savedScope, savedPath, client]);

  const baseCommand = useMemo(() => buildBaseCommand(displayHost, port, token, status?.transport, tlsEnabled),
    [displayHost, port, token, status?.transport, tlsEnabled]);
  const connectCommand = useMemo(() => multiDevice
    ? buildMultiDeviceCommand(displayHost, port, token, status?.transport, tlsEnabled, status?.deviceId)
    : buildConnectCommand(baseCommand, effectiveScope),
    [baseCommand, effectiveScope, multiDevice, status?.deviceId, displayHost, port, token, status?.transport, tlsEnabled]);
  const healthCheck = useMemo(() => buildHealthCheck(displayHost, port, tlsEnabled), [displayHost, port, tlsEnabled]);
  const permissionCommand = useMemo(() => buildPermissionGrantCommand(effectiveScope, projectPath, includeShellTools),
    [effectiveScope, projectPath, includeShellTools]);

  const copyConnect: (command?: string) => void = async (command?: string) => {
    const key = identity;
    const path = projectPath.trim();
    const expected = command ?? (effectiveScope === "project" && path ? `cd ${quoteRemotePath(path)} && ${connectCommand}` : connectCommand);
    if (!expected || !active) return;
    try {
      // A just-edited form must be saved before tray/page copies resolve the target.
      await invoke("save_config", { patch: { scope: effectiveScope, projectPath: projectPath || null } });
      if (key !== latestIdentity.current) return;
      await connectionCopy.copy("command", undefined, expected);
      void client.invalidateQueries({ queryKey: ["status"] });
    } catch (error) { toast(`保存接入配置失败：${error}`, "error"); }
  };
  const copyPerm = () => { if (permissionCommand) feedback.copy("perm", permissionCommand); };

  return {
    scope: effectiveScope, multiDevice, setScope, projectPath, setProjectPath,
    includeShellTools, setIncludeShellTools,
    // Without client attribution a local/global request cannot prove this particular access.
    firstCallSeen: false, tlsEnabled, displayHost, port, token, connectCommand,
    healthCheck, permissionCommand, copyConnect, copyPerm,
    isCopied: (key: string) => key === "connect" ? connectionCopy.isCopied("command") : feedback.isCopied(key),
  };
}

export type ConnectGuideState = ReturnType<typeof useConnectGuideState>;
