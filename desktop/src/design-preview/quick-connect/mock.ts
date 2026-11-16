import type { StatusResponse, SshConnection } from "../../lib/types";
import { emptySshConnection } from "../../lib/sshConnectionForm";
import { invalidateLinkageFixture, invokeProductionFixture, listenProductionFixture, resetProductionFixture } from "./production-fixture";
import type { Scenario } from "./model";
const defaultConnections: SshConnection[] = [
  { ...emptySshConnection(), id: "cloud", name: "我的云服务器", host: "203.0.113.24", username: "ubuntu", rememberPassword: true },
  { ...emptySshConnection(), id: "dev", name: "开发服务器", host: "192.0.2.16", username: "developer", authType: "key", keyPath: "C:/Users/demo/.ssh/id_ed25519" },
];
export let previewConnections = [...defaultConnections];
export function resetPreviewConnections(empty: boolean, scenario: Scenario = "normal") { previewConnections = empty ? [] : [...defaultConnections]; resetProductionFixture(scenario); }
export const status = {
  version: "3.1.5", uptimeSeconds: 320, allowedRoots: ["D:\\Projects"], excludePatterns: [], allowedExtensions: [], maxFileSizeBytes: 10485760,
  journalEnabled: true, journalRetentionDays: 30, journalDir: "journal", ccNotifyTurnEnd: false, ccAutoApproveRules: [], releaseWebviewOnClose: true,
  rateLimit: { maxRequests: 100, windowMs: 60000 }, backupDir: "backups", backupDirAbs: "D:\\cc-bridge\\backups", backupCount: 0, backupTotalBytes: 0,
  backupRetention: 10, auditRetentionDays: 30, commandCleanupSecs: 120, host: "0.0.0.0", port: 7823,
  stats: { totalRequests: 0, totalErrors: 0, successRate: 0, requestsPerMin: 0, avgLatencyMs: 0, p95LatencyMs: 0, rateLimitHits: 0, authDenies: 0, auditCount: 0, activeCommands: 0, topTools: [] },
  connectCommand: "", connectClient: "claude-code", token: "PREVIEW_ONLY_NOT_A_SECRET", whitelistEnabled: true, readonlyMode: false, backupEnabled: true, auditEnabled: true,
  rateLimitEnabled: true, encodingDetectEnabled: true, shellEnabled: false, sessionCwdEnabled: false, shellType: "bash", transport: "http", bashAvailable: true,
  running: true, lanIps: ["192.168.31.81", "10.203.5.36"], lastSelectedIp: "192.168.31.81", ipChanged: false, remoteReachable: true, scope: "user", projectPath: "", hasOnboarded: true,
  startupError: null, firewallEnabled: true, firewallPortOpen: true, firewallCheckedSecondsAgo: 0, firewallAvailable: true, rootProfiles: [], activeProfile: "默认",
  commandAllowlistEnabled: false, commandAllowlist: [], notifyCommandComplete: true, notifyTaskComplete: true, sshEnabled: true, sshDragSelectEnabled: true,
  sshCopyOnSelectEnabled: true, platform: "windows", deviceId: "demo", deviceName: "我的电脑", multiDeviceMode: false, authFailureSources: 0,
} as StatusResponse;
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (command.startsWith("stable_connect_")) return await invokeProductionFixture(command, args, status) as T;
  const reads: Record<string, unknown> = {
    get_status: status, get_token_usage: { days: [], tools: [], byDayTool: [] }, get_recent_activity: [],
    get_tls_status: { enabled: false, hasCert: false, fingerprint: null, certIps: [] },
    get_firewall_diagnosis: { issues: [], rules: [], profiles: [], port: 7823 }, ssh_list_connections: { enabled: true, connections: previewConnections }, ssh_tunnel_list: [],
    probe_lan_ips: status.lanIps.map(ip => ({ ip, state: "ok", latencyMs: 0 })),
  };
  if (command in reads) return reads[command] as T;
  if (command === "ssh_save_connection") {
    const payload = args?.args as { connection: SshConnection };
    const conn = { ...payload.connection, id: payload.connection.id || `demo-${Date.now()}` };
    previewConnections = [...previewConnections.filter(c => c.id !== conn.id), conn];
    return conn as T;
  }
  if (command === "start_mcp_server" || command === "stop_mcp_server") { status.running = command === "start_mcp_server"; return undefined as T; }
  if (command === "regenerate_token") { status.token = `PREVIEW_ONLY_${Date.now()}`; if (document.documentElement.dataset.connectionLinkage === "true") { invalidateLinkageFixture(true); window.dispatchEvent(new Event("quick-preview-config-changed")); } return status.token as T; }
  if (command === "save_config") { Object.assign(status, args?.patch ?? {}); if (document.documentElement.dataset.connectionLinkage === "true") window.dispatchEvent(new Event("quick-preview-config-changed")); return { ok: true, changed: [], warnings: [], restartRequired: false } as T; }
  if (command === "set_selected_ip") return undefined as T;
  throw new Error(`交互设计稿不会执行此系统操作：${command}`);
}
export const invokeOrToast = invoke;
export async function listen(event: string, handler: () => void) { return event === "stable_connect_changed" ? listenProductionFixture(handler) : () => {}; }
