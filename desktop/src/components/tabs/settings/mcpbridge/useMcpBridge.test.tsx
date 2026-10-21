// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { useMcpBridge } from "./useMcpBridge";
import { McpBridgeGroup } from "./McpBridgeGroup";
import type { ServerInput } from "./types";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../../ui/toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("./ServerEditModal", () => ({ ServerEditModal: ({ onSubmit }: { onSubmit: (input: ServerInput) => void }) => <button onClick={() => onSubmit({ name: "draft", command: "node", args: ["draft-server.js"], env: null, cwd: null })}>提交测试参数</button> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, bridge: ReturnType<typeof useMcpBridge>;
function Harness() { bridge = useMcpBridge(); return null; }
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.toast.mockReset();
  mocks.invoke.mockResolvedValue({ enabled: false, servers: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe("MCP 配置读取与操作反馈", () => {
  it("初始读取中不伪装成空配置，失败保留重读入口且禁止修改未知状态", async () => {
    let reject!: (error: Error) => void;
    mocks.invoke.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    await act(async () => root.render(<McpBridgeGroup />));
    expect(host.textContent).toContain("正在读取");
    expect(host.textContent).not.toContain("尚未配置任何");
    await act(async () => reject(new Error("offline")));
    expect(host.textContent).toContain("offline");
    expect((host.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
    mocks.invoke.mockResolvedValue({ enabled: false, servers: [] });
    const retry = [...host.querySelectorAll("button")].find(b => b.textContent === "重新读取")!;
    await act(async () => retry.click());
    expect(host.textContent).toContain("尚未配置任何");
    expect(host.textContent).not.toContain("offline");
  });
  it("同一帧的重复操作只写入一次，加载页面不会自动探测或启动进程", async () => {
    await act(async () => root.render(<Harness />));
    let finish!: () => void;
    mocks.invoke.mockImplementation((command: string) => command === "mcp_bridge_set_master" ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve({ enabled: true, servers: [] }));
    let first!: Promise<boolean>, second!: Promise<boolean>;
    await act(async () => { first = bridge.setMaster(true); second = bridge.setMaster(true); });
    expect(await second).toBe(false);
    expect(mocks.invoke.mock.calls.filter(c => c[0] === "mcp_bridge_set_master")).toHaveLength(1);
    await act(async () => { finish(); await first; });
    expect(bridge.busy).toBe(null);
    expect(mocks.invoke.mock.calls.some(c => c[0] === "mcp_bridge_probe")).toBe(false);
  });
  it("写入成功但刷新失败保留旧数据、提供错误且不报普通成功", async () => {
    await act(async () => root.render(<Harness />));
    mocks.invoke.mockImplementation((command: string) => command === "mcp_bridge_list" ? Promise.reject(new Error("read denied")) : Promise.resolve());
    let saved = false;
    await act(async () => { saved = await bridge.setMaster(true); });
    expect(saved).toBe(true);
    expect(bridge.data?.enabled).toBe(false);
    expect(bridge.error).toContain("read denied");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("操作已完成，但列表刷新失败"), "warning");
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.anything(), "success");
  });
  it("写入失败返回 false 以保留确认框与参数，且不会刷新成假成功", async () => {
    await act(async () => root.render(<Harness />));
    mocks.invoke.mockRejectedValue(new Error("write denied"));
    let saved = true;
    await act(async () => { saved = await bridge.setEnabled("files", true); });
    expect(saved).toBe(false);
    expect(bridge.saveError).toContain("write denied");
    expect(bridge.busy).toBe(null);
    expect(mocks.invoke.mock.calls.filter(c => c[0] === "mcp_bridge_list")).toHaveLength(1);
  });
  it("过期读取不能覆盖新状态或错误", async () => {
    await act(async () => root.render(<Harness />));
    let finishOld!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    let oldRead!: Promise<boolean>;
    await act(async () => { oldRead = bridge.reload(); });
    mocks.invoke.mockResolvedValue({ enabled: true, servers: [] });
    await act(async () => { await bridge.reload(); });
    await act(async () => { finishOld({ enabled: false, servers: [] }); await oldRead; });
    expect(bridge.data?.enabled).toBe(true);
    expect(bridge.loading).toBe(false);
  });
  it("导入完成但列表读取失败不先弹导入成功", async () => {
    await act(async () => root.render(<Harness />));
    mocks.invoke.mockImplementation((command: string) => command === "mcp_bridge_import" ? Promise.resolve({ imported: ["files"], skipped: [] }) : Promise.reject(new Error("offline")));
    await act(async () => { await bridge.importSelected(["files"]); });
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.anything(), "success");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("操作已完成"), "warning");
  });
  it("参数保存失败时确认框与命令保持可见，可直接重试同一份参数", async () => {
    await act(async () => root.render(<McpBridgeGroup />));
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent?.includes("手动添加"))!.click());
    await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "提交测试参数")!.click());
    await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    mocks.invoke.mockRejectedValueOnce(new Error("write denied"));
    await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "保存")!.click());
    expect(document.body.textContent).toContain("保存未完成");
    expect(document.body.textContent).toContain("node draft-server.js");
    const retry = [...document.querySelectorAll("button")].find(b => b.textContent === "保存")!;
    expect(retry.disabled).toBe(false);
    await act(async () => retry.click());
    expect(mocks.invoke.mock.calls.filter(c => c[0] === "mcp_bridge_upsert").map(c => c[1])).toEqual([
      { server: { name: "draft", command: "node", args: ["draft-server.js"], env: null, cwd: null } },
      { server: { name: "draft", command: "node", args: ["draft-server.js"], env: null, cwd: null } },
    ]);
    expect(document.body.textContent).not.toContain("保存未完成");
  });
});
