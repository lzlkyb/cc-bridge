// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";
import { ToastProvider } from "../../ui/toast";
import { applyAppearance, initializeAppearance } from "../../../lib/appearance";
import { applyTheme } from "../../../lib/theme";
import { searchSettings } from "../../../lib/settingsNavigation";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const button = (name: string) => [...host.querySelectorAll("button")].find(node => node.textContent === name || node.querySelector("b")?.textContent === name)!;
beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  initializeAppearance();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const mount = () => act(async () => root.render(<ToastProvider><textarea defaultValue="保留草稿" /><AppearanceSettings /></ToastProvider>));

describe("设置 → 应用 → 外观", () => {
  it("从经典切换到玻璃并记住选择，草稿节点和值保持不变", async () => {
    await mount();
    const draft = host.querySelector("textarea")!;
    draft.value = "正在编辑的内容";
    expect(button("经典").getAttribute("aria-checked")).toBe("true");
    await act(async () => button("柔光玻璃").click());
    expect(button("柔光玻璃").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("cc-bridge.ui-style")).toBe("glass");
    expect(host.querySelector("textarea")).toBe(draft);
    expect(draft.value).toBe("正在编辑的内容");
  });

  it("外部风格和顶栏明暗切换都会同步选择状态，且两者互不覆盖", async () => {
    await mount();
    await act(async () => { applyAppearance("glass"); applyTheme("dark"); });
    expect(button("柔光玻璃").getAttribute("aria-checked")).toBe("true");
    expect(button("深色").getAttribute("aria-checked")).toBe("true");
    await act(async () => button("浅色").click());
    expect(button("柔光玻璃").getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    await act(async () => button("经典").click());
    expect(button("浅色").getAttribute("aria-checked")).toBe("true");
  });

  it("存储写失败仍选中玻璃，并提示没有记住选择", async () => {
    await mount();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full"); });
    await act(async () => button("柔光玻璃").click());
    expect(button("柔光玻璃").getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("外观已切换，但暂时无法记住选择。");
  });

  it.each(["外观", "玻璃", "经典", "深色"])("搜索 %s 定位到应用卡片", query => {
    expect(searchSettings(query, ["set-app"]).some(item => item.id === "set-appearance" && item.sectionId === "set-app")).toBe(true);
  });
});
