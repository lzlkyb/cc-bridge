// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiscoveryGuide } from "./DiscoveryGuide";
import type { DiscoveryScenario } from "./discovery";
import { status } from "./mock";

vi.mock("../../components/tabs/TokenManager", () => ({ TokenManager: () => <section>Token 管理</section> }));
vi.mock("../../components/tabs/connect/PermissionCard", () => ({ PermissionCard: () => <section>权限设置</section> }));
vi.mock("../../components/tabs/SshConnectionDialog", () => ({ SshConnectionDialog: () => null }));
vi.mock("../../hooks/useCopyFeedback", () => ({ useCopyFeedback: () => ({ copy: vi.fn(), isCopied: () => false }) }));

let root: Root, host: HTMLDivElement;
const selectDirect = vi.fn();
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(text))!;
const tick = (ms = 600) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const click = (text: string) => act(async () => { button(text).click(); });
const mount = async (scenario: DiscoveryScenario) => {
  await act(async () => root.render(<DiscoveryGuide scenario={scenario} status={status} refresh={() => {}} onChooseDirect={selectDirect}/>));
  await tick();
};
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  Element.prototype.scrollIntoView = vi.fn(); selectDirect.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(Element.prototype, "scrollIntoView"); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("upgrades an existing project without asking for its path or creating another MCP", async () => {
  await mount("existing-project");
  expect(host.textContent).toContain("已找到「订单系统」的原有接入");
  expect(button("改用隧道连接").disabled).toBe(false);
  expect(host.querySelector("#sc-manual-path")).toBeNull();
  expect(host.querySelector(".connect-advanced")?.hasAttribute("open")).toBe(false);
  await click("改用隧道连接");
  expect(host.querySelectorAll('[aria-label="接入进度"] li')).toHaveLength(3);
  for (let step = 0; step < 3; step++) await tick(800);
  expect(host.textContent).toContain("已改用隧道连接");
  expect(host.textContent).toContain("请重新打开服务器上的 Claude Code");
  expect(host.textContent).not.toContain("Claude Code 已连接");
});
it("routes IP selection to the incumbent flow instead of showing a new direct design", async () => {
  await mount("existing-project"); await click("IP 直连");
  expect(selectDirect).toHaveBeenCalledWith("cloud");
  expect(host.querySelector('[aria-label="选择新的本机 IP"]')).toBeNull();
});
it("allows global first setup and picks a recent project without typing its directory", async () => {
  await mount("first-time");
  expect(button("一键接入").disabled).toBe(false);
  await click("只在一个项目使用");
  expect(button("一键接入")).toBeUndefined();
  expect(host.textContent).not.toContain("VPN 重连，MCP 地址不变");
  await click("网站项目");
  expect(button("一键接入").disabled).toBe(false);
  expect(host.textContent).toContain("将接入「网站项目」");
  expect(host.querySelector("#sc-manual-path")).toBeNull();
});
it("requires an explicit existing target when several projects were found", async () => {
  await mount("multiple");
  expect(button("一键接入")).toBeUndefined();
  expect(host.textContent).toContain("选择要升级的接入");
  await click("网站项目");
  expect(host.textContent).toContain("已找到「网站项目」的原有接入");
  expect(button("改用隧道连接").disabled).toBe(false);
});
it("offers only folder navigation and applies the selected directory", async () => {
  await mount("first-time"); await click("只在一个项目使用"); await click("浏览服务器文件夹");
  await click("orders"); await click("选用此文件夹");
  expect(host.textContent).toContain("将接入「订单系统」");
  expect(host.textContent).not.toMatch(/上传文件|删除文件|下载文件/);
});
it("shows current directory only when the preview has a verified terminal directory", async () => {
  await mount("current-directory"); await click("只在一个项目使用");
  expect(button("使用当前目录")).toBeDefined();
  await click("使用当前目录");
  expect(host.textContent).toContain("将接入「网站项目」");
});
it("does not enable setup after inspection failed, and checks a chosen project before updating", async () => {
  await mount("unavailable");
  expect(button("一键接入").disabled).toBe(true);
  await click("选择一个项目再检查"); await click("订单系统");
  expect(host.textContent).toContain("正在检查服务器上的接入");
  await tick();
  expect(button("改用隧道连接").disabled).toBe(false);
});
