export type Purpose = "local" | "remote" | "dynamic";
export type Phase = "running" | "stopped" | "connecting" | "reconnecting" | "error";
export type Scenario = "running" | "first" | "local" | "remote" | "changed" | "error" | "reconnecting";
export type AutoMode = "off" | "ask" | "connect" | "launch";

export interface Values {
  purpose: Purpose;
  targetPort: string;
  accessPort: string;
  targetHost: string;
  listenHost: string;
  name: string;
}

export interface Rule {
  id: string;
  values: Values;
  phase: Phase;
  pending?: Values;
}

export const PURPOSES = {
  local: {
    label: "在本机访问服务器服务",
    short: "本机访问服务器",
    hint: "打开服务器上的网页、数据库等",
    targetLabel: "服务器上的服务端口",
    accessLabel: "在本机使用的端口",
    targetMachine: "服务器本身",
    accessMachine: "本机",
    icon: "monitor",
  },
  remote: {
    label: "在服务器访问本机服务",
    short: "服务器访问本机",
    hint: "让服务器使用本机正在运行的服务",
    targetLabel: "本机上的服务端口",
    accessLabel: "在服务器使用的端口",
    targetMachine: "本机",
    accessMachine: "服务器",
    icon: "server",
  },
  dynamic: {
    label: "通过服务器使用 SOCKS5 代理",
    short: "服务器代理",
    hint: "供支持 SOCKS5 的浏览器或应用使用",
    targetLabel: "",
    accessLabel: "本机代理端口",
    targetMachine: "由应用指定",
    accessMachine: "本机",
    icon: "external",
  },
} as const;

export const SCENARIOS: Record<Scenario, string> = {
  running: "当前规则 · 已开启",
  first: "首次使用 · 无规则",
  local: "添加 · 本机访问服务器",
  remote: "添加 · 服务器访问本机",
  changed: "已保存 · 更改待应用",
  error: "异常 · 端口暂不可用",
  reconnecting: "断线 · 自动重连中",
};

export const AUTO_OPTIONS: { value: AutoMode; label: string; hint: string }[] = [
  { value: "off", label: "仅手动开启", hint: "需要时在这里开启" },
  { value: "ask", label: "连接终端时询问", hint: "由你决定是否同时开启" },
  { value: "connect", label: "连接终端时开启", hint: "连接后直接开启手动转发" },
  { value: "launch", label: "随 CC Bridge 启动", hint: "使用已保存的登录信息" },
];

export function emptyValues(purpose: Purpose): Values {
  return {
    purpose, targetPort: "", accessPort: purpose === "dynamic" ? "1080" : "",
    targetHost: "127.0.0.1", listenHost: "127.0.0.1", name: "",
  };
}

export function sampleRule(phase: Phase = "running"): Rule {
  return {
    id: "company-local-service",
    values: { purpose: "remote", targetPort: "7823", accessPort: "7824", targetHost: "127.0.0.1", listenHost: "127.0.0.1", name: "本机服务" },
    phase,
  };
}

export function initialRules(scenario: Scenario): Rule[] {
  if (scenario === "first" || scenario === "local" || scenario === "remote") return [];
  const rule = sampleRule(scenario === "error" ? "error" : scenario === "reconnecting" ? "reconnecting" : "running");
  if (scenario === "changed") rule.pending = { ...rule.values, accessPort: "7825" };
  return [rule];
}

export function usageAddress(values: Values): string {
  const host = ["0.0.0.0", "::", "*", ""].includes(values.listenHost) ? "127.0.0.1" : values.listenHost;
  return (host.includes(":") ? "[" + host + "]" : host) + ":" + values.accessPort;
}

const validPort = (value: string) => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535;
const sameListenerSide = (a: Purpose, b: Purpose) => (a === "remote") === (b === "remote");

export function conflictFor(values: Values, rules: Rule[], editingId?: string): string | null {
  if (!values.accessPort) return null;
  if (values.purpose === "remote" && values.accessPort === "7823") return "端口 7823 已由 Claude Code 隧道管理。请使用其他访问端口。";
  if (rules.some(rule => rule.id !== editingId && sameListenerSide(rule.values.purpose, values.purpose) && rule.values.accessPort === values.accessPort)) {
    return "访问端口 " + values.accessPort + " 已有一条转发规则，请换一个端口。";
  }
  if (values.purpose !== "remote" && values.accessPort === "3306") return "本机端口 3306 暂时无法使用，建议换一个访问端口。";
  return null;
}

export function suggestedPort(values: Values, rules: Rule[], editingId?: string): string {
  let candidate = Math.max(1024, Number(values.accessPort) || Number(values.targetPort) || 3000);
  do { candidate++; } while (candidate <= 65535 && conflictFor({ ...values, accessPort: String(candidate) }, rules, editingId));
  return candidate <= 65535 ? String(candidate) : "3001";
}

export function validate(values: Values, rules: Rule[], editingId?: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (values.purpose !== "dynamic" && !validPort(values.targetPort)) errors.targetPort = "请输入服务的端口，范围为 1–65535。";
  if (!validPort(values.accessPort)) errors.accessPort = "请输入访问端口，范围为 1–65535。";
  else {
    const conflict = conflictFor(values, rules, editingId);
    if (conflict) errors.accessPort = conflict;
  }
  if (values.purpose !== "dynamic" && !values.targetHost.trim()) errors.targetHost = "请输入服务地址。";
  return errors;
}
