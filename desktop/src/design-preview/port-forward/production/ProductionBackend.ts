import type { ForwardRule, SshConnection, SshConnectionList, TunnelStatus } from "../../../lib/types";
import { manualForwardDraft, type ForwardContext } from "../../../lib/forwardOwnership";

export const SCENES = { empty: "首次添加", running: "已开启", pending: "配置待应用", reconnecting: "自动重连", failed: "部分监听失败", allocated: "服务器分配端口", paused: "隧道已暂停", readError: "读取失败" };
export type Scene = keyof typeof SCENES;
const managedRule: ForwardRule = { id: "managed", kind: "remote", enabled: true, listenHost: "127.0.0.1", listenPort: 7823, targetHost: "127.0.0.1", targetPort: 7823, note: "Claude Code" };
const webpage: ForwardRule = { ...managedRule, id: "web", kind: "local", listenPort: 3000, targetPort: 3000, note: "开发网页" };
const reverse: ForwardRule = { ...managedRule, id: "reverse", listenPort: 7824, targetPort: 7823, note: "本机服务" };
const handlers = new Map<string, Set<(payload: unknown) => void>>();
let scene: Scene = "empty", connection: SshConnection, runtime: TunnelStatus | null = null, timer: ReturnType<typeof setTimeout>;
let saveFails = false, startFails = false;
const calls: { command: string; args: unknown }[] = [];
const emit = (event: string, payload: unknown = {}) => { for (const handler of handlers.get(event) ?? []) handler(payload); };
export function reset(next: Scene) {
  clearTimeout(timer); scene = next; saveFails = false; startFails = false; calls.length = 0;
  connection = { id: "preview-server", name: "公司", host: "server.example", port: 22, username: "dev", authType: "password", rememberPassword: true, encryptedPassword: "fixture-ciphertext", keyPath: "", rememberPassphrase: false, encryptedPassphrase: "", proxyJumpId: "", forwards: next === "empty" || next === "paused" || next === "readError" ? [] : [webpage, reverse], forwardAuto: "ask" };
  runtime = connection.forwards!.length ? { connectionId: connection.id, state: next === "reconnecting" ? "reconnecting" : "up", message: null, needsSecret: false,
    rules: connection.forwards!.map(rule => ({ rule: { ...rule }, state: "listening", boundPort: rule.listenPort, message: null })) } : null;
  if (next === "pending") connection.forwards![0] = { ...webpage, listenPort: 3001 };
  if (next === "failed") runtime!.rules[1] = { ...runtime!.rules[1], state: "failed", message: "服务器访问端口暂时被其他服务占用。", boundPort: null };
  if (next === "allocated") {
    connection.forwards = [{ ...reverse, listenPort: 0 }];
    runtime!.rules = [{ rule: connection.forwards[0], state: "listening", boundPort: 32123, message: null }];
  }
  emit("ssh_tunnel_status", runtime ?? { connectionId: connection.id, state: "stopped", rules: [], message: null, needsSecret: false });
  emit("stable_connect_changed");
}
const context = (): ForwardContext => {
  const managed = [{ connectionId: connection.id, rule: managedRule, phase: scene === "paused" ? "stopped" as const : "ready" as const, enabled: scene !== "paused", message: null }];
  const classified = manualForwardDraft(connection.forwards ?? [], { managed } as ForwardContext);
  return { connectionId: connection.id, forwardAuto: connection.forwardAuto ?? "ask", managed, managedRuleIds: [], manualRules: classified.manualRules, conflicts: classified.conflicts, manualStatus: runtime };
};
export function getConnection(): SshConnection { return structuredClone(connection); }
export function getCalls() { return structuredClone(calls); }
export function failSave(value: boolean) { saveFails = value; }
export function failStart(value: boolean) { startFails = value; }
export function recoverRead() { scene = "empty"; }
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const set = handlers.get(event) ?? new Set(); set.add(handler as (payload: unknown) => void); handlers.set(event, set);
  return () => set.delete(handler as (payload: unknown) => void);
}
export async function invoke<T = unknown>(command: string, args?: { args?: { connection: SshConnection }; connectionId?: string }): Promise<T> {
  calls.push({ command, args });
  if (command === "ssh_list_connections") return structuredClone({ enabled: true, connections: [connection] } satisfies SshConnectionList) as T;
  if (command === "ssh_forward_context") { if (scene === "readError") throw new Error("模拟读取失败"); return structuredClone(context()) as T; }
  if (command === "ssh_tunnel_list") return structuredClone(runtime ? [runtime] : []) as T;
  if (command === "ssh_save_connection") { if (saveFails) throw new Error("模拟保存失败"); connection = structuredClone(args!.args!.connection); return undefined as T; }
  if (command === "ssh_tunnel_start") {
    if (startFails) throw new Error("模拟开启失败");
    clearTimeout(timer);
    runtime = { connectionId: connection.id, state: "connecting", message: null, needsSecret: false, rules: context().manualRules.filter(rule => rule.enabled).map(rule => ({ rule, state: "pending", boundPort: null, message: null })) };
    emit("ssh_tunnel_status", structuredClone(runtime));
    timer = setTimeout(() => {
      runtime = { ...runtime!, state: "up", rules: runtime!.rules.map(entry => ({ ...entry, state: "listening", boundPort: entry.rule.listenPort || 32123 })) };
      emit("ssh_tunnel_status", structuredClone(runtime));
    }, 450);
    return structuredClone(runtime) as T;
  }
  if (command === "ssh_tunnel_stop") { clearTimeout(timer); runtime = null; emit("ssh_tunnel_status", { connectionId: connection.id, state: "stopped", rules: [], message: null, needsSecret: false }); return undefined as T; }
  if (command === "stable_connect_select") return undefined as T;
  throw new Error("未提供预览命令：" + command);
}
