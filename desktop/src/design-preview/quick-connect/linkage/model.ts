import { stableConnectCommand, type StableConnection } from "../../../lib/stableConnect";
import type { StaticStatus } from "../../../lib/types";
import { buildBaseCommand, buildConnectCommand, buildIpSedCommand, quoteRemotePath, type McpScope } from "../../../lib/utils";

export const linkageScenarios = {
  verified: "隧道 · 接入已核实",
  waiting: "隧道 · 等待 Claude Code",
  setup: "隧道 · 尚未配置",
  recovery: "隧道 · VPN 断开",
  paused: "隧道 · 已暂停",
  changed: "隧道 · Token 待更新",
  login: "隧道 · 需要重新登录",
  server: "切换服务器 · 尚未接入",
  direct: "IP 直连 · 接入已核实",
  "ip-changed": "IP 直连 · 地址待更新",
} as const;
export type LinkageScenario = keyof typeof linkageScenarios;
export type LinkageMethod = "stable" | "direct";
export type LinkageTone = "live" | "warn" | "error" | "stopped";
export interface AccessEvidence {
  method: LinkageMethod;
  connectionId: string;
  address: string;
  scope: McpScope | "local";
  projectPath: string;
  token: string;
}
export const evidenceKey = (evidence: AccessEvidence) => JSON.stringify(evidence);
export const scopeText = (scope: McpScope | "local") => scope === "user" ? "全局模式" : scope === "local" ? "本地项目" : "项目级";
export interface LinkageInput {
  method: LinkageMethod;
  connectionId: string;
  serverName: string;
  record?: StableConnection;
  status: StaticStatus;
  ip: string;
  directScope: McpScope;
  directPath: string;
  applied: AccessEvidence | null;
  verifiedKey: string | null;
  copiedCommand: boolean;
  pendingChange?: boolean;
}
export function connectionSummary(input: LinkageInput) {
  const { method, record, status, connectionId, applied } = input;
  const stable = method === "stable";
  const methodLabel = stable ? "隧道连接" : "IP 直连";
  const port = stable ? record?.port : status.port;
  const address = stable ? record?.configured && port ? `http://127.0.0.1:${port}/mcp` : "" : `http://${input.ip}:${status.port}/${status.transport === "sse" ? "mcp/sse" : "mcp"}`;
  const scope = stable ? record?.target?.scope ?? record?.scope ?? "project" : input.directScope;
  const projectPath = stable ? record?.target?.projectPath ?? record?.projectPath ?? "" : input.directPath;
  const target: AccessEvidence = { method, connectionId: stable ? connectionId : "direct", address, scope, projectPath: scope === "user" ? "" : projectPath, token: status.token };
  const sameTarget = !!applied && evidenceKey(applied) === evidenceKey(target);
  const configured = stable ? !!record?.configured : !!applied && applied.method === "direct";
  const changed = configured && (!sameTarget || stable && (record?.configMatches === false || !!input.pendingChange));
  const channelReady = status.running && (stable ? record?.phase === "ready" : !status.ipChanged && status.remoteReachable !== false);
  // Evidence belongs to a target and its configuration; global request totals cannot promote it.
  const verified = !!status.running && channelReady && sameTarget && !changed && input.verifiedKey === evidenceKey(target);
  let state = "waiting";
  let title = stable ? "隧道已连通，等待 Claude Code" : "本机已就绪，接入待验证";
  let detail = "重新打开服务器上的 Claude Code，加载接入配置。";
  let short = "接入待验证";
  let tone: LinkageTone = "live";
  let action = "检查接入";
  let channelDetail = stable ? "已连通" : "本机可达";
  if (!status.running) {
    state = "service-stopped"; title = "本机服务已停止"; detail = "启动本机服务后，所有接入才能继续使用。"; short = "本机服务已停止"; tone = "stopped"; action = "启动本机服务"; channelDetail = "等待服务";
  } else if (stable && record?.phase === "running") {
    state = "applying"; title = "正在配置隧道连接"; detail = "配置完成后，请重新打开服务器上的 Claude Code。"; short = "正在接入"; action = "查看接入进度"; channelDetail = "连接中";
  } else if (!configured) {
    state = "setup"; title = `${methodLabel}尚未配置`; detail = stable ? "选择服务器和项目，一次完成隧道与接入配置。" : "复制接入命令，在服务器终端执行后打开 Claude Code。"; short = "待配置"; action = stable ? "一键接入" : "复制连接命令"; channelDetail = stable ? "待配置" : "本机可达";
  } else if (stable && record?.phase === "reconnecting") {
    state = "recovery"; title = "正在重连，固定地址不变"; detail = "等待 VPN 或网络恢复，继续使用原来的 MCP 地址。"; short = "正在重连"; tone = "warn"; action = "查看连接状态"; channelDetail = "正在重连";
  } else if (stable && record?.phase === "error") {
    state = "login"; title = record.needsSecret ? "需要重新登录服务器" : "隧道连接未完成"; detail = record.needsSecret ? "补充登录信息后继续连接，固定地址和项目配置已保留。" : "查看当前原因，处理后重新连接。"; short = record.needsSecret ? "需要登录" : "连接异常"; tone = "warn"; action = record.needsSecret ? "重新登录" : "处理连接问题"; channelDetail = "等待处理";
  } else if (stable && record?.phase === "stopped") {
    state = "paused"; title = "隧道已暂停，配置已保留"; detail = "恢复当前隧道后继续使用，无需再次添加 MCP。"; short = "已暂停"; tone = "stopped"; action = "恢复隧道"; channelDetail = "已暂停";
  } else if (!stable && status.ipChanged) {
    state = "ip-changed"; title = "直连地址已变化，原接入待更新"; detail = "复制地址更新命令，在原接入位置执行，无需重新添加 MCP。"; short = "地址待更新"; tone = "warn"; action = "复制 IP 替换命令"; channelDetail = "地址待更新";
  } else if (changed) {
    state = "changed"; title = `${methodLabel}配置待应用`; detail = applied?.method !== method ? `服务器当前仍使用${applied?.method === "stable" ? "隧道连接" : "IP 直连"}，完成配置后再切换。` : stable ? "检查并更新原有接入，继续沿用原名称、固定地址和范围。" : "在服务器执行更新命令后，再确认当前接入。"; short = "待应用"; tone = "warn"; action = stable ? "检查并更新原接入" : "复制连接命令";
  } else if (verified) {
    state = "verified"; title = `${methodLabel}接入已核实`; detail = stable ? "当前服务器项目已收到 Claude Code 调用，VPN 重连无需改地址。" : "当前接入已收到 Claude Code 调用，地址与配置一致。"; short = "接入已核实";
  } else if (!stable && input.copiedCommand) {
    state = "copied"; title = "命令已复制，等待执行与验证"; detail = "请在服务器终端执行，再重新打开 Claude Code。"; short = "待执行 / 待验证";
  }
  const base = address ? buildBaseCommand(stable ? "127.0.0.1" : input.ip, port ?? status.port, status.token, status.transport, false) : "";
  const commandScope = scope === "user" ? "user" : "project";
  const command = stable && record?.target ? stableConnectCommand(record, status, { scope: commandScope, projectPath, multiDevice: false }) : base ? `${scope !== "user" && projectPath ? `cd ${quoteRemotePath(projectPath)} && ` : ""}${buildConnectCommand(base, commandScope)}` : "";
  const updateScope = applied?.method === "direct" ? applied.scope : scope;
  const ipCommand = stable ? "" : buildIpSedCommand(input.ip, status.port, updateScope === "user" ? "user" : "project", applied?.method === "direct" ? applied.projectPath : projectPath);
  return { state, title, detail, short, tone, action, channelDetail, stable, methodLabel, target, configured, changed, channelReady, verified,
    address, addressLabel: stable ? "服务器固定接入地址" : sameTarget ? "当前接入地址" : "准备接入地址", scope, projectPath, serverName: input.serverName,
    command, ipCommand, canCopyAddress: !!address, canCopyCommand: !!command && (!stable || configured && !changed && record?.phase !== "running"),
    previousAddress: !stable && applied?.method === "direct" && applied.address !== address ? applied.address : "",
    selectionPending: !!applied && (applied.method !== method || stable && applied.connectionId !== connectionId),
    verificationText: verified ? "已核实当前接入" : "等待客户端验证",
  };
}
export type ConnectionSummary = ReturnType<typeof connectionSummary>;
