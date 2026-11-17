import type { StaticStatus } from "./types";
import type { StableConnectSnapshot } from "./stableConnect";
import { buildDisplayHost, type McpScope } from "./utils";
import type { ChainState, ChainSegment } from "./serviceChain";

export interface ConnectionAccess {
  method: "stable" | "direct";
  serverName: string;
  connectionId: string | null;
  address: string;
  previousAddress: string | null;
  scope: McpScope | "local";
  projectPath: string;
  entryName: string;
  targetId?: string | null;
  targetKey: string;
  configured: boolean;
  configMatches: boolean;
  configurationVerified: boolean;
  verifiedAt: number | null;
  /** 配置写入之后、确有客户端经隧道连上来的时刻（Unix ms）。null = 尚无证据。 */
  clientVerifiedAt?: number | null;
  channelReady: boolean;
  channelDetail: string;
  channelPhase?: string;
  state: string;
  tone: "live" | "warn" | "error" | "stopped";
  title: string;
  detail: string;
  short: string;
  action: string;
  selectionPending: boolean;
  canCopyAddress: boolean;
  canCopyCommand: boolean;
  canUpdateIp: boolean;
  canConfirmUpdate?: boolean;
  tokenUpdatePending: boolean;
  sourceScope: string;
  sourceProjectPath: string;
  updateCommand: string;
}

export const connectionMethodLabel = (access: ConnectionAccess) => access.method === "stable" ? "隧道连接" : "IP 直连";
export const connectionScopeLabel = (scope: string) => scope === "user" ? "全局模式" : scope === "local" ? "项目级 · 旧版配置" : "项目级";
export const CONNECT_GUIDE_ANCHOR = "connect-guide";

export function connectionAddressHost(address?: string | null): string | null {
  if (!address) return null;
  try { return new URL(address).hostname; } catch { return null; }
}

/**
 * 「网络地址已变化」横幅该不该出现（2026-11-16 用户反馈：横幅自相矛盾 X → X）。
 *
 * 旧条件把 `ipResolvedByUser` 当成「已变化」的独立证据，但它只表示用户点过地址选择器：
 * 地址根本没变时也会弹，出现「10.203.5.22 → 10.203.5.22」这种自相矛盾的横幅，
 * 且把用户注意力从真正的问题（按钮无命令）上引开。
 *
 * 现在必须有具体证据才算变化：后端标记 `ipChanged` / 接入快照 `ip-changed` /
 * 「之前使用的地址」与当前选中确实不同。三条任一成立即可，所以「变了但还没复制命令」
 * 的中间态不会丢——那种情况下三个证据里必然已有其一。
 * 首次安装（previousIp 为空且没有任何标记）不再弹横幅。
 */
export function shouldShowIpChangeBanner(input: {
  stableMode: boolean;
  dismissed?: boolean;
  state?: string;
  ipChanged?: boolean;
  previousIp?: string | null;
  selectedIp?: string;
}): boolean {
  if (input.stableMode || input.dismissed) return false;
  if (input.state === "ip-changed" || input.ipChanged) return true;
  // previousIp 为空 = 没有可比对的历史，不构成「变化」。
  if (!input.previousIp) return false;
  return input.previousIp !== (input.selectedIp ?? "");
}

/** Global request totals and health probes cannot verify this server, project, or client. */
export function currentAccessChain(status?: StaticStatus, access = currentConnection(status)): ChainState {
  const running = !!status?.running;
  const stable = access?.method === "stable";
  const middle: ChainSegment = {
    key: stable ? "tunnel" : "address", name: stable ? "隧道通道" : "地址检查",
    tone: !running ? "idle" : ["recovery", "applying"].includes(access?.state ?? "") ? "pending" : access?.channelReady ? "ok" : "unknown",
    detail: access?.channelDetail ?? "读取状态中",
  };
  if (!stable && running && status?.firewallEnabled && status.firewallPortOpen === false) {
    middle.tone = "bad";
    middle.detail = "入站待放行";
  }
  return { tone: access?.tone ?? "stopped", headline: access?.title ?? "正在读取接入状态", sub: access?.detail ?? "稍等片刻，正在读取本机服务和接入配置。",
    segments: [
      { key: "service", name: "本机服务", tone: running ? "ok" : status?.startupError ? "bad" : "idle", detail: running ? "运行中" : status?.startupError ? "启动失败" : "已停止" },
      middle,
      { key: "verification", name: "接入验证", ...verifiedSegment(access?.clientVerifiedAt) },
    ],
  };
}

/**
 * 第三步「接入验证」的唯一依据：后端在配置写完之后，确实收到过回环来源的请求。
 * 本机拿不到服务器上的客户端状态，但隧道是裸 TCP 转发——能从 127.0.0.1 打进来，
 * 就只可能是 sshd 转回来的。没有这条证据时保持灰色，不装作已核实。
 */
function verifiedSegment(at?: number | null) {
  if (!at) return { tone: "idle" as const, detail: "客户端待验证" };
  const t = new Date(at);
  const clock = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  return { tone: "ok" as const, detail: `已验证 ${clock}` };
}

/** The backend owns facts. An event arriving before get_status uses a neutral, unverified transition. */
export function currentConnection(status?: StaticStatus, snapshot?: StableConnectSnapshot): ConnectionAccess | undefined {
  if (!status) return;
  const method = (status.connectClient ?? "claude-code") === "claude-code" ? snapshot?.method ?? status.currentAccess?.method ?? "direct" : "direct";
  const saved = status.currentAccess;
  const record = snapshot?.connections.find(c => c.connectionId === snapshot.selectedConnectionId);
  const stableAddress = record?.configured ? `http://127.0.0.1:${record.port}/mcp` : "";
  const stableScope = record?.target?.scope ?? record?.scope ?? "project";
  const stablePath = record?.target?.projectPath ?? record?.projectPath ?? "";
  // 条目名必须和真正写进服务器配置的那个一致：多设备时后端用的是 `cc-bridge-<deviceId>`
  // （stable_connect::remote_script），这里却固定回退 "cc-bridge"，会让「当前接入」显示的
  // 名称和服务器上实际条目对不上。
  const stableMultiDevice = record?.multiDevice ?? !!status.multiDeviceMode;
  const stableName = record?.target?.name ?? (stableMultiDevice && status.deviceId ? `cc-bridge-${status.deviceId}` : "cc-bridge");
  const targetId = record?.target?.id ?? null;
  const previousAddress = record?.target?.url && record.target.url !== stableAddress ? record.target.url : null;
  const sameStableTarget = !!saved && saved.connectionId === snapshot?.selectedConnectionId && saved.address === stableAddress &&
    saved.scope === stableScope && saved.projectPath === stablePath && saved.entryName === stableName &&
    (saved.targetId ?? null) === targetId && saved.previousAddress === previousAddress;
  if (saved && saved.method === method && (method === "direct" || !snapshot ||
    sameStableTarget && saved.configured === !!record?.configured && saved.configMatches === !!record?.configMatches &&
    saved.verifiedAt === (record?.verifiedAt ?? null) &&
    (!saved.channelPhase || saved.channelPhase === (record?.phase ?? "idle")))) return saved;
  const stable = method === "stable";
  const host = buildDisplayHost(status, status.lastSelectedIp ?? "");
  const address = stable ? stableAddress : host ? `${status.remoteTlsEnabled ? "https" : "http"}://${host}:${status.port}${status.transport === "sse" ? "/mcp/sse" : "/mcp"}` : "";
  const scope = stable ? stableScope : status.multiDeviceMode || (status.connectClient ?? "claude-code") !== "claude-code" ? "user" : status.scope ?? (status.hasOnboarded === false ? "user" : "project");
  const projectPath = stable ? stablePath : scope === "user" ? "" : status.projectPath?.trim() ?? "";
  const entryName = stable ? stableName : status.multiDeviceMode ? `cc-bridge-${status.deviceId}` : "cc-bridge";
  const access: ConnectionAccess = {
    method, serverName: stable ? saved?.connectionId === snapshot?.selectedConnectionId ? saved?.serverName ?? "选择服务器" : "选择服务器" : "本机直连", connectionId: stable ? snapshot?.selectedConnectionId ?? null : null,
    address, previousAddress: stable ? previousAddress : null, scope: scope as McpScope, projectPath, entryName, targetId: stable ? targetId : null,
    targetKey: JSON.stringify(["transition", method, stable ? snapshot?.selectedConnectionId : host, address, scope, projectPath, entryName, targetId, saved?.targetKey]),
    configured: stable && !!record?.configured, configMatches: stable && !!record?.configMatches,
    configurationVerified: false, verifiedAt: null, clientVerifiedAt: null, channelReady: !!status.running && (stable ? record?.phase === "ready" : !status.ipChanged && status.remoteReachable === true),
    channelDetail: stable ? record?.configured ? "读取状态中" : "待配置" : "本机地址检查", channelPhase: stable ? record?.phase ?? "idle" : "unknown",
    state: "waiting", tone: "live", title: stable ? record?.configured ? "正在读取隧道接入状态" : "隧道连接尚未配置" : "本机已就绪，接入待验证",
    detail: stable ? "在接入卡片查看当前服务器的配置和连接状态。" : "复制命令后，在服务器执行并查看 Claude Code 的 /mcp。",
    short: stable && !record?.configured ? "待配置" : "接入待验证", action: stable && !record?.configured ? "一键接入" : "查看接入",
    selectionPending: stable && !record?.configured && !!status.hasOnboarded,
    canCopyAddress: !!address, canCopyCommand: !stable || !!record?.configured && !!record.configMatches, canUpdateIp: !stable,
    tokenUpdatePending: stable && !!record?.configured && !record.configMatches,
    sourceScope: scope, sourceProjectPath: projectPath, updateCommand: "",
  };
  if (stable && !record?.configured) access.state = "setup";
  if (stable && record && (record.configured || record.phase === "running")) {
    const state = record.needsSecret ? "login" : record.phase === "running" ? "applying" : record.phase === "reconnecting" ? "recovery" : record.phase === "error" ? "error" : !record.configMatches ? "changed" : record.phase === "stopped" ? "paused" : "waiting";
    const descriptions: Record<string, [ConnectionAccess["tone"], string, string, string, string]> = {
      waiting: ["live", "隧道已连通，等待 Claude Code", "接入待验证", "请重新打开服务器上的 Claude Code，加载接入配置。", "检查接入"],
      applying: ["live", "正在配置隧道连接", "正在接入", "配置完成后，请重新打开服务器上的 Claude Code。", "查看接入进度"],
      recovery: ["warn", "正在重连，固定地址不变", "正在重连", "正在自动恢复连接，继续使用原来的 MCP 地址。", "查看连接状态"],
      login: ["warn", "需要重新登录服务器", "需要登录", "补充登录信息后继续连接，固定地址和项目配置已保留。", "重新登录"],
      changed: ["warn", "隧道连接配置待应用", "待应用", "检查并更新原有接入，继续沿用原名称、固定地址和范围。", "检查并更新原接入"],
      paused: ["stopped", "隧道已暂停，配置已保留", "已暂停", "恢复当前隧道后继续使用，无需再次添加 MCP。", "恢复隧道"],
      error: ["warn", "隧道连接需要处理", "连接异常", "查看当前原因，处理后重新连接。", "处理连接问题"],
    };
    const [tone, title, short, detail, action] = descriptions[state];
    Object.assign(access, { state, tone, title, short, detail, action, channelDetail: state === "waiting" ? "已连通" : short,
      channelReady: record.phase === "ready" && !!status.running, canCopyCommand: !!record.configMatches && record.phase !== "running",
      configurationVerified: !!record.configMatches && !!record.target && record.phase !== "error" && record.phase !== "running", verifiedAt: record.verifiedAt ?? null });
    if (sameStableTarget && saved) access.targetKey = saved.targetKey;
  }
  // record.target 是服务器最近一次核对读到的真值。它和固定地址不一致时，隧道通但接入没指过来，
  // 不能沿用「已连通，等待 Claude Code」——否则卡片一边说通了，一边又在下面提示地址是旧的。
  if (stable && record?.target && stableAddress && record.target.url !== stableAddress) {
    Object.assign(access, {
      state: "changed", tone: "warn", title: "隧道已连通，服务器接入待更新", short: "接入待更新",
      detail: "服务器上的接入仍指向原地址，更新后才能通过隧道使用。", action: "更新服务器接入",
      channelDetail: "已连通 · 接入未指向", configurationVerified: false,
    });
  }
  if (stable && (status.remoteTlsEnabled || status.transport === "sse")) Object.assign(access, { state: "unsupported", tone: "warn", title: "隧道接入设置需要调整", short: "设置待调整",
    detail: "自动接入需要 HTTP 且未启用 HTTPS；请前往现有网络设置调整。", action: "查看网络设置", channelReady: false, channelDetail: "等待调整", canCopyCommand: false });
  if (!status.running) Object.assign(access, { state: status.startupError ? "service-error" : "service-stopped", tone: status.startupError ? "error" : "stopped",
    title: status.startupError ? "本机服务无法启动" : "本机服务已停止", short: "本机服务已停止", detail: status.startupError ?? "启动本机服务后，全部接入才能继续使用。", action: "启动本机服务", channelDetail: "等待服务" });
  else if (!stable && (status.ipChanged || status.remoteReachable === false)) Object.assign(access, { state: status.ipChanged ? "ip-changed" : "direct-unreachable", tone: "warn",
    title: status.ipChanged ? "直连地址已变化，原接入待更新" : "本机直连地址暂不可用", short: status.ipChanged ? "地址待更新" : "地址待检查", detail: "在接入卡片检查直连地址，更新后请在服务器验证。", action: "查看直连接入" });
  return access;
}
