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
const mount = async (status = base, inspect = true) => {
  await act(async () => root.render(<QueryClientProvider client={client}><ConnectTab status={status} onRefresh={() => {}} selectedIp="10.7.0.9" onSelectIp={() => {}} ipResolvedByUser={false} onSedResolved={() => {}} /></QueryClientProvider>));
  await flush();
  if (inspect && button("检查此服务器")) await click("检查此服务器");
};
const chooseRecent = async (name?: string) => {
  if (name) await click(name);
  else { await act(async () => host.querySelector<HTMLButtonElement>(".sc-project-list .sc-project-row")!.click()); await flush(); }
  await click("使用所选项目");
};
const applyNew = async () => { await click("核对接入配置"); await click("创建隧道接入"); };
const applyScope = async () => { await click("核对接入配置"); await click("应用范围更改"); await click("稍后验证"); };
const step = () => host.querySelector('[aria-current="step"]')?.textContent;
const savedTunnel = (entry = target, phase: "ready" | "reconnecting" | "stopped" | "error" = "ready", needsSecret = false) => {
  backend.connections = [{ connectionId: server.id, port: 43127, scope: entry.scope === "user" ? "user" : "project",
    projectPath: entry.projectPath, multiDevice: false, configured: true, enabled: phase !== "stopped", phase, step: 4,
    message: null, needsSecret, configMatches: true, target: entry }];
  initial = discovery([entry]);
};
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
  await mount(base, false);
  expect(step()).toContain("服务器");
  expect(calls("stable_connect_inspect")).toHaveLength(0);
  await click("检查此服务器");
  expect(step()).toContain("接入目标");
  expect(host.querySelector('.sc-scope button[aria-pressed="true"]')?.textContent).toContain("只在一个项目使用推荐");
  expect(button("所有项目都可用").textContent).not.toContain("推荐");
  expect(host.querySelector(".sc-manual")).toBeNull();
  expect(button("核对接入配置").disabled).toBe(true);
  expect(calls("stable_connect_start")).toHaveLength(0); expect(mocks.save).not.toHaveBeenCalled();
  await click("选择项目");
  await chooseRecent();
  await click("核对接入配置");
  expect(step()).toContain("应用配置");
  expect(host.querySelector(".tunnel-flow-data")?.textContent).toContain(project.path);
  expect(calls("stable_connect_start")).toHaveLength(0);
  await click("创建隧道接入");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: "project", projectPath: project.path, access: { target: null, inspection: { complete: true } } });
  expect(step()).toContain("验证");
  expect(host.textContent).toContain("重新打开 Claude Code");
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
  await chooseRecent("website");
  expect(calls("stable_connect_inspect").slice(-1)[0]?.[1]).toMatchObject({ projectPath: "/home/ubuntu/projects/website" });
});

it.each(["project", "local", "user"] as const)("升级 %s 保留原名称、配置文件和原始项目键", async scope => {
  const entry = { ...target, scope, projectPath: scope === "user" ? "" : project.path, projectKey: scope === "local" ? `${project.path}/` : null,
    configFile: scope === "project" ? target.configFile : "/home/ubuntu/.claude.json" };
  initial = discovery([entry]); await mount();
  expect(host.textContent).toContain("将原有接入切换到隧道");
  expect(step()).toBeUndefined();
  expect(button("切换到隧道").disabled).toBe(false);
  await click("切换到隧道");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: scope === "user" ? "user" : "project", projectPath: entry.projectPath,
    access: { target: { name: entry.name, scope, projectKey: entry.projectKey, configFile: entry.configFile, fingerprint: entry.fingerprint } } });
});

it("不确定的名称不会自动升级，必须先核对原地址并确认", async () => {
  const custom = { ...target, name: "my-bridge", recognized: false };
  initial = discovery([custom]); await mount();
  expect(host.textContent).toContain("这是你之前接入的桥吗");
  expect(button("切换到隧道")).toBeUndefined();
  expect(calls("stable_connect_start")).toHaveLength(0);
  await click("是，升级此接入"); await click("切换到隧道");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ access: { target: { name: "my-bridge" } } });
});

it("多个接入先选择目标，选择期间压缩服务器信息", async () => {
  initial = discovery([target, { ...target, id: "global", scope: "user", projectPath: "", configFile: "/home/ubuntu/.claude.json" }]);
  await mount();
  expect(host.querySelectorAll(".sc-entry-row")).toHaveLength(2);
  expect(host.querySelector(".tunnel-flow-title")?.textContent).toContain(server.name);
  expect(host.querySelector(".stable-intro")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>(".sc-entry-row")!.click()); await flush();
  expect(host.querySelector(".tunnel-flow-data")?.textContent).toContain(project.path);
});

it("选最近项目会检查该目录，不要求输入项目名或完整路径", async () => {
  await mount(); await click("只在一个项目使用");
  expect(host.querySelector(".sc-picker")).not.toBeNull();
  expect(button("核对接入配置")).toBeUndefined();
  expect(host.querySelector(".sc-advanced")).toBeNull();
  await chooseRecent();
  expect(calls("stable_connect_inspect").slice(-1)[0]?.[1]).toMatchObject({ projectPath: project.path });
  await applyNew();
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: "project", projectPath: project.path });
  expect(mocks.save).not.toHaveBeenCalled();
});

it("读取不完整不能被当作首次接入，选一个项目检查成功后才能继续", async () => {
  initial = discovery([], null, false); await mount();
  expect(button("核对接入配置")).toBeUndefined();
  expect(host.textContent).toContain("一个项目暂时无法读取");
  await click("检查指定项目");
  await chooseRecent();
  expect(button("核对接入配置").disabled).toBe(false);
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
  await applyNew();
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
  await click("上一步");
  const select = host.querySelector<HTMLSelectElement>(".stable-server-control select")!;
  await act(async () => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
  await click("检查此服务器");
  await act(async () => first.resolve(discovery([target]))); await flush();
  expect(host.querySelector(".tunnel-flow-data")?.textContent).toContain("/other/work");
  expect(host.querySelector(".tunnel-flow-data")?.textContent).not.toContain(project.path);
  await click("切换到隧道");
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
  await click("隧道连接"); expect(step()).toBeUndefined(); await click("切换到隧道"); await click("稍后验证");
  await click("更改范围"); await click("所有项目都可用"); await applyScope();
  await click("IP 直连");
  expect(snapshot()).toEqual(before);
  expect(host.querySelector<HTMLInputElement>(".connect-path input")?.value).toBe(base.projectPath);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("已经配置好的日常状态启动时只核对一次，之后不再自动登录，重新检测也不重写接入", async () => {
  savedTunnel({ ...target, url: "http://127.0.0.1:43127/mcp" });
  // 记录里 target 是「上次写入的值」，服务器可能已经被改过；启动核一次才知道真相。
  await mount(); expect(calls("stable_connect_inspect")).toHaveLength(1);
  await mount({ ...base, ipChanged: true, lanIps: ["10.8.0.9"] });
  expect(calls("stable_connect_inspect")).toHaveLength(1);
  await click("检查接入");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ access: null, projectPath: project.path });
  expect(host.textContent).not.toContain("已收到首次调用");
});

it("已配置的项目接入可以更改成全局范围，沿用固定地址并迁移原条目", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  initial = discovery([saved]); await mount();
  // 启动的那次只读核对不选条目、不改范围草稿，用户点进来的仍是记录里的原接入。
  expect(calls("stable_connect_inspect")).toHaveLength(1);
  await click("更改范围");
  expect(host.querySelector('.sc-scope button[aria-pressed="true"]')?.textContent).toContain("只在一个项目使用");
  await click("所有项目都可用");
  expect(button("核对接入配置").disabled).toBe(false);
  expect(host.textContent).toContain("原项目接入将移到全局");
  await applyScope();
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: "user", projectPath: "",
    access: { scopeChange: true, target: { id: saved.id, scope: "project", projectPath: project.path } } });
  expect(host.textContent).toContain("127.0.0.1:43127/mcp");
  expect(host.querySelector(".tunnel-flow-scope")?.textContent).toContain("所有项目可用");
  await click("更改范围");
  expect(host.querySelector('.sc-scope button[aria-pressed="true"]')?.textContent).toContain("所有项目都可用");
  expect(button("核对接入配置").disabled).toBe(true);
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
  await chooseRecent();
  expect(calls("stable_connect_inspect").slice(-1)[0]?.[1]).toMatchObject({ projectPath: project.path, sourceProjectPath: "" });
  expect(host.querySelector(".sc-scope-impact")?.textContent).toContain("原全局接入将移到");
  await applyScope();
  // 多设备开关跟随连接记录本身，不再因为「迁到项目级」被强制关掉：条目名仍带本机尾号，
  // 项目 .mcp.json 里同样能和另一台电脑并存（旧实现要求多设备必须全局，迁移会丢掉开关）。
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: "project", projectPath: project.path, multiDevice: true,
    access: { scopeChange: true, target: { id: saved.id, scope: "user", name: saved.name } } });
  expect(host.querySelector(".tunnel-flow-scope")?.textContent).toContain("项目级 · orders");
});

it("取消范围更改不写入配置，晚到的目标范围结果不会覆盖当前接入", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  const pending = deferred<StableDiscovery>();
  inspectHandler = async args => args.projectPath ? discovery([saved], project.path) : pending.promise;
  await mount(); await click("更改范围"); await click("所有项目都可用");
  expect(host.textContent).toContain("正在检查服务器上的接入");
  await click("取消");
  await act(async () => pending.resolve(discovery([saved]))); await flush();
  expect(host.querySelector(".tunnel-flow-scope")?.textContent).toContain("项目级 · orders");
  expect(host.querySelector(".sc-scope")).toBeNull();
  expect(calls("stable_connect_start")).toHaveLength(0); expect(mocks.save).not.toHaveBeenCalled();
});

it("原接入消失后不会把范围更改当作首次接入，也不会自动选择另一条接入", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  const unrelated = { ...saved, id: "unrelated-global", scope: "user" as const, projectPath: "", configFile: "/home/ubuntu/.claude.json" };
  inspectHandler = async args => args.sourceProjectPath != null ? discovery([unrelated]) : discovery([saved]);
  await mount(); await click("更改范围");
  expect(host.textContent).toContain("原接入已变化或不存在");
  expect(button("应用范围更改")).toBeUndefined();
  expect(calls("stable_connect_start")).toHaveLength(0);
});

it("切回隧道后发现服务器仍指向直连地址，明确提示需要更新", async () => {
  const stale = { ...target, url: "http://10.7.0.9:7823/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: stale }];
  initial = discovery([stale]);
  await mount();
  await click("IP 直连"); await click("隧道连接");
  expect(calls("stable_connect_inspect").length).toBeGreaterThan(0);
  expect(host.textContent).toContain("服务器当前配置");
  expect(host.textContent).toContain("http://10.7.0.9:7823/mcp");
  expect(host.textContent).toContain("http://127.0.0.1:43127/mcp");
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
  expect(host.querySelector(".tunnel-flow-scope")?.textContent).toContain("项目级 · orders");
  await click("更改范围");
  expect(host.querySelector('.sc-scope button[aria-pressed="true"]')?.textContent).toContain("只在一个项目使用");
  expect(calls("stable_connect_start")).toHaveLength(0);
});

it("收起范围编辑后恢复当前接入和原有更多设置", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  initial = discovery([saved]); await mount(); await click("更改范围"); await click("所有项目都可用");
  await click("取消");
  expect(host.querySelector(".tunnel-flow-scope")?.textContent).toContain("项目级 · orders");
  expect(host.querySelector(".sc-advanced")).not.toBeNull();
  expect(host.querySelector(".sc-scope")).toBeNull();
  expect(calls("stable_connect_start")).toHaveLength(0);
});

it("冷启动隧道就绪后自动核对服务器接入，不展开配置面板", async () => {
  const stale = { ...target, url: "http://10.7.0.9:7823/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: stale }];
  initial = discovery([stale]);
  await mount();
  // 记录自称匹配（configMatches=true）时旧逻辑不会再核对，导致启动即显示"已连通"。
  expect(calls("stable_connect_inspect")).toHaveLength(1);
  expect(host.textContent).toContain("服务器当前配置");
  expect(host.querySelector(".tunnel-flow-data")).toBeNull();
});

it("自动核对读不到服务器时说明显示的是上次记录", async () => {
  const saved = { ...target, url: "http://127.0.0.1:43127/mcp" };
  backend.connections = [{ connectionId: server.id, port: 43127, scope: "project", projectPath: project.path, multiDevice: false,
    configured: true, enabled: true, phase: "ready", step: 4, message: null, needsSecret: false, configMatches: true, target: saved }];
  inspectHandler = () => Promise.reject(new Error("连接超时"));
  await mount();
  expect(host.textContent).toContain("暂时没能核对服务器上的接入");
  expect(host.querySelector(".tunnel-flow-data")).toBeNull();
});

it("首次从 IP 直连切到隧道时，先确认服务器再检查现有条目", async () => {
  backend.method = "direct"; backend.selectedConnectionId = null;
  initial = discovery([target]);
  await mount(); await click("隧道连接");
  expect(calls("stable_connect_inspect")).toHaveLength(0);
  expect(calls("stable_connect_select")[0][1]).toMatchObject({ connectionId: null });
  expect(step()).toBeUndefined();
  await click("检查此服务器");
  expect(calls("stable_connect_inspect")[0][1]).toMatchObject({ connectionId: server.id });
  expect(button("切换到隧道")).toBeDefined();
  expect(step()).toBeUndefined();
});

it("从 IP 直连切换时有多个条目，只选择本次要切换的条目", async () => {
  backend.method = "direct";
  const global = { ...target, id: "global", scope: "user" as const, projectPath: "", configFile: "/home/ubuntu/.claude.json" };
  initial = discovery([target, global]);
  await mount(); await click("隧道连接");
  expect(host.querySelectorAll(".sc-entry-row")).toHaveLength(2);
  expect(step()).toBeUndefined();
  expect(calls("stable_connect_start")).toHaveLength(0);
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".sc-entry-row")[1].click()); await flush();
  expect(host.querySelector(".tunnel-flow-data")?.textContent).toContain(global.configFile);
  await click("切换到隧道");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ access: { target: { id: global.id } } });
});

it("原地址写错时只核对并更新保存的条目", async () => {
  savedTunnel();
  initial = discovery([target, { ...target, id: "other", name: "other-bridge" }]);
  await mount(); await click("更新原接入地址");
  expect(step()).toBeUndefined();
  expect(calls("stable_connect_inspect").slice(-1)[0]?.[1]).toMatchObject({ projectPath: project.path, sourceProjectPath: project.path });
  expect(host.querySelector(".tunnel-flow-data")?.textContent).toContain(target.url);
  expect(host.querySelector(".tunnel-flow-data")?.textContent).toContain("http://127.0.0.1:43127/mcp");
  expect(calls("stable_connect_start")).toHaveLength(0);
  await click("更新现有接入");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ access: { target: { id: target.id, configFile: target.configFile } } });
  await click("我已在 Claude Code 验证");
  expect(host.textContent).toContain("你已确认 Claude Code 接入");
});

it("原条目已消失时，修复不会改写扫描发现的另一个条目", async () => {
  savedTunnel();
  initial = discovery([{ ...target, id: "different", name: "another-bridge" }]);
  await mount(); await click("更新原接入地址");
  expect(host.textContent).toContain("原接入已变化或不存在");
  expect(button("更新现有接入")).toBeUndefined();
  expect(host.querySelector(".sc-entry-row")).toBeNull();
  expect(calls("stable_connect_start")).toHaveLength(0);
});

it("VPN 正在重连时展示恢复状态，暂停后的恢复只启动原隧道", async () => {
  const ready = { ...target, url: "http://127.0.0.1:43127/mcp" };
  savedTunnel(ready, "reconnecting");
  await mount(); await click("查看重连详情");
  expect(host.textContent).toContain("正在按原固定端口重试");
  expect(step()).toBeUndefined();
  expect(calls("stable_connect_start")).toHaveLength(0);
  savedTunnel(ready, "stopped");
  await act(async () => { await client.invalidateQueries({ queryKey: ["stable-connect"] }); }); await flush();
  await click("恢复隧道");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ access: null, connectionId: server.id, projectPath: project.path });
  expect(step()).toBeUndefined();
});

it("项目级也能开多设备：接入目标页可切换，命令按项目范围与设备条目提交", async () => {
  await mount(base, false);
  await click("检查此服务器");
  expect(calls("stable_connect_inspect")[0]?.[1]).toMatchObject({ multiDevice: false });
  await click("选择项目");
  await chooseRecent();
  // 旧实现把多设备限定在全局范围，项目级连开关都不渲染。
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="多设备接入模式"]');
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
  await flush();
  expect(toggle!.getAttribute("aria-checked")).toBe("true");
  await click("核对接入配置");
  await click("创建隧道接入");
  expect(calls("stable_connect_start")[0][1]).toMatchObject({ scope: "project", projectPath: project.path, multiDevice: true });
});

it("开启多设备会放弃其他设备的旧条目并等待新的端口检查", async () => {
  const legacy = { ...target, tokenMatches: false };
  const next = deferred<StableDiscovery>();
  inspectHandler = (args) => args.multiDevice
    ? next.promise
    : Promise.resolve({ ...discovery([legacy], args.projectPath as string | null), tunnelPort: 17901 });
  await mount();
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="多设备接入模式"]');
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
  await flush();
  expect(calls("stable_connect_inspect").slice(-1)[0]?.[1]).toMatchObject({ multiDevice: true });
  expect(button("创建隧道接入")).toBeUndefined();
  expect(calls("stable_connect_start")).toHaveLength(0);
  await act(async () => next.resolve({ ...discovery([], project.path), signature: "multi-receipt", tunnelPort: 17902 }));
  await flush();
  await click("核对接入配置");
  await click("创建隧道接入");
  expect(calls("stable_connect_start")[0]?.[1]).toMatchObject({
    multiDevice: true,
    access: { target: null, tunnelPort: 17902, inspection: { signature: "multi-receipt" } },
  });
});

it("后台换号成功后在日常接入页提示重新复制地址", async () => {
  savedTunnel({ ...target, url: "http://127.0.0.1:43127/mcp" });
  backend.connections[0].message = "已自动换到端口 43127 并重新接入。若在别处保存过这台的地址，请重新复制。";
  await mount();
  expect(host.textContent).toContain("已自动换到端口 43127");
  expect(host.textContent).toContain("请重新复制");
});
