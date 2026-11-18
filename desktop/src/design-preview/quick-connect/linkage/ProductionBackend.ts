import { currentConnection } from "../../../lib/connectionAccess";
import { stableConnectCommand, type StableConnectSnapshot } from "../../../lib/stableConnect";
import { stableSavedSetup } from "../../../lib/stableAccess";
import { buildBaseCommand, buildConnectCommand, buildDisplayHost, buildIpSedCommand, buildMultiDeviceCommand, quoteRemotePath, type McpScope } from "../../../lib/utils";
import { invoke as legacyInvoke, listen as legacyListen, status, previewConnections } from "../mock";
import { prepareLinkageFixture, recoverLinkageFixture, invalidateLinkageFixture, invokeProductionFixture } from "../production-fixture";
import type { LinkageScenario } from "./model";
import type { TunnelStatus } from "../../../lib/types";

export const scenarios = {
  waiting: "隧道已连通 · 客户端待验证", setup: "隧道尚未配置", recovery: "VPN 断开 · 自动重连",
  paused: "隧道已暂停", changed: "隧道 Token 待应用", login: "需要重新登录", server: "切换未配置服务器",
  direct: "IP 直连 · 客户端待验证", "ip-changed": "直连地址待更新",
} as const;
export type Scenario = keyof typeof scenarios;
const listeners = new Map<string, Set<(payload?: unknown) => void>>();
let tunnelStatus: TunnelStatus | undefined;
let service: { pending: "start" | "stop" | "restart" | null; error: string | null } = { pending: null, error: null };
let receipt: { address: string; token: string; scope: McpScope; projectPath: string } | null = null;
const emit = () => { listeners.forEach((group, event) => { if (!["ssh_tunnel_status", "stable_tunnel_traffic"].includes(event)) group.forEach(listener => listener()); }); };

// Isolated design fixture: the same status/traffic contract as native events, with no SSH IO.
export function sendTunnelPreview(event: "ssh_tunnel_status" | "stable_tunnel_traffic", payload: unknown) {
  if (event === "ssh_tunnel_status") tunnelStatus = payload as TunnelStatus;
  listeners.get(event)?.forEach(listener => listener(payload));
}

export function resetCheck(next: Scenario) {
  prepareLinkageFixture(next as LinkageScenario);
  Object.assign(status, { running: true, token: "PREVIEW_ONLY_NOT_A_SECRET", remoteTlsEnabled: false, host: "0.0.0.0", port: 7823, transport: "http",
    connectClient: "claude-code", scope: "project", projectPath: "/home/ubuntu/projects/orders", multiDeviceMode: false,
    lastSelectedIp: "10.203.5.36", lanIps: next === "ip-changed" ? ["10.203.5.58"] : ["10.203.5.36", "192.168.31.81"], ipChanged: next === "ip-changed" });
  status.stats.totalRequests = 146; status.stats.successRate = 99.3;
  receipt = { address: "http://10.203.5.36:7823/mcp", token: status.token, scope: "project", projectPath: status.projectPath! };
  service = { pending: null, error: null }; emit();
  const phase = new URLSearchParams(location.search).get("tunnelPhase");
  tunnelStatus = phase ? { connectionId: "stable:cloud", state: phase === "waiting" ? "reconnecting" : phase === "connecting" ? "connecting" : "up",
    needsSecret: false, message: null, rules: [], attempt: 3, phase: phase === "waiting" ? "waiting" : phase === "connecting" ? "ssh" : "ready",
    retryAt: phase === "waiting" ? Date.now() + 8000 : null, disconnectedAt: phase === "transfer" ? null : Date.now() - 23000,
    lastFailure: phase === "transfer" ? null : "Connection timed out" } : undefined;
}
export function recoverCheck() { recoverLinkageFixture(); emit(); }
export const getCheckStatus = () => status;

async function readStatus() {
  const snapshot = await invokeProductionFixture("stable_connect_get", undefined, status) as StableConnectSnapshot;
  const access = currentConnection({ ...status, currentAccess: undefined }, snapshot)!;
  const record = snapshot.connections.find(item => item.connectionId === snapshot.selectedConnectionId);
  if (access.method === "stable") access.serverName = previewConnections.find(item => item.id === access.connectionId)?.name ?? "选择服务器";
  access.targetKey = `${snapshot.method}:${snapshot.selectedConnectionId}:${access.scope}:${access.projectPath}:${status.token}:${access.address}`;
  if (access.method === "direct" && receipt) {
    Object.assign(access, { configured: true, configMatches: receipt.token === status.token && receipt.address === access.address,
      previousAddress: receipt.address === access.address ? null : receipt.address, tokenUpdatePending: receipt.token !== status.token,
      canConfirmUpdate: receipt.address !== access.address || receipt.token !== status.token,
      sourceScope: receipt.scope, sourceProjectPath: receipt.projectPath,
      updateCommand: buildIpSedCommand(buildDisplayHost(status, status.lastSelectedIp ?? ""), status.port, receipt.scope, receipt.projectPath, !!status.remoteTlsEnabled) });
    if (receipt.address !== access.address && status.running) Object.assign(access, { state: "ip-changed", tone: "warn", title: "直连地址已变化，原接入待更新", short: "地址待更新", channelReady: false });
    if (receipt.token !== status.token && status.running) Object.assign(access, { state: "changed", tone: "warn", title: "IP 直连配置待应用", short: "待应用" });
  }
  const host = buildDisplayHost(status, status.lastSelectedIp ?? "");
  const scope = (status.scope ?? "project") as McpScope;
  const base = status.multiDeviceMode ? buildMultiDeviceCommand(host, status.port, status.token, status.transport, !!status.remoteTlsEnabled, status.deviceId)
    : buildConnectCommand(buildBaseCommand(host, status.port, status.token, status.transport, !!status.remoteTlsEnabled), scope);
  const command = snapshot.method === "stable" ? stableConnectCommand(record, status, stableSavedSetup(record))
    : scope === "project" && status.projectPath?.trim() && !status.multiDeviceMode ? `cd ${quoteRemotePath(status.projectPath.trim())} && ${base}` : base;
  return structuredClone({ ...status, currentAccess: access, serviceControl: service, connectCommand: command });
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (command === "ssh_tunnel_list") return (tunnelStatus ? [tunnelStatus] : []) as T;
  if (command === "stable_tunnel_retry" && tunnelStatus?.state === "reconnecting") {
    sendTunnelPreview("ssh_tunnel_status", { ...tunnelStatus, state: "connecting", phase: "ssh", retryAt: null, attempt: (tunnelStatus.attempt ?? 0) + 1 });
    return undefined as T;
  }
  if (command === "get_status") return await readStatus() as T;
  if (command === "get_connection_copy") {
    const saved = await readStatus();
    const kind = args?.kind;
    const text = kind === "address" ? saved.currentAccess.address : kind === "command" ? saved.connectCommand : saved.currentAccess.updateCommand;
    if (!text || kind === "command" && !saved.currentAccess.canCopyCommand) throw new Error("当前接入尚未配置，请在接入卡片继续。");
    return { text, targetKey: saved.currentAccess.targetKey } as T;
  }
  if (command === "connection_command_copied") {
    const saved = await readStatus();
    if (args?.targetKey === saved.currentAccess.targetKey && saved.currentAccess.method === "direct") receipt = {
      address: saved.currentAccess.address, token: saved.token, scope: saved.currentAccess.scope as McpScope, projectPath: saved.currentAccess.projectPath };
    emit(); return undefined as T;
  }
  if (command === "connection_update_copied") return undefined as T;
  if (command === "confirm_connection_update") {
    const saved = await readStatus();
    if (!receipt || args?.targetKey !== saved.currentAccess.targetKey || !saved.currentAccess.canConfirmUpdate) {
      throw new Error("接入目标已变化，请重新查看当前接入。");
    }
    receipt = { ...receipt, address: saved.currentAccess.address, token: saved.token };
    status.lastSelectedIp = buildDisplayHost(status, status.lastSelectedIp ?? "");
    status.ipChanged = false;
    emit(); return undefined as T;
  }
  if (["start_mcp_server", "stop_mcp_server", "restart_mcp_server"].includes(command)) {
    if (service.pending) throw new Error("本机服务正在处理。");
    service.pending = command === "start_mcp_server" ? "start" : command === "stop_mcp_server" ? "stop" : "restart"; emit();
    await new Promise(resolve => setTimeout(resolve, 600)); status.running = command !== "stop_mcp_server";
    service.pending = null; emit(); return undefined as T;
  }
  if (command === "set_selected_ip") { status.lastSelectedIp = String(args?.ip); status.ipChanged = false; emit(); return undefined as T; }
  if (command === "regenerate_token") { status.token = `PREVIEW_ONLY_${Date.now()}`; invalidateLinkageFixture(true); emit(); return status.token as T; }
  const result = await legacyInvoke<T>(command, args);
  if (command === "save_config") emit();
  return result;
}
export const invokeOrToast = invoke;
export async function listen<T>(event: string, handler: (payload: T) => void) {
  const callback = handler as (payload?: unknown) => void;
  const group = listeners.get(event) ?? new Set<(payload?: unknown) => void>(); listeners.set(event, group); group.add(callback);
  const stop = ["ssh_tunnel_status", "stable_tunnel_traffic"].includes(event) ? () => {} : await legacyListen(event, () => handler(undefined as T));
  return () => { group.delete(callback); stop(); };
}
