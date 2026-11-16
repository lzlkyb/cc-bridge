// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectTab } from "../ConnectTab";
import { emptySshConnection } from "../../../lib/sshConnectionForm";
import type { StaticStatus } from "../../../lib/types";
import type { StableConnectSnapshot } from "../../../lib/stableConnect";
import type { StableAccessRequest, StableDiscovery, StableFolders, StableTarget } from "../../../lib/stableAccess";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), listen: vi.fn(), copy: vi.fn(), toast: vi.fn() }));
vi.mock("../../../lib/tauri", () => ({ invoke: mocks.invoke, invokeOrToast: mocks.save, listen: mocks.listen }));
vi.mock("../../ui/toast", () => ({ toast: mocks.toast, useToast: () => ({ toast: mocks.toast }) }));
vi.mock("../../../hooks/useCopyFeedback", () => ({ useCopyFeedback: () => ({ copy: mocks.copy, isCopied: () => false }) }));
vi.mock("../../../hooks/useAutoAnimateRM", () => ({ useAutoAnimateRM: () => ({ current: null }) }));
vi.mock("../SshConnectionDialog", () => ({ SshConnectionDialog: () => null }));
vi.mock("../ConnectBento", () => ({ ConnectBento: ({ guide }: { guide: ReactNode }) => <div>{guide}</div> }));
vi.mock("./FirewallAlertBlock", () => ({ FirewallAlertBlock: () => null }));

const server = { ...emptySshConnection(), id: "a", name: "开发服务器", host: "remote.example", username: "ubuntu" };
const project = { name: "orders", path: "/home/ubuntu/projects/orders" };
const base = { running: true, platform: "linux", host: "0.0.0.0", port: 7823, token: "current-token", transport: "http",
  scope: "project", projectPath: "/srv/old-ip-project", multiDeviceMode: false, deviceId: "device-a", connectClient: "claude-code", hasOnboarded: true, lanIps: ["10.7.0.9"] } as StaticStatus;
const target: StableTarget = { id: "project-entry", name: "cc-bridge", scope: "project", projectPath: project.path, projectKey: null,
  configFile: `${project.path}/.mcp.json`, url: "http://192.168.31.81:7823/mcp", fingerprint: "a".repeat(64), recognized: true, tokenMatches: true };
const discovery = (targets: StableTarget[] = [], path: string | null = null, complete = true): StableDiscovery => ({ signature: "server-receipt", complete, home: "/home/ubuntu",
  inspectedProjectPath: path, projects: [project, { name: "website", path: "/home/ubuntu/projects/website" }], targets, warnings: complete ? [] : ["一个项目暂时无法读取"],
  files: [{ scope: "user", projectPath: "", configFile: "/home/ubuntu/.claude.json", fingerprint: "missing" },
    { scope: "project", projectPath: path ?? project.path, configFile: `${path ?? project.path}/.mcp.json`, fingerprint: "missing" }] });
let root: Root, host: HTMLDivElement, client: QueryClient, backend: StableConnectSnapshot, initial: StableDiscovery;
let inspectHandler: ((args: Record<string, unknown>) => Promise<StableDiscovery>) | undefined;
let foldersHandler: ((args: Record<string, unknown>) => Promise<StableFolders>) | undefined;
const calls = (name: string) => mocks.invoke.mock.calls.filter(call => call[0] === name);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(10); });
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(name))!;
const click = async (name: string) => { expect(button(name), name).toBeDefined(); await act(async () => button(name).click()); await flush(); };
const mount = async (status = base) => { await act(async () => root.render(<QueryClientProvider client={client}><ConnectTab status={status} onRefresh={() => {}} selectedIp="10.7.0.9" onSelectIp={() => {}} ipResolvedByUser={false} onSedResolved={() => {}} /></QueryClientProvider>)); await flush(); };
const changeInput = async (input: HTMLInputElement, value: string) => { await act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}); await flush(); };
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 1));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.values(mocks).forEach(mock => mock.mockReset());
  backend = { method: "stable", selectedConnectionId: server.id, connections: [] };
  initial = discovery(); inspectHandler = undefined; foldersHandler = undefined;
  mocks.listen.mockResolvedValue(() => {}); mocks.save.mockResolvedValue(true);
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "stable_connect_get") return structuredClone(backend);
    if (command === "ssh_list_connections") return { enabled: true, connections: [server, { ...server, id: "b", name: "另一台服务器", host: "other.example" }] };
    if (command === "get_tls_status") return { enabled: false };
    if (command === "get_status") return { stats: { totalRequests: 0 } };
    if (command === "stable_connect_inspect") {
      if (inspectHandler) return inspectHandler(args);
      if (!args.projectPath && args.sourceProjectPath == null) return initial;
      const paths = [...new Set([project.path, args.projectPath, args.sourceProjectPath].filter(Boolean) as string[])];
      const result = discovery(initial.targets.filter(entry => !args.projectPath || entry.projectPath === args.projectPath ||
        args.sourceProjectPath != null && (entry.scope === "user" || entry.projectPath === args.sourceProjectPath)), args.projectPath as string | null);
      result.files = [result.files[0], ...paths.map(path => ({ scope: "project" as const, projectPath: path, configFile: `${path}/.mcp.json`, fingerprint: "missing" }))];
      return result;
    }
    if (command === "stable_connect_folders") return foldersHandler ? foldersHandler(args) : { signature: "server-receipt", home: "/home/ubuntu", path: args.path ?? "/home/ubuntu", parent: "/home", directories: [project], truncated: false };
    if (command === "stable_connect_select") { backend = { ...backend, method: args.method as "stable" | "direct", selectedConnectionId: args.connectionId as string }; return backend; }
    if (command === "stable_connect_start") {
      const access = args.access as StableAccessRequest | null;
      const migrated = access?.scopeChange ? { id: `moved-${args.scope}-${args.projectPath}`, scope: args.scope as "user" | "project",
        projectPath: args.projectPath as string, projectKey: null, configFile: args.scope === "user" ? "/home/ubuntu/.claude.json" : `${args.projectPath}/.mcp.json` } : {};
      const next = access?.target ? { ...access.target, ...migrated, url: "http://127.0.0.1:43127/mcp", tokenMatches: true, fingerprint: "b".repeat(64) } : backend.connections[0]?.target ?? null;
      if (access && next) initial = { ...initial, targets: [...initial.targets.filter(entry => entry.id !== access.target?.id), next] };
      backend = { ...backend, connections: [{ connectionId: args.connectionId as string, port: 43127, scope: args.scope as "user" | "project", projectPath: args.projectPath as string,
        multiDevice: !!args.multiDevice, configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: next }] };
      return structuredClone(backend);
    }
    throw Error(`Unexpected IPC: ${command}`);
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("首次接入默认推荐项目级，选择项目后接入，检查只读不自动配置 MCP", async () => {
  await mount();
  expect(host.querySelector('.sc-scope button[aria-pressed="true"]')?.textContent).toContain("只在一个项目使用推荐");
  expect(button("所有项目都可用").textContent).not.toContain("推荐");
  expect(host.querySelector(".sc-manual")).toBeNull();
  expect(button("一键接入").disabled).toBe(true);
  expect(calls("stable_connect_start")).toHaveLength(0); expect(mocks.save).not.toHaveBeenCalled();
  await click("选择项目");
  await act(async () => host.querySelector<HTMLButtonElement>(".sc-project-row")!.click()); await flush();
  expect(host.querySelector(".sc-addresses")?.textContent).toContain("配置时自动确认");
  await click("一键接入");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: "project", projectPath: project.path, access: { target: null, inspection: { complete: true } } });
  expect(host.textContent).toContain("请重新打开服务器上的 Claude Code");
  expect(host.textContent).toContain("127.0.0.1:43127/mcp");
  expect(host.textContent).not.toContain("已收到首次调用");
});

it("从已配置的隧道接入其他项目时保留选择器，检查完成后显示最近项目", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  const scan = deferred<StableDiscovery>();
  inspectHandler = args => args.projectPath ? Promise.resolve(discovery([], args.projectPath as string)) : scan.promise;
  await mount();
  await act(async () => { host.querySelector<HTMLDetailsElement>(".sc-advanced")!.open = true; });
  await click("接入其他项目");
  expect(host.querySelector('[aria-label="选择服务器项目"]')).not.toBeNull();
  await act(async () => scan.resolve(discovery([saved]))); await flush();
  expect(host.querySelector(".sc-project-list")?.textContent).toContain("website");
  await click("website");
  expect(calls("stable_connect_inspect").slice(-1)[0]?.[1]).toMatchObject({ projectPath: "/home/ubuntu/projects/website" });
});

it.each(["project", "local", "user"] as const)("升级 %s 保留原名称、配置文件和原始项目键", async scope => {
  const entry = { ...target, scope, projectPath: scope === "user" ? "" : project.path, projectKey: scope === "local" ? `${project.path}/` : null,
    configFile: scope === "project" ? target.configFile : "/home/ubuntu/.claude.json" };
  initial = discovery([entry]); await mount();
  expect(host.textContent).toContain("的原有接入");
  expect(button("改用隧道连接").disabled).toBe(false);
  await click("改用隧道连接");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: scope === "user" ? "user" : "project", projectPath: entry.projectPath,
    access: { target: { name: entry.name, scope, projectKey: entry.projectKey, configFile: entry.configFile, fingerprint: entry.fingerprint } } });
});

it("不确定的名称不会自动升级，必须先核对原地址并确认", async () => {
  const custom = { ...target, name: "my-bridge", recognized: false };
  initial = discovery([custom]); await mount();
  expect(host.textContent).toContain("这是你之前接入的桥吗");
  expect(host.querySelector(".sc-action-row")).toBeNull();
  expect(calls("stable_connect_start")).toHaveLength(0);
  await click("是，升级此接入"); await click("改用隧道连接");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ access: { target: { name: "my-bridge" } } });
});

it("多个接入先选择目标，选择期间压缩服务器信息", async () => {
  initial = discovery([target, { ...target, id: "global", scope: "user", projectPath: "", configFile: "/home/ubuntu/.claude.json" }]);
  await mount();
  expect(host.querySelectorAll(".sc-entry-row")).toHaveLength(2);
  expect(host.querySelector(".sc-picker-server")).not.toBeNull();
  expect(host.querySelector(".stable-intro")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>(".sc-entry-row")!.click()); await flush();
  expect(host.querySelector(".sc-target-meta")?.textContent).toContain(project.path);
});

it("选最近项目会检查该目录，不要求输入项目名或完整路径", async () => {
  await mount(); await click("只在一个项目使用");
  expect(host.querySelector(".sc-picker")).not.toBeNull();
  expect(host.querySelector(".sc-action-row")).toBeNull();
  expect(host.querySelector(".sc-advanced")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>(".sc-project-row")!.click()); await flush();
  expect(calls("stable_connect_inspect").slice(-1)[0]?.[1]).toMatchObject({ projectPath: project.path });
  await click("一键接入");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: "project", projectPath: project.path });
  expect(mocks.save).not.toHaveBeenCalled();
});

it("读取不完整不能被当作首次接入，选一个项目检查成功后才能继续", async () => {
  initial = discovery([], null, false); await mount();
  expect(button("一键接入").disabled).toBe(true);
  expect(host.textContent).toContain("暂时没读到完整的接入配置");
  await click("选择一个项目再检查");
  await act(async () => host.querySelector<HTMLButtonElement>(".sc-project-row")!.click()); await flush();
  expect(button("一键接入").disabled).toBe(false);
  expect(calls("stable_connect_start")).toHaveLength(0);
});

it.each(["需要登录服务器，请输入登录密码。", "解密密码失败：保存的信息无法读取"])("一次性登录密码用于检查和本次接入，成功后清空且不进查询缓存（%s）", async message => {
  let reads = 0;
  inspectHandler = async () => { if (!reads++) throw Error(message); return discovery(); };
  await mount();
  const input = host.querySelector<HTMLInputElement>('.sc-login input[type="password"]')!;
  expect(input).not.toBeNull();
  await changeInput(input, "only-this-session"); await click("登录并检查");
  expect(calls("stable_connect_inspect").slice(-1)[0]?.[1]).toMatchObject({ password: "only-this-session" });
  await click("所有项目都可用");
  await click("一键接入");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ password: "only-this-session" });
  expect(JSON.stringify(client.getQueryCache().getAll().map(query => [query.queryKey, query.state.data]))).not.toContain("only-this-session");
  expect(host.querySelector('.sc-login input[type="password"]')).toBeNull();
});

it("浏览文件夹时已保存密码失效，也能临时登录继续选择项目", async () => {
  let reads = 0;
  foldersHandler = async args => {
    if (!reads++) throw Error("解密密码失败：保存的信息无法读取");
    expect(args.password).toBe("folder-session-secret");
    return { signature: "server-receipt", home: "/home/ubuntu", path: "/home/ubuntu/projects", parent: "/home/ubuntu", directories: [project], truncated: false };
  };
  await mount(); await click("只在一个项目使用"); await click("浏览服务器文件夹");
  const input = host.querySelector<HTMLInputElement>('.sc-folder-error input[type="password"]')!;
  expect(input).not.toBeNull();
  await changeInput(input, "folder-session-secret"); await click("登录并检查");
  expect(host.querySelector(".sc-folder-list")?.textContent).toContain(project.name);
  expect(host.querySelector(".sc-folder-error")).toBeNull();
  expect(JSON.stringify(client.getQueryCache().getAll().map(query => [query.queryKey, query.state.data]))).not.toContain("folder-session-secret");
  expect(mocks.save).not.toHaveBeenCalled();
});

it("旧服务器的检查结果不会覆盖新服务器，也不会发送旧服务器的配置", async () => {
  const first = deferred<StableDiscovery>();
  inspectHandler = async args => args.connectionId === "a" ? first.promise : discovery([{ ...target, id: "other", projectPath: "/other/work", configFile: "/other/work/.mcp.json" }]);
  await mount();
  const select = host.querySelector<HTMLSelectElement>(".stable-server-control select")!;
  await act(async () => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
  await act(async () => first.resolve(discovery([target]))); await flush();
  expect(host.querySelector(".sc-target-meta")?.textContent).toContain("/other/work");
  expect(host.querySelector(".sc-target-meta")?.textContent).not.toContain(project.path);
  await click("改用隧道连接");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ connectionId: "b", projectPath: "/other/work" });
});

it("晚到的文件夹列表不会覆盖用户新打开的目录", async () => {
  const old = deferred<StableFolders>();
  foldersHandler = async args => args.path === "/" ? { signature: "server-receipt", home: "/home/ubuntu", path: "/", parent: "/", directories: [{ name: "current-folder", path: "/current-folder" }], truncated: false } : old.promise;
  await mount(); await click("只在一个项目使用"); await click("浏览服务器文件夹"); await click("根目录");
  await act(async () => old.resolve({ signature: "server-receipt", home: "/home/ubuntu", path: "/old", parent: "/", directories: [{ name: "old-folder", path: "/old-folder" }], truncated: false })); await flush();
  expect(host.querySelector(".sc-folder-list")?.textContent).toContain("current-folder");
  expect(host.querySelector(".sc-folder-list")?.textContent).not.toContain("old-folder");
});

it("隧道连接的项目选择和配置完成不会改变 IP 直连原来的界面与目录", async () => {
  backend.method = "direct"; initial = discovery([target]); await mount();
  const snapshot = () => { const guide = host.querySelector(".connect-guide")!; return { text: guide.textContent, inputs: [...guide.querySelectorAll<HTMLInputElement>("input")].map(input => [input.type, input.value]), buttons: [...guide.querySelectorAll<HTMLButtonElement>("button")].map(item => [item.textContent, item.disabled]) }; };
  const before = snapshot(); expect(calls("stable_connect_inspect")).toHaveLength(0);
  await click("隧道连接"); await click("改用隧道连接");
  await click("更改范围"); await click("所有项目都可用"); await click("应用范围更改");
  await click("IP 直连");
  expect(snapshot()).toEqual(before);
  expect(host.querySelector<HTMLInputElement>(".connect-path input")?.value).toBe(base.projectPath);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("已经配置好的日常状态不自动登录检查，重新检测也不重写接入", async () => {
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true,
    target: { ...target, url: "http://127.0.0.1:43127/mcp" } }];
  await mount(); expect(calls("stable_connect_inspect")).toHaveLength(0);
  await mount({ ...base, ipChanged: true, lanIps: ["10.8.0.9"] });
  expect(calls("stable_connect_inspect")).toHaveLength(0);
  await click("检查接入");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ access: null, projectPath: project.path });
  expect(host.textContent).not.toContain("已收到首次调用");
});

it("已配置的项目接入可以更改成全局范围，沿用固定地址并迁移原条目", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  initial = discovery([saved]); await mount();
  expect(calls("stable_connect_inspect")).toHaveLength(0);
  await click("更改范围");
  expect(host.querySelector('.sc-scope button[aria-pressed="true"]')?.textContent).toContain("只在一个项目使用");
  await click("所有项目都可用");
  expect(button("应用范围更改").disabled).toBe(false);
  expect(host.textContent).toContain("原项目接入将移到全局");
  await click("应用范围更改");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: "user", projectPath: "",
    access: { scopeChange: true, target: { id: saved.id, scope: "project", projectPath: project.path } } });
  expect(host.textContent).toContain("127.0.0.1:43127/mcp");
  expect(host.querySelector(".sc-scope-summary")?.textContent).toContain("所有项目可用");
  await click("更改范围");
  expect(host.querySelector('.sc-scope button[aria-pressed="true"]')?.textContent).toContain("所有项目都可用");
  expect(button("应用范围更改").disabled).toBe(true);
  expect(calls("stable_connect_start")).toHaveLength(1);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("已配置的全局接入可以选择项目后迁移，保留多设备接入的原名称", async () => {
  const saved = { ...target, id: "global-device", scope: "user" as const, projectPath: "", configFile: "/home/ubuntu/.claude.json", name: "cc-bridge-device-a", url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "user", projectPath: "", multiDevice: true,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  initial = discovery([saved]); await mount(); await click("更改范围");
  expect(host.querySelector('.sc-scope button[aria-pressed="true"]')?.textContent).toContain("所有项目都可用");
  await click("只在一个项目使用");
  expect(host.querySelector(".sc-picker")).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>(".sc-project-row")!.click()); await flush();
  expect(calls("stable_connect_inspect").slice(-1)[0]?.[1]).toMatchObject({ projectPath: project.path, sourceProjectPath: "" });
  expect(host.querySelector(".sc-scope-impact")?.textContent).toContain("原全局接入将移到");
  await click("应用范围更改");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: "project", projectPath: project.path, multiDevice: false,
    access: { scopeChange: true, target: { id: saved.id, scope: "user", name: saved.name } } });
  expect(host.querySelector(".sc-scope-summary")?.textContent).toContain("项目级 · orders");
});

it("取消范围更改不写入配置，晚到的目标范围结果不会覆盖当前接入", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  const pending = deferred<StableDiscovery>();
  inspectHandler = async args => args.projectPath ? discovery([saved], project.path) : pending.promise;
  await mount(); await click("更改范围"); await click("所有项目都可用");
  expect(host.textContent).toContain("正在检查服务器上的接入");
  await click("取消更改");
  await act(async () => pending.resolve(discovery([saved]))); await flush();
  expect(host.querySelector(".sc-scope-summary")?.textContent).toContain("项目级 · orders");
  expect(host.querySelector(".sc-scope")).toBeNull();
  expect(calls("stable_connect_start")).toHaveLength(0); expect(mocks.save).not.toHaveBeenCalled();
});

it("原接入消失后不会把范围更改当作首次接入，也不会自动选择另一条接入", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  initial = discovery([{ ...saved, id: "unrelated-global", scope: "user", projectPath: "", configFile: "/home/ubuntu/.claude.json" }]);
  await mount(); await click("更改范围");
  expect(host.textContent).toContain("原接入已变化或不存在");
  expect(button("应用范围更改").disabled).toBe(true);
  expect(calls("stable_connect_start")).toHaveLength(0);
});

it("范围编辑中切换 IP 直连再返回，不残留等待状态或隐藏原有设置", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  const pending = deferred<StableDiscovery>();
  inspectHandler = async args => args.projectPath ? discovery([saved], project.path) : pending.promise;
  await mount(); await click("更改范围"); await click("所有项目都可用");
  await click("IP 直连"); await click("隧道连接");
  await act(async () => pending.resolve(discovery([saved]))); await flush();
  expect(host.querySelector(".sc-advanced")).not.toBeNull();
  expect(host.querySelector(".sc-scope-summary")?.textContent).toContain("项目级 · orders");
  await click("更改范围");
  expect(host.querySelector('.sc-scope button[aria-pressed="true"]')?.textContent).toContain("只在一个项目使用");
  expect(calls("stable_connect_start")).toHaveLength(0);
});

it("收起范围编辑后恢复当前接入和原有更多设置", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  initial = discovery([saved]); await mount(); await click("更改范围"); await click("所有项目都可用");
  await click("收起");
  expect(host.querySelector(".sc-scope-summary")?.textContent).toContain("项目级 · orders");
  expect(host.querySelector(".sc-advanced")).not.toBeNull();
  expect(host.querySelector(".sc-scope")).toBeNull();
  expect(calls("stable_connect_start")).toHaveLength(0);
});
