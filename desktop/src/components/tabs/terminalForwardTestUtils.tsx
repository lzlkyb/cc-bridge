import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { TerminalForwardPanel } from "./TerminalForwardPanel";
import { ForwardOnConnectPrompt } from "./ForwardOnConnectPrompt";
import { dismissForwardOffer } from "../../lib/sshTunnelStore";
import { manualForwardDraft, sameForwardRoute, type ForwardContext } from "../../lib/forwardOwnership";
import type { ForwardRule, SshConnection, TunnelStatus } from "../../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), navigate: vi.fn(), back: vi.fn(), toast: vi.fn(), clipboard: vi.fn(), handlers: new Map<string, Set<(payload: unknown) => void>>() }));
export const h = mocks;
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke, listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
  const handlers = mocks.handlers.get(event) ?? new Set(); handlers.add(handler); mocks.handlers.set(event, handlers);
  return () => handlers.delete(handler);
}) }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
export const legacy: ForwardRule = { id: "legacy", kind: "remote", enabled: true, listenHost: "127.0.0.1", listenPort: 7823, targetHost: "127.0.0.1", targetPort: 7823, note: "旧转发" };
export const extra: ForwardRule = { ...legacy, id: "database", kind: "local", listenPort: 15432, targetPort: 5432, note: "数据库" };
export const fixture = { connection: {} as SshConnection, context: {} as ForwardContext, readFails: false, saveFails: false, startFails: false, stopFails: false };
let root: Root, host: HTMLDivElement, client: QueryClient, sequence = 0;
export const surface = () => host;
export function button(text: string, scope: ParentNode = host) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(control => control.textContent?.trim() === text || control.querySelector("strong")?.textContent?.trim() === text);
  expect(found, `找不到按钮：${text}`).toBeTruthy();
  return found!;
}
export async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); }
export async function mount(prompt = false) {
  await act(async () => root.render(<QueryClientProvider client={client}>{prompt ? <ForwardOnConnectPrompt /> : <TerminalForwardPanel conn={fixture.connection} onBack={h.back} onNavigate={h.navigate} />}</QueryClientProvider>));
  await settle();
}
export async function click(text: string, scope?: ParentNode) { await act(async () => button(text, scope).click()); await settle(); }
export async function input(selector: string, value: string) {
  await act(async () => {
    const control = host.querySelector<HTMLInputElement>(selector)!;
    expect(control).toBeTruthy();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
export async function emit(event: string, payload: unknown = {}) {
  await act(async () => publish(event, payload)); await settle();
}
function publish(event: string, payload: unknown) { for (const handler of h.handlers.get(event) ?? []) handler(payload); }
function currentContext(): ForwardContext {
  const classified = manualForwardDraft(fixture.connection.forwards ?? [], fixture.context);
  return structuredClone({ ...fixture.context, forwardAuto: fixture.connection.forwardAuto ?? "ask", manualRules: classified.manualRules, conflicts: classified.conflicts,
    managedRuleIds: (fixture.connection.forwards ?? []).filter(rule => fixture.context.managed.some(owner => sameForwardRoute(rule, owner.rule))).map(rule => rule.id) });
}
export function live(state: TunnelStatus["state"] = "up", rules?: TunnelStatus["rules"]): TunnelStatus {
  const status: TunnelStatus = { connectionId: fixture.connection.id, state, needsSecret: false, message: null,
    rules: rules ?? currentContext().manualRules.filter(rule => rule.enabled).map(rule => ({ rule, state: state === "up" ? "listening" : "pending", boundPort: rule.listenPort || null, message: null })) };
  fixture.context.manualStatus = status;
  return status;
}
export function manual(rules: ForwardRule[] = [extra]) { fixture.connection.forwards = rules; fixture.context.managed = []; fixture.context.managedRuleIds = []; }
beforeEach(() => {
  dismissForwardOffer();
  for (const mock of [h.invoke, h.navigate, h.back, h.toast, h.clipboard]) mock.mockReset();
  h.clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: h.clipboard } });
  fixture.readFails = false; fixture.saveFails = false; fixture.startFails = false; fixture.stopFails = false;
  fixture.connection = { id: "server-" + ++sequence, name: "公司", host: "server.test", username: "dev", port: 22, authType: "password", forwards: [legacy], forwardAuto: "ask",
    rememberPassword: true, encryptedPassword: "saved-ciphertext", keyPath: "", rememberPassphrase: false, encryptedPassphrase: "", proxyJumpId: "" };
  fixture.context = { connectionId: fixture.connection.id, forwardAuto: "ask", manualRules: [], managedRuleIds: [legacy.id], conflicts: [], manualStatus: null,
    managed: [{ connectionId: fixture.connection.id, rule: { ...legacy, id: "managed" }, phase: "ready", enabled: true, message: null }] };
  h.invoke.mockImplementation(async (command: string, args?: { connectionId?: string; args?: { connection: SshConnection } }) => {
    if (command === "ssh_forward_context") { if (fixture.readFails) throw new Error("读取失败"); return currentContext(); }
    if (command === "ssh_tunnel_list") return [];
    if (command === "ssh_list_connections") return { enabled: true, connections: [structuredClone(fixture.connection)] };
    if (command === "ssh_save_connection") { if (fixture.saveFails) throw new Error("保存失败"); fixture.connection = structuredClone(args!.args!.connection); return; }
    if (command === "ssh_tunnel_start") { if (fixture.startFails) throw new Error("开启失败"); const status = live("connecting"); publish("ssh_tunnel_status", status); return status; }
    if (command === "ssh_tunnel_stop") { if (fixture.stopFails) throw new Error("停止失败"); fixture.context.manualStatus = null; publish("ssh_tunnel_status", { connectionId: fixture.connection.id, state: "stopped", rules: [], needsSecret: false, message: null }); return; }
    return {};
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { dismissForwardOffer(); await act(async () => root.unmount()); client.clear(); host.remove(); });
