export const discoveryScenarios = {
  "existing-project": "已有 IP 接入 · 改用隧道连接",
  "existing-global": "已接入 · 所有项目",
  "existing-local": "已接入 · 旧版项目配置",
  multiple: "已接入 · 多个项目",
  "first-time": "首次接入 · 选择项目",
  "current-directory": "首次接入 · 使用当前目录",
  uncertain: "旧接入 · 需要确认",
  unavailable: "检查失败 · 选择项目重试",
  "token-changed": "升级连接 · Token 已变化",
} as const;
export type DiscoveryScenario = keyof typeof discoveryScenarios;
export type PreviewScope = "user" | "project" | "local";
export interface Project { name: string; path: string; recent: string }
export interface BridgeEntry {
  id: string; name: string; title: string; scope: PreviewScope; projectPath: string;
  url: string; configFile: string; recognized: boolean; tokenMatches: boolean;
}
export interface ConnectionPlan {
  entry: BridgeEntry; before: string | null; after: string;
  action: "setup" | "upgrade"; tokenUpdate: boolean; changed: boolean;
}
export interface DiscoveryState {
  phase: "checking" | "found" | "choose" | "empty" | "failed" | "applying" | "complete";
  entries: BridgeEntry[]; projects: Project[]; selectedId: string | null;
  scope: "user" | "project"; project: Project | null; currentPath: string | null;
  scanPath: string | null; failCheck: boolean; step: number;
  pending: ConnectionPlan | null; result: ConnectionPlan | null;
}
export const scopeLabel = (scope: PreviewScope) => scope === "user" ? "所有项目" : scope === "local" ? "当前项目 · 旧版配置" : "仅这个项目";
export const projectFromPath = (path: string, projects: Project[]): Project => projects.find(p => p.path === path) ?? { name: path.split("/").filter(Boolean).slice(-1)[0] ?? "根目录", path, recent: "手动选择" };
export function initialDiscovery(scenario: DiscoveryScenario, serverId = "cloud"): DiscoveryState {
  const root = serverId === "dev" ? "/srv/projects" : "/home/ubuntu/projects";
  const projects = [
    { name: "订单系统", path: `${root}/orders`, recent: "最近使用 · 今天" },
    { name: "网站项目", path: `${root}/website`, recent: "最近使用 · 昨天" },
    { name: "自动化脚本", path: `${root}/automation`, recent: "已保存的项目" },
  ];
  const entry = (index: number, scope: PreviewScope = "project"): BridgeEntry => ({
    id: scope === "user" ? "global-bridge" : `project-${index}`, name: "cc-bridge",
    title: scope === "user" ? "所有项目" : projects[index].name, scope,
    projectPath: scope === "user" ? "" : projects[index].path,
    url: "http://192.168.31.81:7823/mcp",
    configFile: scope === "project" ? `${projects[index].path}/.mcp.json` : "~/.claude.json",
    recognized: true, tokenMatches: true,
  });
  let entries = [entry(0)];
  if (serverId === "dev" || scenario === "first-time" || scenario === "current-directory") entries = [];
  else if (scenario === "existing-global") entries = [entry(0, "user")];
  else if (scenario === "existing-local") entries = [entry(0, "local")];
  else if (scenario === "multiple") entries = [entry(0), entry(1), entry(0, "user")];
  else if (scenario === "uncertain") entries = [{ ...entry(0), name: "bridge-tools", recognized: false }];
  else if (scenario === "token-changed") entries = [{ ...entry(0), tokenMatches: false }];
  return {
    phase: "checking", entries, projects, selectedId: null, scope: "user", project: null,
    currentPath: scenario === "current-directory" ? projects[1].path : null,
    scanPath: null, failCheck: scenario === "unavailable", step: 0, pending: null, result: null,
  };
}
export const visibleEntries = (state: DiscoveryState) => state.scanPath ? state.entries.filter(e => e.projectPath === state.scanPath) : state.entries;
export const selectedEntry = (state: DiscoveryState) => state.entries.find(e => e.id === state.selectedId) ?? null;
export function connectionPlan(state: DiscoveryState, port: number): ConnectionPlan | null {
  if (state.phase !== "found" && state.phase !== "empty") return null;
  const old = selectedEntry(state);
  if (!old && state.scope === "project" && !state.project) return null;
  const projectPath = state.scope === "project" ? state.project?.path ?? "" : "";
  const entry: BridgeEntry = old ?? {
    id: `new-${state.scope}-${projectPath}`, name: "cc-bridge", title: state.project?.name ?? "所有项目",
    scope: state.scope, projectPath, url: "", configFile: projectPath ? `${projectPath}/.mcp.json` : "~/.claude.json",
    recognized: true, tokenMatches: true,
  };
  const after = `http://127.0.0.1:${port}/mcp`;
  return {
    entry, before: old?.url ?? null, after,
    action: old ? "upgrade" : "setup",
    tokenUpdate: !!old && !old.tokenMatches, changed: !old || old.url !== after || !old.tokenMatches,
  };
}
export const actionLabel = (plan: ConnectionPlan | null) => !plan ? "一键接入" : !plan.changed ? "已使用固定地址" : plan.action === "setup" ? "一键接入" : "改用隧道连接";
export const progressLabels = (plan: ConnectionPlan) => ["连接服务器", plan.action === "setup" ? "配置隧道连接" : "升级原有接入", "检查配置"];
export type DiscoveryAction =
  | { type: "tick" } | { type: "retry" } | { type: "configure" } | { type: "other-project" } | { type: "token" }
  | { type: "server"; scenario: DiscoveryScenario; serverId: string }
  | { type: "select"; id: string } | { type: "scope"; scope: "user" | "project" }
  | { type: "project"; project: Project } | { type: "apply"; port: number };
const chooseEntry = (state: DiscoveryState, entry: BridgeEntry): DiscoveryState => ({
  ...state, phase: "found", selectedId: entry.id, scope: entry.scope === "user" ? "user" : "project",
  project: entry.projectPath ? projectFromPath(entry.projectPath, state.projects) : null, result: null,
});
export function discoveryReducer(state: DiscoveryState, action: DiscoveryAction): DiscoveryState {
  if (action.type === "server") return initialDiscovery(action.scenario, action.serverId);
  if (action.type === "token") return { ...state, entries: state.entries.map(e => ({ ...e, tokenMatches: false })) };
  if (action.type === "tick") {
    if (state.phase === "checking") {
      if (state.failCheck) return { ...state, phase: "failed" };
      const entries = visibleEntries(state);
      // A shared port cannot identify a bridge. Unknown names always require an explicit choice.
      if (entries.length === 1 && entries[0].recognized) return chooseEntry(state, entries[0]);
      return { ...state, phase: entries.length ? "choose" : "empty", selectedId: null };
    }
    if (state.phase !== "applying" || !state.pending) return state;
    if (state.step < 2) return { ...state, step: state.step + 1 };
    const entry = { ...state.pending.entry, url: state.pending.after, tokenMatches: true, recognized: true };
    // The preview replaces only the selected entry; neighboring MCP entries keep their identity and scope.
    const entries = state.entries.some(e => e.id === entry.id) ? state.entries.map(e => e.id === entry.id ? entry : e) : [...state.entries, entry];
    return { ...state, phase: "complete", step: 3, entries, selectedId: entry.id, result: state.pending, pending: null };
  }
  if (state.phase === "applying") return state;
  if (action.type === "retry") return { ...state, phase: "checking", failCheck: false, selectedId: null, result: null };
  if (action.type === "select") { const entry = visibleEntries(state).find(e => e.id === action.id); return entry ? chooseEntry(state, entry) : state; }
  if (action.type === "configure") return { ...state, phase: selectedEntry(state) ? "found" : "empty", result: null };
  if (action.type === "other-project") return { ...state, phase: "empty", selectedId: null, scope: "project", project: null, scanPath: null, result: null };
  if (action.type === "scope") {
    const global = action.scope === "user" ? state.entries.find(e => e.scope === "user" && e.recognized) : null;
    return global ? chooseEntry(state, global) : { ...state, phase: "empty", scope: action.scope, selectedId: null, project: null, scanPath: null };
  }
  if (action.type === "project") {
    const next = { ...state, scope: "project" as const, project: action.project, scanPath: action.project.path, selectedId: null, result: null };
    if (state.phase === "failed") return { ...next, phase: "checking", failCheck: false };
    const matches = visibleEntries(next);
    return matches.length === 1 && matches[0].recognized ? chooseEntry(next, matches[0]) : { ...next, phase: matches.length ? "choose" : "empty" };
  }
  if (action.type === "apply") {
    const plan = connectionPlan(state, action.port);
    return plan?.changed ? { ...state, phase: "applying", step: 0, pending: plan, result: null } : state;
  }
  return state;
}
export function folderChildren(path: string, projects: Project[]): string[] {
  const prefix = path === "/" ? "/" : `${path}/`;
  const children = new Set(projects.filter(p => p.path.startsWith(prefix)).map(p => p.path.slice(prefix.length).split("/")[0]).filter(Boolean));
  if (projects.some(p => p.path === path)) ["src", "docs", "tests"].forEach(name => children.add(name));
  return [...children].sort();
}
