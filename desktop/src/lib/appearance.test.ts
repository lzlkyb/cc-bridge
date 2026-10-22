// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAppearance, getAppearance, getStoredAppearance, initializeAppearance, subscribeAppearance } from "./appearance";
import { applyTheme } from "./theme";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.uiStyle;
  document.documentElement.className = "";
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("应用外观偏好", () => {
  it.each([null, "", "GLASS", "unknown"])("缺省或非法存值 %s 默认使用柔光玻璃，初始化不写偏好", value => {
    if (value !== null) localStorage.setItem("cc-bridge.ui-style", value);
    initializeAppearance();
    expect(getAppearance()).toBe("glass");
    expect(localStorage.getItem("cc-bridge.ui-style")).toBe(value);
  });

  it("首次读取界面风格也默认柔光，已保存经典则启动恢复经典", () => {
    expect(getAppearance()).toBe("glass");
    localStorage.setItem("cc-bridge.ui-style", "classic");
    initializeAppearance();
    expect(getAppearance()).toBe("classic");
  });

  it("启动恢复已选玻璃，切回经典后重启也保留", () => {
    localStorage.setItem("cc-bridge.ui-style", "glass");
    initializeAppearance();
    expect(getAppearance()).toBe("glass");
    expect(applyAppearance("classic")).toBe(true);
    document.documentElement.dataset.uiStyle = "glass";
    initializeAppearance();
    expect(getAppearance()).toBe("classic");
    expect(getStoredAppearance()).toBe("classic");
  });

  it("玻璃选择成功持久化；明暗和终端配色保持独立", () => {
    localStorage.setItem("cc-bridge.terminal-mode", "dark");
    applyTheme("dark");
    applyAppearance("glass");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(localStorage.getItem("cc-bridge.terminal-mode")).toBe("dark");
    expect(getStoredAppearance()).toBe("glass");
    applyTheme("light");
    expect(getAppearance()).toBe("glass");
    applyAppearance("classic");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("存储读取被禁用时仍可使用默认柔光", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    expect(initializeAppearance).not.toThrow();
    expect(getAppearance()).toBe("glass");
  });

  it("localStorage 属性本身被禁用也不会阻断启动或切换", () => {
    vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    expect(initializeAppearance).not.toThrow();
    expect(applyAppearance("glass")).toBe(false);
    expect(getAppearance()).toBe("glass");
  });

  it("写入失败时本次风格仍生效并广播，返回未保存", () => {
    applyAppearance("classic");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    const listener = vi.fn();
    const off = subscribeAppearance(listener);
    expect(applyAppearance("glass")).toBe(false);
    expect(getAppearance()).toBe("glass");
    expect(listener).toHaveBeenCalledOnce();
    off();
  });

  it("同值不重复广播，退订后不再接收；不触发明暗主题事件", () => {
    applyAppearance("classic");
    const listener = vi.fn(), themeListener = vi.fn();
    const off = subscribeAppearance(listener);
    window.addEventListener("themechange", themeListener);
    applyAppearance("glass");
    applyAppearance("glass");
    expect(listener).toHaveBeenCalledOnce();
    expect(themeListener).not.toHaveBeenCalled();
    off();
    applyAppearance("classic");
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("themechange", themeListener);
  });
});
