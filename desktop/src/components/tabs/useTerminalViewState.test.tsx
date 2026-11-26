// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalViewState } from "./useTerminalViewState";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement, area: HTMLDivElement;
let api: ReturnType<typeof useTerminalViewState>;
const setCollapsed = vi.fn();
function Harness() {
  api = useTerminalViewState({ current: area }, "s1", { collapsed: false, setCollapsed });
  return null;
}
function press(key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  const e = new KeyboardEvent("keydown", {
    key,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}
/** 焦点放进一个应用自己的输入框（重命名 / 查找 / 弹窗）。 */
function focusInput() {
  const input = document.createElement("input");
  host.append(input);
  input.focus();
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  area = document.createElement("div");
  document.body.append(host, area);
  Object.defineProperty(area, "offsetParent", { configurable: true, get: () => document.body });
  root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  area.remove();
});

describe("Ctrl+Shift+B / F11 的「正在打字」守卫", () => {
  it("正常按下：折叠侧栏 / 切全屏", () => {
    press("b", { ctrlKey: true, shiftKey: true });
    expect(setCollapsed).toHaveBeenCalledTimes(1);
    expect(api.fullscreen).toBe(false);
    press("F11");
    expect(api.fullscreen).toBe(true);
  });

  it("🔴 输入框里打字时两个键都不抢（重命名标签 / 查找框 / 弹窗输入）", () => {
    const input = focusInput();
    const b = press("b", { ctrlKey: true, shiftKey: true });
    expect(b.defaultPrevented).toBe(false);
    expect(setCollapsed).not.toHaveBeenCalled();
    const f11 = press("F11");
    expect(f11.defaultPrevented).toBe(false);
    expect(api.fullscreen).toBe(false);
    input.remove();
  });

  it("终端自己的 textarea 聚焦时照常生效（那不是「在应用输入框里打字」）", () => {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const ta = document.createElement("textarea");
    xterm.append(ta);
    host.append(xterm);
    ta.focus();
    press("b", { ctrlKey: true, shiftKey: true });
    expect(setCollapsed).toHaveBeenCalledTimes(1);
    press("F11");
    expect(api.fullscreen).toBe(true);
    xterm.remove();
  });
});