import type { SshConnection, StaticStatus } from "./types";
import type { StableConnection, StableSetup } from "./stableConnect";
import { NON_SHELL_TOOLS, type McpScope } from "./utils";

/**
 * 隧道接入地址只在「这个端口真的会被服务器监听」之后才成立。
 *
 * 🔴 配置完成前 `record.port` 是占位值（首次接入时连 record 都没有），早先回退到
 * `status.port`（本机服务端口，如 7823）就会让用户抄到一个必然连不上的地址：
 * 服务器实际监听的是服务器按账号分配的端号（17900 段），和本机端口毫无关系。
 * 所以这里只认两种证据：已写过远端配置（configured），或已走到「应用配置」步（step ≥ 3）。
 *
 * 定义在 stableAccess 而不是 stableConnect：后者已经值引用本模块（stableShellQuote），
 * 若反过来再值引用回去就成环了。本模块对 stableConnect 只有 type 引用，方向单一。
 */
export function stableConfirmedPort(record?: { port?: number; configured?: boolean; step?: number }): number | undefined {
  if (!record) return;
  if (!record.configured && (record.step ?? 0) < 3) return;
  const port = record.port ?? 0;
  return port >= 1024 ? port : undefined;
}

export type StableTargetScope = "user" | "project" | "local";
export interface StableTarget {
  id: string; name: string; scope: StableTargetScope; projectPath: string; projectKey: string | null;
  configFile: string; url: string; fingerprint: string; recognized: boolean; tokenMatches: boolean;
}
export interface StableConfigProof { scope: "user" | "project"; projectPath: string; configFile: string; fingerprint: string }
export interface StableInspection { signature: string; complete: boolean; files: StableConfigProof[] }
export interface StableAccessRequest { target: StableTarget | null; inspection: StableInspection; scopeChange?: boolean; tunnelPort?: number | null }
export interface StableProject { name: string; path: string }
export interface StableDiscovery extends StableInspection {
  home: string; inspectedProjectPath: string | null; projects: StableProject[]; targets: StableTarget[]; warnings: string[];
  /** 服务器按账号分配的固定隧道端口；共享服务器上每账号一个，老服务器不返回。 */
  tunnelPort?: number | null;
}
export interface StableFolders {
  signature: string; home: string; path: string; parent: string; directories: StableProject[]; truncated: boolean;
}

export const stableScopeLabel = (scope: StableTargetScope) => scope === "user" ? "所有项目可用" : scope === "local" ? "项目级 · 旧版配置" : "项目级";
export const stableProjectName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;
export const stableTargetTitle = (target: StableTarget) => target.scope === "user" ? "所有项目" : stableProjectName(target.projectPath);
export const stableFixedUrl = (port: number) => `http://127.0.0.1:${port}/mcp`;
export const stableShellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Temporary credentials can override unreadable saved secrets without replacing the saved connection. */
export const stableNeedsLogin = (message: string) => /需要登录|需要密码|Permission denied|authentication|解密密码失败|解密密钥密码短语失败/i.test(message);

/** A custom/legacy MCP name must also be used by the optional permission command. */
export function buildStablePermissionCommand(scope: McpScope, path: string, includeShell: boolean, name: string): string {
  if (!name || scope === "project" && !path) return "";
  const source = `import json,os,sys
try: sys.stdout.reconfigure(errors='replace')
except Exception: pass
name,scope,include_shell=json.loads(sys.argv[1])
p=os.path.join(os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude'),'settings.json') if scope=='user' else '.claude/settings.local.json'
d=json.load(open(p,encoding='utf-8-sig')) if os.path.exists(p) else {}
allow=d.setdefault('permissions',{}).setdefault('allow',[])
tools=['*'] if include_shell else ${JSON.stringify(NON_SHELL_TOOLS)}
for tool in tools:
    rule='mcp__'+name+'__'+tool
    if rule not in allow: allow.append(rule)
servers=d.setdefault('enabledMcpjsonServers',[])
if name not in servers: servers.append(name)
os.makedirs(os.path.dirname(p),exist_ok=True)
with open(p,'w',encoding='utf-8') as f: json.dump(d,f,indent=2,ensure_ascii=False)
print('已写入:',os.path.abspath(p))`;
  const command = `python3 -c ${stableShellQuote(source)} ${stableShellQuote(JSON.stringify([name, scope, includeShell]))}`;
  const directory = path === "~" ? '"$HOME"' : path.startsWith("~/") ? `"$HOME"/${stableShellQuote(path.slice(2))}` : stableShellQuote(path);
  return scope === "project" ? `cd ${directory} && ${command}` : command;
}

/** Discovery can show suggestions, but uncertainty never authorizes an automatic overwrite. */
export function chooseStableTarget(result: StableDiscovery, preferredId?: string): StableTarget | undefined {
  if (!result.complete) return;
  const preferred = result.targets.find(target => target.id === preferredId);
  if (preferred) return preferred;
  if (result.targets.length === 1 && result.targets[0].recognized) return result.targets[0];
}

export function stableSavedSetup(record?: StableConnection): StableSetup {
  return { scope: record?.scope ?? "user", projectPath: record?.projectPath ?? "", multiDevice: record?.multiDevice ?? false };
}

/** Local identity guard only; this value is never a query key or serialized into the page. */
export function stableAccessIdentity(id: string, servers: SshConnection[], status?: StaticStatus): string {
  const connection = servers.find(server => server.id === id);
  const identity = (server?: SshConnection) => server && [server.id, server.host, server.port, server.username, server.authType, server.keyPath, server.proxyJumpId];
  return JSON.stringify([id, identity(connection), identity(servers.find(server => server.id === connection?.proxyJumpId)), status?.host, status?.port, status?.transport, status?.deviceId, status?.token]);
}
