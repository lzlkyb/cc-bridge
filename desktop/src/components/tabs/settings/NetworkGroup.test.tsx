// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { NetworkGroup } from "./NetworkGroup";
import type { StaticStatus } from "../../../lib/types";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../ui/toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("./TransportRow", () => ({ TransportRow: () => null }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const saved = vi.fn();
const status = { port: 7823, firewallEnabled: true, transport: "http" } as StaticStatus;
const mount = (port = 7823) => act(async () => root.render(<StrictMode><NetworkGroup status={{ ...status, port }} onSaved={saved} /></StrictMode>));
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.toast.mockReset(); saved.mockReset();
  mocks.invoke.mockResolvedValue({ restartRequired: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
async function editPort(value: string) {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("端口配置反馈与恢复", () => {
  it("未编辑时跟随服务端刷新，StrictMode 重复调用 updater 也不会回填旧值", async () => {
    await mount(); await mount(8000);
    expect(host.querySelector("input")!.value).toBe("8000");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("重启失败后，即使服务端已更新端口仍能重试，且不重复保存", async () => {
    mocks.invoke.mockImplementation((command: string) => command === "restart_mcp_server" ? Promise.reject(new Error("busy")) : Promise.resolve({ restartRequired: true }));
    await mount(); await editPort("9000");
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("端口已保存，但服务重启失败");
    await mount(9000);
    const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "重试重启服务")!;
    expect(retry.disabled).toBe(false);
    mocks.invoke.mockResolvedValue({});
    await act(async () => retry.click());
    expect(mocks.invoke.mock.calls.filter(call => call[0] === "save_config")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(call => call[0] === "restart_mcp_server")).toHaveLength(2);
    expect(host.textContent).not.toContain("端口已保存，但服务重启失败");
  });
  it("输入可清空且非法端口不能保存，刷新状态不覆盖用户草稿", async () => {
    await mount(); await editPort("");
    expect(host.querySelector("input")!.value).toBe("");
    expect(host.querySelector("button")!.disabled).toBe(true);
    await editPort("9123"); await mount(8000);
    expect(host.querySelector("input")!.value).toBe("9123");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
