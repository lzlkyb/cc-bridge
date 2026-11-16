import type { StableConnectSnapshot, StableConnection } from "../../lib/stableConnect";
import type { StatusResponse } from "../../lib/types";
import type { Scenario } from "./model";
import { discoveryScenarios, folderChildren, initialDiscovery, type DiscoveryScenario } from "./discovery";
import { stableProjectName, type StableAccessRequest, type StableDiscovery, type StableFolders, type StableTarget } from "../../lib/stableAccess";
import type { LinkageScenario } from "./linkage/model";

let scenario: Scenario = "normal";
let snapshot: StableConnectSnapshot = { method: "stable", selectedConnectionId: "cloud", connections: [] };
let revision = 0;
let previousSetup: { id: string; record?: StableConnection } | undefined;
const listeners = new Set<() => void>();
const targetsByServer = new Map<string, StableTarget[]>();
const configuredTokens = new Map<string, string>();
const emit = () => { for (const listener of listeners) listener(); };
const read = () => structuredClone(snapshot);
export const productionPreviewQuery = () => new URLSearchParams(location.search || document.documentElement.dataset.previewQuery || "");
export function resetProductionFixture(next: Scenario) {
  scenario = next; revision++;
  previousSetup = undefined;
  targetsByServer.clear(); configuredTokens.clear();
  const query = productionPreviewQuery();
  snapshot = { method: query.get("method") === "direct" ? "direct" : "stable", selectedConnectionId: next === "first" ? null : "cloud", connections: [] };
  if (["returning", "recovery", "interrupted", "paused", "changed"].includes(next)) {
    snapshot.connections = [{ connectionId: "cloud", port: 7823, scope: "user", projectPath: "", multiDevice: false, configured: true, enabled: next !== "paused",
      phase: next === "paused" ? "stopped" : next === "interrupted" ? "error" : next === "recovery" ? "reconnecting" : "ready", step: 0, message: next === "interrupted" ? "请输入服务器登录密码" : null, needsSecret: next === "interrupted", configMatches: next !== "changed" }];
    if (query.has("configuredScope")) {
      const entry = initialDiscovery(query.get("configuredScope") === "user" ? "existing-global" : "existing-project", "cloud").entries[0];
      const target: StableTarget = { ...entry, projectKey: null, configFile: entry.configFile.replace("~", "/home/ubuntu"),
        url: "http://127.0.0.1:7823/mcp", fingerprint: "b".repeat(64) };
      Object.assign(snapshot.connections[0], { scope: target.scope, projectPath: target.projectPath, target });
      targetsByServer.set("cloud", [target]);
    }
    if (next === "recovery" && query.get("view") !== "linkage") { const current = revision; setTimeout(() => { if (current === revision) { snapshot.connections[0].phase = "ready"; emit(); } }, 5000); }
  }
  emit();
}
// These setters only affect the isolated design fixture, never native configuration.
export function prepareLinkageFixture(next: LinkageScenario) {
  const legacy: Scenario = next === "setup" || next === "server" ? "normal" : next === "recovery" ? "recovery" : next === "paused" ? "paused" : next === "login" ? "interrupted" : next === "changed" ? "changed" : "returning";
  resetProductionFixture(legacy);
  snapshot.method = next === "direct" || next === "ip-changed" ? "direct" : "stable";
  snapshot.selectedConnectionId = next === "server" ? "dev" : "cloud";
  for (const record of snapshot.connections) {
    const source = initialDiscovery("existing-project", record.connectionId).entries[0];
    const target: StableTarget = { ...source, projectKey: null, configFile: source.configFile.replace("~", "/home/ubuntu"), url: "http://127.0.0.1:7823/mcp", fingerprint: "b".repeat(64), tokenMatches: next !== "changed" };
    Object.assign(record, { scope: "project", projectPath: target.projectPath, target });
    targetsByServer.set(record.connectionId, [target]);
  }
  if (snapshot.method === "direct") snapshot.connections = [];
  emit();
}
export function recoverLinkageFixture() {
  const record = snapshot.connections.find(c => c.connectionId === snapshot.selectedConnectionId);
  if (record?.phase === "reconnecting") { record.phase = "ready"; emit(); }
}
export function invalidateLinkageFixture(tokenChanged: boolean) {
  for (const record of snapshot.connections) {
    record.configMatches = false;
    if (tokenChanged && record.target) record.target.tokenMatches = false;
  }
  emit();
}
export function listenProductionFixture(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function inspectionFixture(id: string, path: string | null, status: StatusResponse, sourcePath: string | null = null): StableDiscovery {
  const query = productionPreviewQuery();
  const requested = query.get("accessCase") ?? query.get("scenario") ?? "existing-project";
  const next: DiscoveryScenario = query.get("view") === "linkage" && snapshot.connections.length === 0 && snapshot.method === "stable" ? "first-time" : requested in discoveryScenarios ? requested as DiscoveryScenario : scenario === "first" ? "first-time" : "existing-project";
  const model = initialDiscovery(next, id);
  const home = id === "dev" ? "/home/developer" : "/home/ubuntu";
  if (!targetsByServer.has(id)) targetsByServer.set(id, model.entries.map(entry => ({
    id: entry.id, name: entry.name, scope: entry.scope, projectPath: entry.projectPath,
    projectKey: entry.scope === "local" ? `${entry.projectPath}/` : null,
    configFile: entry.configFile.replace("~", home), url: entry.url, fingerprint: "a".repeat(64), recognized: entry.recognized, tokenMatches: entry.tokenMatches,
  })));
  const targets = targetsByServer.get(id)!;
  const saved = snapshot.connections.find(record => record.connectionId === id)?.target;
  const entries = saved && !targets.some(target => target.id === saved.id) ? [...targets, saved] : targets;
  const projects = model.projects.map(project => ({ name: stableProjectName(project.path), path: project.path }));
  const paths = [...new Set([...(sourcePath === null ? projects.map(project => project.path) : sourcePath ? [sourcePath] : []), ...(path ? [path] : [])])];
  return { signature: `preview-${id}`, complete: next !== "unavailable" || !!path, home, inspectedProjectPath: path,
    projects, targets: entries.filter(target => !path || target.scope === "user" || target.projectPath === path || target.projectPath === sourcePath)
      .map(target => ({ ...target, tokenMatches: configuredTokens.has(target.id) ? configuredTokens.get(target.id) === status.token : target.tokenMatches })),
    warnings: next === "unavailable" && !path ? ["一个已知项目暂时无法读取，可以选择一个项目后重新检查。"] : [],
    files: [{ scope: "user", projectPath: "", configFile: `${home}/.claude.json`, fingerprint: "f".repeat(64) },
      ...paths.map(path => ({ scope: "project" as const, projectPath: path, configFile: `${path}/.mcp.json`, fingerprint: "f".repeat(64) }))] };
}
export async function invokeProductionFixture(command: string, args: Record<string, unknown> | undefined, status: StatusResponse) {
  if (command === "stable_connect_get") return read();
  if (command === "stable_connect_select") { snapshot.method = args?.method as StableConnectSnapshot["method"]; snapshot.selectedConnectionId = (args?.connectionId as string) || null; emit(); return read(); }
  const id = args?.connectionId as string;
  if (command === "stable_connect_inspect" || command === "stable_connect_folders") {
    await new Promise(resolve => setTimeout(resolve, 350));
    if (["password", "interrupted"].includes(scenario) && !args?.password && !args?.passphrase) throw new Error("需要登录服务器，请输入登录密码或密钥口令后重新检查。");
    const result = inspectionFixture(id, args?.projectPath as string | null, status, args?.sourceProjectPath as string | null ?? null);
    if (command === "stable_connect_inspect") return result;
    const path = args?.path as string || result.home;
    const model = initialDiscovery("first-time", id);
    const names = folderChildren(path, model.projects);
    const listing: StableFolders = { signature: result.signature, home: result.home, path, parent: path.split("/").slice(0, -1).join("/") || "/",
      directories: names.map(name => ({ name, path: `${path === "/" ? "" : path}/${name}` })), truncated: false };
    return listing;
  }
  if (command === "stable_connect_stop") { revision++; const record = snapshot.connections.find(c => c.connectionId === id); if (record) Object.assign(record, { phase: "stopped", enabled: false }); emit(); return read(); }
  if (command === "stable_connect_cancel") {
    const running = snapshot.connections.find(c => c.connectionId === id && c.phase === "running");
    if (running && previousSetup?.id === id) {
      revision++;
      snapshot.connections = snapshot.connections.map(c => c === running ? previousSetup?.record ?? { ...running, phase: "stopped", enabled: false } : c);
      previousSetup = undefined;
      emit();
    }
    return;
  }
  if (command !== "stable_connect_start") throw new Error(`未知的预览操作：${command}`);
  const current = ++revision;
  const prior = snapshot.connections.find(c => c.connectionId === id);
  previousSetup = { id, record: prior };
  const record: StableConnection = { connectionId: id, port: prior?.port || 7823, scope: args?.scope as StableConnection["scope"], projectPath: args?.projectPath as string, multiDevice: !!args?.multiDevice,
    phase: "running", step: 0, configured: prior?.configured ?? false, enabled: true, needsSecret: false, configMatches: true, message: null };
  snapshot.connections = [...snapshot.connections.filter(c => c.connectionId !== id), record]; snapshot.selectedConnectionId = id;
  emit();
  for (let step = 0; step < 5; step++) {
    await new Promise(resolve => setTimeout(resolve, 650));
    if (current !== revision) return read();
    if (step === 1 && ["password", "interrupted"].includes(scenario) && !args?.password && !args?.passphrase) { Object.assign(record, { phase: "error", needsSecret: true, message: "需要密码或密钥口令" }); emit(); return read(); }
    if (step === 1 && scenario === "missing") { Object.assign(record, { phase: "error", message: "服务器尚未安装 Claude Code，请安装后重新检测。" }); scenario = "normal"; emit(); return read(); }
    if (step === 2 && scenario === "denied") { Object.assign(record, { phase: "error", message: "服务器不允许端口转发，请管理员允许后重新检测。" }); scenario = "normal"; emit(); return read(); }
    if (step === 2 && scenario === "occupied" && !record.configured) record.port = 17823;
    record.step = step; emit();
  }
  Object.assign(record, { phase: "ready", configured: true });
  const access = args?.access as StableAccessRequest | null;
  if (access) {
    const placement = access.scopeChange ? { id: `moved-${id}-${record.scope}-${record.projectPath}`, scope: record.scope,
      projectPath: record.projectPath, projectKey: null, configFile: record.scope === "user" ? `/home/${id === "dev" ? "developer" : "ubuntu"}/.claude.json` : `${record.projectPath}/.mcp.json` } : {};
    const target: StableTarget = access.target ? { ...access.target, ...placement } : {
      id: `new-${id}-${record.scope}-${record.projectPath}`, name: record.multiDevice ? `cc-bridge-${status.deviceId}` : "cc-bridge", scope: record.scope,
      projectPath: record.projectPath, projectKey: null, configFile: record.scope === "user" ? `/home/${id === "dev" ? "developer" : "ubuntu"}/.claude.json` : `${record.projectPath}/.mcp.json`,
      url: "", fingerprint: "a".repeat(64), recognized: true, tokenMatches: true,
    };
    Object.assign(target, { url: `http://127.0.0.1:${record.port}/mcp`, fingerprint: "b".repeat(64), tokenMatches: true });
    record.target = target; configuredTokens.set(target.id, status.token);
    const old = targetsByServer.get(id) ?? [];
    targetsByServer.set(id, [...old.filter(entry => entry.id !== target.id && entry.id !== access.target?.id), target]);
  } else record.target = prior?.target;
  emit(); return read();
}
