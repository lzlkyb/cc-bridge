export type Scenario = "normal" | "first" | "password" | "missing" | "occupied" | "denied" | "returning" | "interrupted" | "recovery" | "paused" | "changed";
export type Phase = "idle" | "running" | "ready" | "error" | "stopped" | "reconnecting";
export interface LinkState { phase: Phase; step: number; issue: "password" | "missing" | "denied" | null; port: number; repaired: boolean; callsSeen: boolean; configured: boolean }
export const initialLink = (): LinkState => ({ phase: "idle", step: 0, issue: null, port: 7823, repaired: false, callsSeen: false, configured: false });
export const compactLink = (state: LinkState, managing: boolean) => state.configured && state.phase !== "running" && !managing;
export function scenarioLinks(scenario: Scenario): Record<string, LinkState> {
  if (scenario === "paused") return { cloud: { ...initialLink(), phase: "stopped", configured: true } };
  if (scenario === "changed") return { cloud: { ...initialLink(), phase: "ready", step: 5, configured: true } };
  if (scenario === "returning") return { cloud: { ...initialLink(), phase: "ready", step: 5, configured: true } };
  if (scenario === "interrupted") return { cloud: { ...initialLink(), phase: "error", step: 1, issue: "password", configured: true } };
  if (scenario === "recovery") return { cloud: { ...initialLink(), phase: "reconnecting", configured: true } };
  return {};
}
export type Action = { type: "start"; port: number } | { type: "tick"; scenario: Scenario } | { type: "repair" } | { type: "stop" } | { type: "call" } | { type: "recheck" };
export function transition(state: LinkState, action: Action): LinkState {
  if (action.type === "stop") return { ...state, phase: "stopped", issue: null };
  if (action.type === "start") return state.phase === "running" ? state : { ...initialLink(), phase: "running", port: action.port, configured: state.configured };
  if (action.type === "call") return state.phase === "ready" ? { ...state, callsSeen: true } : state;
  if (action.type === "recheck") return { ...state, phase: "running", step: 4, issue: null, repaired: true };
  if (action.type === "repair") return state.phase === "error" ? { ...state, phase: "running", issue: null, repaired: true } : state;
  // Network recovery reuses the configured endpoint; it never allocates a different MCP URL.
  if (state.phase === "reconnecting") return state.step < 2 ? { ...state, step: state.step + 1 } : { ...state, phase: "ready", step: 5 };
  if (state.phase !== "running") return state;
  if (!state.repaired && state.step === 1 && ["password", "missing"].includes(action.scenario)) return { ...state, phase: "error", issue: action.scenario as "password" | "missing" };
  if (!state.repaired && state.step === 2 && action.scenario === "denied") return { ...state, phase: "error", issue: "denied" };
  if (!state.repaired && state.step === 2 && action.scenario === "occupied") return { ...state, port: 17823, repaired: true };
  return state.step === 4 ? { ...state, phase: "ready", step: 5, configured: true } : { ...state, step: state.step + 1 };
}
export const stepLabels = ["检查本机服务", "连接服务器", "建立加密通道", "配置 Claude Code", "验证接入"];
