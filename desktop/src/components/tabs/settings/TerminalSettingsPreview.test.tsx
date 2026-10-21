// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ViewActivityContext } from "../../../lib/viewActivity";
import { TerminalSettingsPreview } from "./TerminalSettingsPreview";

const h = vi.hoisted(() => ({ created: vi.fn(), disposed: vi.fn(), fit: vi.fn(), writes: vi.fn(), observe: vi.fn(), disconnect: vi.fn(), unsubscribe: vi.fn(), resize: null as null | (() => void), mode: "dark", width: 350 }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: object; textarea = document.createElement("textarea");
  constructor(options: object) { this.options = options; h.created(options); }
  loadAddon() {} open() {} write(value: string) { h.writes(value); } dispose() { h.disposed(); }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() { h.fit(); } } }));
vi.mock("../../../hooks/useTerminalAppearance", () => ({ useTerminalThemeMode: () => h.mode, useTerminalFontStack: () => "Consolas" }));
vi.mock("../../../hooks/useTerminalPreset", () => ({ useTerminalPreset: () => "indigo" }));
vi.mock("../../../lib/bundledFonts", () => ({ isBundledFontsReady: () => true, subscribeBundledFonts: () => h.unsubscribe }));
let root: Root, host: HTMLDivElement;
const render = (active: boolean) => act(async () => root.render(<ViewActivityContext.Provider value={active}><TerminalSettingsPreview /></ViewActivityContext.Provider>));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks(); h.mode = "dark"; h.width = 350;
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { h.resize = cb; } observe() { h.observe(); } disconnect() { h.disconnect(); } });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => h.width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("隐藏分类不创建终端，显示后仅写示例；主题切换不重建也不抢焦点", async () => {
  await render(false); expect(h.created).not.toHaveBeenCalled();
  await render(true); expect(h.created).toHaveBeenCalledTimes(1); expect(h.writes).toHaveBeenCalledTimes(1);
  expect(h.created).toHaveBeenCalledWith(expect.objectContaining({ disableStdin: true, cursorBlink: false }));
  h.mode = "light"; await render(true); expect(h.created).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(document.body);
  await render(false); expect(h.disposed).toHaveBeenCalledTimes(1); expect(h.disconnect).toHaveBeenCalledTimes(1); expect(h.unsubscribe).toHaveBeenCalledTimes(1);
});

it("紧凑预览未展开时延迟分配，展开的尺寸变化后才创建", async () => {
  h.width = 0; await render(true); expect(h.created).not.toHaveBeenCalled();
  h.width = 350; await act(async () => h.resize?.()); expect(h.created).toHaveBeenCalledTimes(1);
  await render(false); await act(async () => h.resize?.()); expect(h.created).toHaveBeenCalledTimes(1);
});
