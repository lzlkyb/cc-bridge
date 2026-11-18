import type { ForwardAuto, ForwardKind, ForwardRule, TunnelStatus } from "./types";
import { sameForward } from "./sshTunnelStore";
import { manualForwardDraft, hostsOverlap, sameForwardRoute, type ForwardContext } from "./forwardOwnership";

export const FORWARD_PURPOSES = {
  local: { label: "在本机访问服务器服务", short: "本机访问服务器", hint: "打开服务器上的网页、数据库等", accessMachine: "本机", targetMachine: "服务器本身", targetLabel: "服务器上的服务端口", accessLabel: "在本机使用的端口", icon: "monitor" },
  remote: { label: "在服务器访问本机服务", short: "服务器访问本机", hint: "让服务器使用本机正在运行的服务", accessMachine: "服务器", targetMachine: "本机", targetLabel: "本机上的服务端口", accessLabel: "在服务器使用的端口", icon: "server" },
  dynamic: { label: "通过服务器使用 SOCKS5 代理", short: "服务器代理", hint: "供支持 SOCKS5 的浏览器或应用使用", accessMachine: "本机", targetMachine: "由应用指定", targetLabel: "", accessLabel: "本机代理端口", icon: "external" },
} as const;

export const FORWARD_AUTO_OPTIONS: { value: ForwardAuto; label: string; hint: string }[] = [
  { value: "off", label: "仅手动开启", hint: "需要时在这里开启" },
  { value: "ask", label: "连接终端时询问", hint: "由你决定是否同时开启" },
  { value: "connect", label: "连接终端时开启", hint: "连接后直接开启手动转发" },
  { value: "launch", label: "随 CC Bridge 启动", hint: "使用已保存的登录信息" },
];

export interface ForwardValues {
  kind: ForwardKind;
  targetPort: string;
  accessPort: string;
  targetHost: string;
  listenHost: string;
  note: string;
  enabled: boolean;
  automaticPort: boolean;
}

export function forwardValues(rule: ForwardRule): ForwardValues {
  return { kind: rule.kind, targetPort: rule.targetPort ? String(rule.targetPort) : "", accessPort: rule.listenPort ? String(rule.listenPort) : "",
    targetHost: rule.targetHost, listenHost: rule.listenHost, note: rule.note, enabled: rule.enabled,
    automaticPort: rule.kind === "remote" && rule.listenPort === 0 };
}

export function newForwardValues(kind: ForwardKind): ForwardValues {
  return { kind, targetPort: "", accessPort: kind === "dynamic" ? "1080" : "", targetHost: "127.0.0.1", listenHost: "127.0.0.1", note: "", enabled: true, automaticPort: false };
}

const cleanHost = (host: string) => host.trim().replace(/^\[|\]$/g, "");
export function forwardRule(id: string, values: ForwardValues): ForwardRule {
  return { id, kind: values.kind, enabled: values.enabled, listenHost: cleanHost(values.listenHost), listenPort: values.automaticPort && values.kind === "remote" ? 0 : Number(values.accessPort),
    targetHost: cleanHost(values.targetHost), targetPort: values.kind === "dynamic" ? 0 : Number(values.targetPort), note: values.note.trim() };
}

export function forwardConflict(rule: ForwardRule, rules: ForwardRule[], context?: ForwardContext): string | undefined {
  if (context?.managed.some(owner => sameForwardRoute(rule, owner.rule))) return "这条转发已由 Claude Code 接入卡管理，请在“管理接入”中调整。";
  const ownership = manualForwardDraft([rule], context).conflicts[0];
  if (ownership) return ownership.message;
  // 同端口还要看监听地址：`0.0.0.0` / `*` 是通配，会把只写回环的另一条绑定抢掉
  // （后端 validate_rules 同一口径，两边都放行才会出现「保存成功但运行失败」）。
  if (rule.enabled && rule.listenPort > 0 && rules.some(other => other.id !== rule.id && other.enabled
    && other.listenPort === rule.listenPort && (other.kind === "remote") === (rule.kind === "remote")
    && hostsOverlap(rule.listenHost, other.listenHost))) {
    return "访问端口 " + rule.listenPort + " 已有一条监听地址重叠的转发规则，请换一个端口或监听地址。";
  }
}

const validPort = (port: string) => /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
// 与后端 `host_ok` 同口径：`*` 只作为完整通配符放行，不混进主机名。
const validHost = (host: string) => {
  const cleaned = cleanHost(host);
  return cleaned === "*" || /^[a-zA-Z0-9._:-]+$/.test(cleaned);
};
export function validateForwardValues(values: ForwardValues, rules: ForwardRule[], context?: ForwardContext, id = "new"): Record<string, string> {
  const errors: Record<string, string> = {};
  if (values.kind !== "dynamic" && !validPort(values.targetPort)) errors.targetPort = "请输入服务端口，范围为 1–65535。";
  if (!(values.kind === "remote" && values.automaticPort) && !validPort(values.accessPort)) errors.accessPort = "请输入访问端口，范围为 1–65535。";
  if (!validHost(values.listenHost)) errors.listenHost = "请输入主机名或 IP 地址。";
  if (values.kind !== "dynamic" && !validHost(values.targetHost)) errors.targetHost = "请输入服务的主机名或 IP 地址。";
  if (!errors.accessPort && !errors.targetPort) {
    const conflict = forwardConflict(forwardRule(id, values), rules, context);
    if (conflict) errors.accessPort = conflict;
  }
  return errors;
}

export function suggestForwardPort(values: ForwardValues, rules: ForwardRule[], context?: ForwardContext, id = "new"): string {
  let port = Math.max(0, Number(values.accessPort) || Number(values.targetPort) || 3000);
  if (port >= 65535) port = 1023;
  while (++port <= 65535) {
    if (!forwardConflict(forwardRule(id, { ...values, automaticPort: false, accessPort: String(port) }), rules, context)) return String(port);
  }
  return "";
}

export function forwardAddress(rule: ForwardRule, boundPort?: number | null): string | null {
  const port = boundPort ?? rule.listenPort;
  if (!port) return null;
  const listenHost = cleanHost(rule.listenHost);
  const host = listenHost === "::" ? "::1" : ["", "*", "0.0.0.0"].includes(listenHost) ? "127.0.0.1" : listenHost;
  return (host.includes(":") ? "[" + host + "]" : host) + ":" + port;
}

export type ForwardPhase = "running" | "stopped" | "connecting" | "reconnecting" | "error";
export function forwardDisplay(rule: ForwardRule, status?: TunnelStatus) {
  const live = status?.rules.find(entry => entry.rule.id === rule.id);
  const active = !!status && !["error", "stopped"].includes(status.state);
  // Keep the runtime snapshot until application: a saved edit is not a new listening address.
  const actual = live && active ? live.rule : rule;
  const pending = !!(live && active && (!rule.enabled || !sameForward(rule, live.rule)));
  let phase: ForwardPhase = "stopped";
  if (rule.enabled && (status?.state === "error" && !!live || active && live?.state === "failed")) phase = "error";
  else if (active && live) phase = status.state === "reconnecting" ? "reconnecting" : status.state === "connecting" || live.state === "pending" ? "connecting" : "running";
  const boundPort = active ? live?.boundPort : undefined;
  const address = forwardAddress(actual, boundPort);
  return { actual, live, pending, phase, active, boundPort, address, canCopy: !!address && live?.state === "listening" && phase === "running" };
}
