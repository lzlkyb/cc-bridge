// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StableManualFix } from "./StableManualFix";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), copy: vi.fn(), toast: vi.fn() }));
vi.mock("../../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../../lib/utils", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/utils")>()),
  copyText: mocks.copy,
}));
vi.mock("../../ui/toast", () => ({ toast: mocks.toast }));

const COMMAND = "cd \"/srv/orders\" && sed -i.bak 's#https\\?://[0-9.]*:7823/mcp#http://127.0.0.1:17903/mcp#g' .mcp.json && rm -f .mcp.json.bak";
let root: Root, host: HTMLDivElement;
const flush = () => act(async () => {});
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === name);
const mount = async () => { await act(async () => root.render(<StableManualFix tunnelPort={17903} directUrl="http://10.0.7.215:7823/mcp"/>)); await flush(); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.copy.mockImplementation((_text: string, done: () => void) => { done(); return Promise.resolve(); });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("展示后端生成的兜底命令与写入位置", async () => {
  mocks.invoke.mockResolvedValue({ cmd: COMMAND, scopeLabel: "隧道固定地址 · 项目级 .mcp.json" });
  await mount();
  expect(mocks.invoke).toHaveBeenCalledWith("get_ip_sed_command");
  // 命令只换地址：隧道固定端口必须出现，旧直连地址作为说明一并展示。
  expect(host.textContent).toContain("http://127.0.0.1:17903/mcp");
  expect(host.textContent).toContain("http://10.0.7.215:7823/mcp");
  expect(host.textContent).toContain("隧道固定地址 · 项目级 .mcp.json");
  expect(host.querySelector(".code-box code")?.textContent).toBe(COMMAND);
});

it("复制的是完整命令，成功后才亮已复制", async () => {
  mocks.invoke.mockResolvedValue({ cmd: COMMAND, scopeLabel: "隧道固定地址 · 项目级 .mcp.json" });
  await mount();
  await act(async () => button("复制")!.click());
  expect(mocks.copy).toHaveBeenCalledTimes(1);
  expect(mocks.copy.mock.calls[0][0]).toBe(COMMAND);
  expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("已复制"), "success");
  expect(button("已复制")).toBeDefined();
});

it("拿不到命令时说明原因，且不给一个能点空的复制按钮", async () => {
  mocks.invoke.mockRejectedValue("隧道固定端口尚未分配，请先完成一次接入。");
  await mount();
  expect(host.textContent).toContain("暂时拿不到这条命令");
  expect(host.textContent).toContain("隧道固定端口尚未分配");
  expect(button("复制")!.disabled).toBe(true);
  expect(mocks.copy).not.toHaveBeenCalled();
});
