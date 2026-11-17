import type { StaticStatus } from "./types";
import { buildBaseCommand, buildConnectCommand, buildMultiDeviceCommand, type McpScope } from "./utils";
import type { StableAccessRequest, StableTarget } from "./stableAccess";
import { stableConfirmedPort, stableShellQuote } from "./stableAccess";

export type ConnectionMethod = "stable" | "direct";
export interface StableConnection {
  connectionId: string;
  port: number;
  scope: McpScope;
  projectPath: string;
  multiDevice: boolean;
  configured: boolean;
  enabled: boolean;
  phase: "idle" | "running" | "ready" | "reconnecting" | "error" | "stopped";
  step: number;
  message: string | null;
  needsSecret: boolean;
  configMatches: boolean;
  target?: StableTarget | null;
  verifiedAt?: number | null;
}
export interface StableConnectSnapshot {
  method: ConnectionMethod;
  selectedConnectionId: string | null;
  connections: StableConnection[];
}
export interface StableSetup { scope: McpScope; projectPath: string; multiDevice: boolean; access?: StableAccessRequest }
export const stableSteps = ["检查本机服务", "连接服务器", "建立加密通道", "配置 Claude Code", "验证接入"];
export const stableProgressLabels = ["连接服务器", "配置 Claude Code", "检查可用"];
export const stableProgressIndex = (step: number) => Math.max(0, Math.min(2, step - 2));

export function stableSetupMatches(connection: StableConnection, setup: StableSetup): boolean {
  return connection.configMatches && connection.scope === setup.scope && connection.multiDevice === setup.multiDevice
    && (setup.scope !== "project" || connection.projectPath.trim() === setup.projectPath.trim())
    && (!setup.access?.target || setup.access.target.id === connection.target?.id);
}

/** The port is the backend-confirmed remote listener, never a changed local VPN address. */
export function stableConnectCommand(connection: StableConnection | undefined, status: StaticStatus | undefined, setup: StableSetup): string {
  const port = stableConfirmedPort(connection);
  if (!status?.token || !port) return "";
  if (connection?.target) {
    const target = connection.target;
    const quote = stableShellQuote;
    const command = `claude mcp add --scope ${target.scope} --transport ${status.transport === "sse" ? "sse" : "http"} ${quote(target.name)} ${quote(`http://127.0.0.1:${port}${status.transport === "sse" ? "/mcp/sse" : "/mcp"}`)} --header ${quote(`Authorization: Bearer ${status.token}`)}`;
    return target.scope === "user" ? command : `cd ${quote(target.projectPath)} && ${command}`;
  }
  return setup.multiDevice
    ? buildMultiDeviceCommand("127.0.0.1", port, status.token, status.transport, false, status.deviceId)
    : buildConnectCommand(buildBaseCommand("127.0.0.1", port, status.token, status.transport, false), setup.scope);
}

/** Direct-IP warnings must not ask a configured stable user to replace their fixed MCP URL. */
export function usesStableConnection(snapshot: StableConnectSnapshot | undefined, status: StaticStatus | undefined): boolean {
  return (status?.connectClient ?? "claude-code") === "claude-code" && snapshot?.method === "stable"
    && snapshot.connections.some(c => c.connectionId === snapshot.selectedConnectionId && c.configured);
}
