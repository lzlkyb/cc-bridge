// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { SettingsTab } from "./SettingsTab";
import { SETTINGS_CATEGORIES } from "../../lib/settingsCategories";

vi.mock("./settings/AppGroup", () => ({ AppGroup: () => <div id="app-style" tabIndex={-1}><input aria-label="应用草稿" defaultValue="原内容" /></div> }));
vi.mock("./settings/TerminalGroup", () => ({ TerminalGroup: () => <div id="terminal-size" tabIndex={-1}>字号</div> }));
vi.mock("./settings/NetworkGroup", () => ({ NetworkGroup: () => null }));
vi.mock("./settings/SecurityGroup", () => ({ SecurityGroup: () => null }));
vi.mock("./settings/AdvancedGroup", () => ({ AdvancedGroup: () => null }));
vi.mock("./settings/mcpbridge/McpBridgeGroup", () => ({ McpBridgeGroup: () => null }));
vi.mock("./settings/NotifyGroup", () => ({ NotifyGroup: () => null }));
vi.mock("./settings/InstallGroup", () => ({ InstallGroup: () => null }));
vi.mock("./settings/ApplicationSettingsPreview", () => ({ ApplicationSettingsPreview: () => null }));
vi.mock("./settings/SettingsDataPage", () => ({ SettingsDataPage: () => null }));
vi.mock("./firewall/FirewallGroup", () => ({ FirewallGroup: () => null }));
vi.mock("./AboutGroup", () => ({ AboutGroup: () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const select = vi.fn(), scrollIntoView = vi.fn();
let nonce = 0;
beforeEach(() => {
  vi.useFakeTimers(); select.mockClear(); scrollIntoView.mockClear();
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(category: string, anchor = category) {
  await act(async () => root.render(<SettingsTab sections={SETTINGS_CATEGORIES} activeSection={category} onActiveSectionChange={select} onSaved={() => {}} highlightAnchor={{ anchor, nonce: ++nonce }} />));
  await act(async () => vi.runAllTimers());
}
describe("设置分类导航", () => {
  it("返回分类保留草稿节点与滚动位置，而不是导航后清零", async () => {
    await render("set-app");
    const panel = host.querySelector<HTMLElement>('[data-category="set-app"]')!;
    const input = host.querySelector<HTMLInputElement>('input')!;
    input.value = "尚未保存的草稿"; panel.scrollTop = 240;
    await render("set-terminal");
    expect(panel.hidden).toBe(true);
    await render("set-app");
    expect(panel.hidden).toBe(false); expect(panel.scrollTop).toBe(240);
    expect(host.querySelector("input")).toBe(input); expect(input.value).toBe("尚未保存的草稿");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
  it("具体深链接滚动到控件并给予焦点", async () => {
    await render("set-terminal", "terminal-size");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
    expect(document.activeElement?.id).toBe("terminal-size");
  });
  it("旧设置锚点先映射到新分类，不在无关分类内寻找", async () => {
    await render("set-app", "toggle-encoding");
    expect(select).toHaveBeenCalledWith("set-files");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
  it("右侧滚轮切换后，已处理的旧导航锚点不会把分类拉回去", async () => {
    const anchor = { anchor: "set-app", nonce: ++nonce };
    const show = async (category: string) => {
      await act(async () => root.render(<SettingsTab sections={SETTINGS_CATEGORIES} activeSection={category} onActiveSectionChange={select} onSaved={() => {}} highlightAnchor={anchor} />));
      await act(async () => vi.runAllTimers());
    };
    await show("set-app");
    await act(async () => { host.querySelector('[data-category="set-app"]')!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 })); });
    expect(select).toHaveBeenCalledExactlyOnceWith("set-terminal");
    await show("set-terminal");
    expect(select).toHaveBeenCalledExactlyOnceWith("set-terminal");
    expect(host.querySelector<HTMLElement>('[data-category="set-terminal"]')!.hidden).toBe(false);
  });
});
