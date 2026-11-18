import type { ForwardAuto, ForwardRule, TunnelStatus } from "./types";
import type { StableConnection } from "./stableConnect";

export interface ManagedForward {
  connectionId: string;
  rule: ForwardRule;
  phase: StableConnection["phase"];
  enabled: boolean;
  message: string | null;
}
export interface ForwardConflict { ruleId: string; message: string }
export interface ForwardContext {
  connectionId: string;
  forwardAuto: ForwardAuto;
  managed: ManagedForward[];
  manualRules: ForwardRule[];
  managedRuleIds: string[];
  conflicts: ForwardConflict[];
  manualStatus?: TunnelStatus | null;
}

function hostKey(value: string): string {
  const host = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (host.includes(":")) {
    try { return new URL(`http://[${host}]`).hostname.slice(1, -1); } catch { /* An incomplete draft remains editable. */ }
  }
  return host;
}

export function sameForwardRoute(a: ForwardRule, b: ForwardRule): boolean {
  return a.kind === b.kind && a.listenPort === b.listenPort && a.targetPort === b.targetPort
    && hostKey(a.listenHost) === hostKey(b.listenHost) && hostKey(a.targetHost) === hostKey(b.targetHost);
}

/** 两个监听地址是否可能抢同一个绑定（回环家族 / 通配 / 0.0.0.0 与 IPv4）。 */
export function hostsOverlap(a: string, b: string): boolean {
  a = hostKey(a); b = hostKey(b);
  if (a === b || ["", "*", "::"].includes(a) || ["", "*", "::"].includes(b)) return true;
  const loopback = (h: string) => h === "localhost" || h === "::1" || /^127\./.test(h);
  if ((a === "localhost" || b === "localhost") && loopback(a) && loopback(b)) return true;
  const ipv4 = (h: string) => h === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(h);
  return (a === "0.0.0.0" && ipv4(b)) || (b === "0.0.0.0" && ipv4(a));
}

/** Draft classification controls the UI; every actual start is checked again by the backend. */
export function manualForwardDraft(rules: ForwardRule[], context?: ForwardContext) {
  const managed = context?.managed ?? [];
  const manualRules = rules.filter(r => !managed.some(m => sameForwardRoute(r, m.rule)));
  const conflicts = manualRules.filter(r => r.enabled && r.listenPort !== 0 && managed.some(m =>
    r.listenPort === m.rule.listenPort && (r.kind === "remote") === (m.rule.kind === "remote")
    && hostsOverlap(r.listenHost, m.rule.listenHost)))
    .map(r => ({ ruleId: r.id, message: `端口 ${r.listenPort} 已由 Claude Code 隧道管理，请修改端口或停用这条规则。` }));
  return { manualRules, conflicts, managedCount: rules.length - manualRules.length };
}

export const managedForwardLabel = (managed: ManagedForward): string => {
  if (!managed.enabled && managed.phase !== "running") return "已暂停";
  return { idle: "待连接", running: "配置中", ready: "已连通", reconnecting: "重连中", error: "需处理", stopped: "未连接" }[managed.phase];
};

export function manualForwardStatus(status: TunnelStatus | undefined, context?: ForwardContext): TunnelStatus | undefined {
  if (!status) return undefined;
  const rules = status.rules.filter(r => !context?.managed.some(m => sameForwardRoute(r.rule, m.rule)));
  return rules.length ? { ...status, rules } : undefined;
}
