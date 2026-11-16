// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConnectionCopy } from "./useConnectionCopy";
import type { StaticStatus } from "../lib/types";
import { CurrentAccessAddress } from "../components/tabs/connect/CurrentAccessAddress";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), write: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../lib/utils", async original => ({ ...await original<typeof import("../lib/utils")>(),
  copyText: async (text: string, copied: () => void, failed: (error: unknown) => void) => {
    try { await mocks.write(text); copied(); } catch (error) { failed(error); }
  },
}));
let root: Root, host: HTMLDivElement, api: ReturnType<typeof useConnectionCopy>;
const status = (key: string) => ({ currentAccess: { method: "direct", targetKey: key } }) as StaticStatus;
function Harness({ target = "a" }: { target?: string }) { api = useConnectionCopy(status(target)); return <span>{api.isCopied("command") ? "已复制" : "复制"}</span>; }
const mount = (target = "a") => act(async () => root.render(<Harness target={target}/>));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockReset().mockImplementation(async (name: string) => name === "get_connection_copy" ? { text: "current-command", targetKey: "a" } : undefined);
  mocks.write.mockReset().mockResolvedValue(undefined); mocks.toast.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("成功写入剪贴板后才保存命令收据，复制地址不保存接入", async () => {
  await mount();
  await act(async () => { expect(await api.copy("address")).toBe(true); });
  expect(mocks.invoke.mock.calls.filter(call => call[0] === "connection_command_copied")).toHaveLength(0);
  await act(async () => { expect(await api.copy("command")).toBe(true); });
  expect(mocks.write).toHaveBeenLastCalledWith("current-command");
  expect(mocks.invoke).toHaveBeenCalledWith("connection_command_copied", { targetKey: "a" });
  expect(host.textContent).toBe("已复制");
});
it("剪贴板失败不保存收据、不显示成功，并允许重试", async () => {
  await mount(); mocks.write.mockRejectedValueOnce(new Error("clipboard unavailable"));
  await act(async () => { expect(await api.copy("command")).toBe(false); });
  expect(host.textContent).toBe("复制");
  expect(mocks.invoke.mock.calls.filter(call => call[0] === "connection_command_copied")).toHaveLength(0);
  await act(async () => { expect(await api.copy("command")).toBe(true); });
});
it("复制更新命令后记录已提供的地址，保留用户单独确认的步骤", async () => {
  await mount();
  mocks.write.mockRejectedValueOnce(new Error("clipboard unavailable"));
  await act(async () => { expect(await api.copy("ip-update")).toBe(false); });
  expect(mocks.invoke).not.toHaveBeenCalledWith("connection_update_copied", expect.anything());
  await act(async () => { expect(await api.copy("ip-update")).toBe(true); });
  expect(mocks.invoke).toHaveBeenCalledWith("connection_update_copied", { targetKey: "a" });
  expect(mocks.invoke).not.toHaveBeenCalledWith("confirm_connection_update", expect.anything());
});
it("显示待验证地址并由用户确认远端直连更新", async () => {
  const value = { currentAccess: { method: "direct", targetKey: "a", address: "http://10.0.0.3:7823/mcp",
    previousAddress: "http://10.0.0.2:7823/mcp", canConfirmUpdate: true } } as StaticStatus;
  await act(async () => root.render(<CurrentAccessAddress status={value}/>));
  expect(host.textContent).toContain("在服务器执行更新命令");
  const confirm = [...host.querySelectorAll("button")].find(button => button.textContent === "已验证直连更新")!;
  await act(async () => confirm.click());
  expect(mocks.invoke).toHaveBeenCalledWith("confirm_connection_update", { targetKey: "a" });
});
it("生成过程中切换目标，迟到命令不能写剪贴板", async () => {
  const request = deferred<{ text: string; targetKey: string }>();
  mocks.invoke.mockReturnValueOnce(request.promise); await mount();
  const operation = api.copy("command"); await mount("b");
  await act(async () => { request.resolve({ text: "old-command", targetKey: "a" }); expect(await operation).toBe(false); });
  expect(mocks.write).not.toHaveBeenCalled();
  expect(host.textContent).toBe("复制");
});
it("剪贴板完成前切换目标，不触发旧收据或旧成功反馈", async () => {
  const write = deferred<void>(); mocks.write.mockReturnValueOnce(write.promise);
  await mount(); let operation!: Promise<boolean>;
  await act(async () => { operation = api.copy("command"); });
  await mount("b");
  await act(async () => { write.resolve(); expect(await operation).toBe(false); });
  expect(mocks.invoke.mock.calls.filter(call => call[0] === "connection_command_copied")).toHaveLength(0);
  expect(host.textContent).toBe("复制");
});
it("卸载后的迟到结果不写剪贴板，也不弹出旧提示", async () => {
  const request = deferred<{ text: string; targetKey: string }>(); mocks.invoke.mockReturnValueOnce(request.promise);
  await mount(); const operation = api.copy("command"); await act(async () => root.render(null));
  request.resolve({ text: "old", targetKey: "a" }); expect(await operation).toBe(false);
  expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
});
it("页面展示内容与当前后台命令不同时拒绝复制", async () => {
  await mount();
  await act(async () => { expect(await api.copy("command", undefined, "different-draft")).toBe(false); });
  expect(mocks.write).not.toHaveBeenCalled();
});
