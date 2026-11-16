// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectionMethodToggle, StableConnectionMethod } from "./StableConnectionMethod";
import { ConnectGuide } from "./ConnectGuide";
import { useStableConnect, type StableConnectState } from "../../../hooks/useStableConnect";
import { useConnectGuideState, type ConnectGuideState } from "../../../hooks/useConnectGuideState";
import { stableConnectKey } from "../../../hooks/useStableConnectSnapshot";
import { emptySshConnection } from "../../../lib/sshConnectionForm";
import type { StableConnection, StableConnectSnapshot } from "../../../lib/stableConnect";
import type { StaticStatus } from "../../../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn(), copy: vi.fn(), save: vi.fn(), toast: vi.fn() }));
vi.mock("../../../lib/tauri", () => ({ invoke: mocks.invoke, listen: mocks.listen, invokeOrToast: mocks.save }));
vi.mock("../../ui/toast", () => ({ toast: mocks.toast, useToast: () => ({ toast: mocks.toast }) }));
vi.mock("../../../hooks/useCopyFeedback", () => ({ useCopyFeedback: () => ({ copy: mocks.copy, isCopied: () => false }) }));
vi.mock("../../../hooks/useAutoAnimateRM", () => ({ useAutoAnimateRM: () => ({ current: null }) }));
vi.mock("../SshConnectionDialog", () => ({ SshConnectionDialog: () => null }));

const server = { ...emptySshConnection(), id: "server-a", name: "开发服务器", host: "remote.example", username: "dev" };
const base = { running: true, host: "0.0.0.0", port: 7823, token: "access-token", transport: "http", scope: "project", projectPath: "/srv/app", multiDeviceMode: false, deviceId: "device-42", connectClient: "claude-code" } as StaticStatus;
const record: StableConnection = { connectionId: server.id, port: 43127, scope: "project", projectPath: "/srv/app", multiDevice: false, configured: false, enabled: false, phase: "idle", step: 0, message: null, needsSecret: false, configMatches: true };
let root: Root, host: HTMLDivElement, client: QueryClient, state: StableConnectState, guide: ConnectGuideState;
let backend: StableConnectSnapshot, changed: () => void;
function Harness({ status }: { status: StaticStatus }) {
  guide = useConnectGuideState(status, "10.7.0.9");
  state = useStableConnect(status, { scope: guide.scope, projectPath: guide.projectPath, multiDevice: guide.multiDevice });
  return <><ConnectionMethodToggle state={state}/>{state.method === "stable" && <StableConnectionMethod state={state}/>}
    <ConnectGuide status={status} guide={guide} onRefresh={() => {}} stableCommand={state.method === "stable" ? state.command : undefined} automation={state.method === "stable" ? state.automation : undefined}/></>;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(1); });
const mount = async (status = base) => { await act(async () => root.render(<QueryClientProvider client={client}><Harness status={status}/></QueryClientProvider>)); await flush(); };
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === name)!;
const click = async (name: string) => { await act(async () => button(name).click()); await flush(); };
const calls = (name: string) => mocks.invoke.mock.calls.filter(call => call[0] === name);
async function publish(patch: Partial<StableConnection>) {
  backend = { ...backend, connections: [{ ...backend.connections[0], ...patch }] };
  await act(async () => changed()); await flush();
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  Object.values(mocks).forEach(mock => mock.mockReset());
  backend = { method: "stable", selectedConnectionId: server.id, connections: [{ ...record }] };
  mocks.save.mockResolvedValue(true);
  mocks.listen.mockImplementation((_event: string, callback: () => void) => { changed = callback; return Promise.resolve(mocks.unlisten); });
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "stable_connect_get") return backend;
    if (command === "ssh_list_connections") return { enabled: true, connections: [server, { ...server, id: "server-b", name: "其它服务器", host: "other.example", username: "ops" }] };
    if (command === "get_tls_status") return { enabled: false };
    if (command === "get_status") return { stats: { totalRequests: 0 } };
    if (command === "stable_connect_select") { backend = { ...backend, method: args!.method as "stable" | "direct", selectedConnectionId: args!.connectionId as string }; return backend; }
    if (command === "stable_connect_stop") { backend = { ...backend, connections: [{ ...backend.connections[0], phase: "stopped", enabled: false }] }; return backend; }
    if (command === "stable_connect_cancel") return;
    if (command === "stable_connect_start") return backend;
    throw new Error(`Unexpected IPC: ${command}`);
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("旧用户保留直连，页面读取和切换方式都不会自动启动 SSH", async () => {
  backend.method = "direct"; await mount();
  expect(state.method).toBe("direct"); expect(button("复制连接命令")).toBeDefined();
  expect(host.querySelector('[aria-label="隧道连接设置"]')).toBeNull();
  await act(async () => { await state.select("stable"); }); await flush();
  expect(state.method).toBe("stable"); expect(calls("stable_connect_start")).toHaveLength(0);
  expect(calls("stable_connect_stop")).toHaveLength(0);
});

it("服务器名称与地址分层显示，切换后更新辅助说明且不会自动接入", async () => {
  await mount();
  const selector = host.querySelector<HTMLSelectElement>(".stable-server-control select")!;
  const descriptionId = selector.getAttribute("aria-describedby")!;
  expect(host.querySelector(`label[for="${selector.id}"]`)?.textContent).toBe("服务器");
  expect(selector.selectedOptions[0].textContent).toBe("开发服务器");
  expect(document.getElementById(descriptionId)?.textContent).toBe("dev@remote.example");
  await act(async () => { selector.value = "server-b"; selector.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
  expect(selector.selectedOptions[0].textContent).toBe("其它服务器");
  expect(document.getElementById(descriptionId)?.textContent).toBe("ops@other.example");
  expect(calls("stable_connect_start")).toHaveLength(0);
});

it("已接入时收起服务器选择，管理可查看固定地址并停止当前连接", async () => {
  backend.connections = [{ ...record, phase: "ready", configured: true, enabled: true }]; await mount();
  expect(host.querySelector(".stable-server-control")).toBeNull();
  const manage = host.querySelector<HTMLButtonElement>('[aria-label="管理隧道连接"]')!;
  await act(async () => manage.click()); await flush();
  expect(host.querySelector<HTMLSelectElement>(".stable-server-control select")?.value).toBe(server.id);
  expect(host.querySelector(".stable-fixed-address")?.textContent).toContain("127.0.0.1:43127/mcp");
  await click("暂停当前隧道");
  expect(calls("stable_connect_stop")).toEqual([["stable_connect_stop", { connectionId: server.id }]]);
  expect(calls("ssh_tunnel_stop")).toHaveLength(0);
});

it("全局首次配置只突出完成接入，更多设置和命令默认折叠", async () => {
  await mount({ ...base, scope: "user", projectPath: "", hasOnboarded: false });
  expect(host.querySelector<HTMLDetailsElement>(".connect-advanced")?.open).toBe(false);
  expect(host.querySelector<HTMLDetailsElement>(".connect-command-details")?.open).toBe(false);
  expect(host.querySelector(".connect-command h3")?.textContent).toBe("完成接入");
  expect(host.querySelector(".connect-path")).toBeNull();
  expect(button("一键接入").disabled).toBe(false);
});

it("首次检查通过显示配置完成及下一步，不冒充 Claude Code 已调用", async () => {
  await mount();
  backend = { ...backend, connections: [{ ...record, phase: "ready", configured: true, enabled: true }] };
  mocks.invoke.mockResolvedValueOnce(backend); await click("一键接入");
  expect(state.showNextStep).toBe(true);
  expect(host.textContent).toContain("请重新打开服务器上的 Claude Code");
  expect(host.textContent).not.toContain("已收到首次调用");
  await click("收起提示"); expect(state.showNextStep).toBe(false);
  await click("检查接入"); expect(state.showNextStep).toBe(false);
});

it("后台五步映射为三步进度，当前步骤与按钮动作一致", async () => {
  await mount(); await publish({ phase: "running", step: 3, enabled: true });
  expect(host.querySelectorAll(".stable-progress-steps li")).toHaveLength(3);
  expect(host.querySelector('[aria-current="step"]')?.textContent).toContain("配置 Claude Code");
  expect(state.automation.label).toBe("正在配置 Claude Code…");
  expect(host.querySelector<HTMLButtonElement>('[aria-busy="true"]')?.disabled).toBe(true);
  expect(host.querySelector(".ui-button-loader")?.textContent).toContain("正在配置 Claude Code…");
  await publish({ step: 4 });
  expect(host.querySelector('[aria-current="step"]')?.textContent).toContain("检查可用");
});

it("首次配置失败但通道已开启时，仍然能停止连接", async () => {
  backend.connections = [{ ...record, phase: "error", configured: false, enabled: true, message: "配置写入失败\n--- 输出 ---\npermission denied" }]; await mount();
  expect(host.querySelector(".stable-inline-repair b")?.textContent).toBe("配置写入失败");
  expect(host.querySelector<HTMLDetailsElement>(".stable-error-details")?.open).toBe(false);
  expect(host.querySelector(".stable-error-details pre")?.textContent).toContain("permission denied");
  expect(button("暂停当前隧道")).toBeDefined();
  await click("暂停当前隧道");
  expect(state.record?.enabled).toBe(false);
  expect(state.record?.phase).toBe("stopped");
});

it("同一帧重复点击只启动一次，IPC 返回也不能把尚未完成的步骤宣布成功", async () => {
  await mount(); const operation = deferred<StableConnectSnapshot>();
  mocks.invoke.mockImplementationOnce(() => operation.promise);
  let first!: ReturnType<StableConnectState["start"]>;
  await act(async () => { first = state.start(); void state.start(); });
  expect(calls("stable_connect_start")).toHaveLength(1);
  expect(state.busy).toBe(true); expect(state.ready).toBe(false);
  expect(host.querySelector<HTMLButtonElement>('[aria-busy="true"]')?.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>(".connect-path input")?.disabled).toBe(true);
  expect([...host.querySelectorAll(".connect-guide fieldset")].every(element => element.matches(":disabled"))).toBe(true);
  expect(host.querySelector<HTMLSelectElement>(".stable-server-control select")?.disabled).toBe(true);
  await act(async () => { await state.select("direct", "server-b"); });
  expect(calls("stable_connect_select")).toHaveLength(0); expect(state.selectedId).toBe(server.id);
  await publish({ phase: "running", step: 2, enabled: true });
  expect(host.textContent).toContain("建立加密通道");
  await act(async () => { operation.resolve(backend); await first; }); await flush();
  expect(state.busy).toBe(true); expect(state.ready).toBe(false);
  await publish({ phase: "ready", step: 4, configured: true });
  expect(state.ready).toBe(true); expect(button("配置完成").disabled).toBe(true);
  expect(host.querySelector(".stable-inline-status")).not.toBeNull();
  expect(host.querySelector(".stable-server-control")).toBeNull();
});

it("两种连接方式共用一个路径、范围、令牌和权限设置", async () => {
  await mount();
  await act(async () => { guide.setProjectPath("  /srv/My Project  "); guide.setIncludeShellTools(true); });
  await act(async () => { await state.select("direct"); }); await flush();
  expect(guide.projectPath).toBe("  /srv/My Project  "); expect(guide.includeShellTools).toBe(true);
  expect(host.querySelectorAll(".connect-path input")).toHaveLength(1);
  expect(host.querySelector(".connect-main-code")?.textContent).toContain('cd "/srv/My Project" &&');
  await act(async () => { await state.select("stable"); }); await flush();
  await act(async () => { await state.start(); }); await flush();
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ connectionId: server.id, projectPath: "/srv/My Project", scope: "project", multiDevice: false });
  expect(host.querySelectorAll(".connect-token")).toHaveLength(1);
  expect([...host.querySelectorAll("h3")].filter(e => e.textContent === "权限自动授权")).toHaveLength(1);
  await act(async () => guide.setScope("user"));
  expect(host.querySelector(".connect-path")).toBeNull(); expect(guide.permissionCommand).toContain("~/.claude/settings.json");
});

it.each(["path", "scope", "multi"])("已就绪后更改 %s 必须重新应用，并禁止复制旧命令", async field => {
  backend.connections = [{ ...record, phase: "ready", configured: true, enabled: true }]; await mount();
  expect(state.ready).toBe(true);
  if (field === "path") await act(async () => guide.setProjectPath("/srv/other"));
  if (field === "scope") await act(async () => guide.setScope("user"));
  if (field === "multi") await mount({ ...base, multiDeviceMode: true });
  expect(state.ready).toBe(false); expect(button("应用接入配置").disabled).toBe(false);
  expect(button("复制命令").disabled).toBe(true);
});

it.each([
  { field: "令牌", patch: { token: "rotated-token" } },
  { field: "本机端口", patch: { port: 9823 } },
  { field: "监听地址", patch: { host: "127.0.0.1" } },
  { field: "协议", patch: { transport: "sse" } },
  { field: "设备标识", patch: { deviceId: "device-new" } },
])("$field 变化时无须隧道事件也会重读后端并启用重新应用", async ({ patch }) => {
  backend.connections = [{ ...record, phase: "ready", configured: true, enabled: true }]; await mount();
  expect(state.ready).toBe(true);
  const reads = calls("stable_connect_get").length;
  // Only backend validation changes; do not publish a tunnel event or mutate the cached snapshot.
  backend = { ...backend, connections: [{ ...backend.connections[0], configMatches: false }] };
  await mount({ ...base, ...patch });
  expect(calls("stable_connect_get").length).toBeGreaterThan(reads);
  expect(state.record?.configMatches).toBe(false); expect(state.ready).toBe(false);
  expect(button("应用接入配置").disabled).toBe(false); expect(button("复制命令").disabled).toBe(true);
  expect(calls("stable_connect_start")).toHaveLength(0);
});

it.each(["tls-status", "sshConnections"])("%s 查询更新后重新核对已应用配置，不依赖隧道事件", async queryKey => {
  backend.connections = [{ ...record, phase: "ready", configured: true, enabled: true }]; await mount();
  expect(state.ready).toBe(true);
  const reads = calls("stable_connect_get").length;
  backend = { ...backend, connections: [{ ...backend.connections[0], configMatches: false }] };
  await act(async () => {
    client.setQueryData([queryKey], queryKey === "tls-status" ? { enabled: true } : { enabled: true, connections: [{ ...server, host: "updated.example" }] });
  }); await flush();
  expect(calls("stable_connect_get").length).toBeGreaterThan(reads);
  expect(state.ready).toBe(false); expect(button("应用接入配置").disabled).toBe(false);
  expect(button("复制命令").disabled).toBe(true); expect(calls("stable_connect_start")).toHaveLength(0);
});

it("普通状态刷新和无关查询更新不会反复检查隧道连接", async () => {
  backend.connections = [{ ...record, phase: "ready", configured: true, enabled: true }]; await mount();
  const reads = calls("stable_connect_get").length;
  await mount({ ...base, ipChanged: true, lanIps: ["10.8.0.77"] });
  await act(async () => { client.setQueryData(["status"], { stats: { totalRequests: 3 } }); }); await flush();
  expect(calls("stable_connect_get")).toHaveLength(reads); expect(state.ready).toBe(true);
});

it("已接入的恢复任务被接管后收起表单，等待自动重连且不提前显示连通", async () => {
  backend.connections = [{ ...record, phase: "error", configured: true, enabled: true }];
  await mount();
  await act(async () => state.update({ managing: true }));
  await flush();
  backend = { ...backend, connections: [{ ...backend.connections[0], phase: "reconnecting", enabled: true }] };
  await act(async () => { expect(await state.start()).toBe(false); });
  await flush();
  expect(state.ui.managing).toBe(false);
  expect(state.reconnecting).toBe(true);
  expect(state.ready).toBe(false);
  expect(state.showNextStep).toBe(false);
  expect(state.automation.label).toBe("自动重连中…");
  expect(state.command).toContain("127.0.0.1:43127/mcp");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ access: null, projectPath: "/srv/app" });
  expect(calls("stable_connect_stop")).toHaveLength(0);
  await publish({ phase: "ready" });
  expect(state.ready).toBe(true);
  expect(state.command).toContain("127.0.0.1:43127/mcp");
});

it("启动失败保留可重试入口，取消只结束这次配置并保留原有隧道", async () => {
  await mount(); mocks.invoke.mockRejectedValueOnce(new Error("remote configuration denied"));
  await click("一键接入");
  expect(state.ready).toBe(false); expect(state.error).toContain("remote configuration denied");
  expect(button("一键接入").disabled).toBe(false);
  const operation = deferred<StableConnectSnapshot>(); mocks.invoke.mockImplementationOnce(() => operation.promise);
  await click("一键接入");
  expect(button("取消").disabled).toBe(true);
  await publish({ phase: "running", configured: true, enabled: true });
  await click("取消");
  expect(calls("stable_connect_start")).toHaveLength(2);
  expect(calls("stable_connect_cancel")).toEqual([["stable_connect_cancel", { connectionId: server.id }]]);
  expect(calls("stable_connect_stop")).toHaveLength(0);
  expect(calls("ssh_tunnel_stop")).toHaveLength(0);
  await publish({ phase: "ready" });
  await act(async () => operation.resolve(backend)); await flush();
  expect(state.ready).toBe(true); expect(state.record?.enabled).toBe(true);
  expect(state.showNextStep).toBe(false);
});

it.each(["password", "passphrase"])("%s 只传给当前尝试，失败后清空且不会进入查询缓存", async secretType => {
  backend.connections = [{ ...record, phase: "error", needsSecret: true, message: "重新登录" }]; await mount();
  await act(async () => { await state.start(); });
  expect(calls("stable_connect_start")).toHaveLength(0); expect(state.error).toContain("请输入");
  const secret = `one-time-${secretType}`;
  await act(async () => state.update({ credentials: { [secretType]: secret } }));
  const operation = deferred<StableConnectSnapshot>(); mocks.invoke.mockImplementationOnce(() => operation.promise);
  let attempt!: ReturnType<StableConnectState["start"]>;
  await act(async () => { attempt = state.start(); });
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ [secretType]: secret });
  expect(state.ui.credentials).toEqual({});
  expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data))).not.toContain(secret);
  await act(async () => { operation.reject(new Error("authentication failed")); await attempt; }); await flush();
  await act(async () => { await state.start(); });
  expect(calls("stable_connect_start")).toHaveLength(1);
  expect(state.error).toContain("请输入");
});

it("新增服务器选择失败不会把其一次性密码发给当前服务器", async () => {
  await mount();
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => command === "stable_connect_select" ? Promise.reject(new Error("selection rejected")) : original(command, args));
  await act(async () => { await state.saved({ ...server, id: "server-b" }, { password: "server-b-private" }); }); await flush();
  expect(state.selectedId).toBe("server-a"); expect(state.error).toContain("selection rejected");
  expect(state.ui.credentials).toEqual({});
  await act(async () => { await state.start(); }); await flush();
  for (const [, args] of calls("stable_connect_start")) expect(args.password).not.toBe("server-b-private");
});

it("切换已保存但状态刷新失败时，新服务器密码也不能发给缓存中的旧服务器", async () => {
  await mount();
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => command === "stable_connect_get" ? Promise.reject(new Error("refresh unavailable")) : original(command, args));
  await act(async () => { await state.saved({ ...server, id: "server-b" }, { password: "server-b-private" }); }); await flush();
  expect(backend.selectedConnectionId).toBe("server-b");
  await act(async () => { await state.start(); }); await flush();
  for (const [, args] of calls("stable_connect_start")) {
    if (args.connectionId !== "server-b") expect(args.password).not.toBe("server-b-private");
  }
  expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data))).not.toContain("server-b-private");
});

it("VPN 断开及恢复事件保留同一端口，等待后端恢复且不让用户重复接入", async () => {
  backend.connections = [{ ...record, phase: "ready", configured: true, enabled: true }]; await mount();
  const command = state.command;
  await publish({ phase: "reconnecting" }); await mount({ ...base, lanIps: ["10.8.0.77"], ipChanged: true });
  expect(state.command).toBe(command); expect(state.ready).toBe(false);
  expect(button("自动重连中…").disabled).toBe(true); expect(host.textContent).toContain("MCP 地址保持不变");
  await publish({ phase: "ready" }); expect(state.ready).toBe(true); expect(state.command).toBe(command);
  expect(client.getQueryData(stableConnectKey)).toEqual(backend);
});

it("状态读取失败提供重试，不启动任何连接；离开页面解除事件订阅", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => command === "stable_connect_get" ? Promise.reject(new Error("read unavailable")) : original(command, args));
  await mount(); expect(state.error).toContain("read unavailable"); expect(calls("stable_connect_start")).toHaveLength(0);
  mocks.invoke.mockImplementation(original); await act(async () => state.retry()); await flush();
  expect(state.error).toBe(""); expect(state.method).toBe("stable");
  await act(async () => root.render(null)); expect(mocks.unlisten).toHaveBeenCalledTimes(1);
});
