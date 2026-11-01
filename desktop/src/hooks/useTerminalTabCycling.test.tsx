// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalTabCycling } from "./useTerminalTabCycling";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
const activate = vi.fn();

function Probe({ ids, activeId }: { ids: string[]; activeId: string | null }) {
  useTerminalTabCycling(ids, activeId, activate);
  return null;
}

function render(ids: string[], activeId: string | null) {
  act(() => root.render(<Probe ids={ids} activeId={activeId} />));
}
function press(key: string, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  const e = new KeyboardEvent("keydown", {
    key,
    ctrlKey: mods.ctrlKey ?? true,
    shiftKey: mods.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("useTerminalTabCycling", () => {
  it("终端自身 textarea 聚焦时仍可切标签", () => {
    render(["a", "b"], "a");
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const input = document.createElement("textarea");
    terminal.append(input); host.append(terminal); input.focus();
    const event = press("Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(activate).toHaveBeenCalledWith("b");
    terminal.remove();
  });
  it("Ctrl+Tab 切下一个，尾部回到第一个；Ctrl+Shift+Tab 反向", () => {
    render(["a", "b", "c"], "b");
    press("Tab");
    expect(activate).toHaveBeenLastCalledWith("c");
    render(["a", "b", "c"], "c");
    press("Tab");
    expect(activate).toHaveBeenLastCalledWith("a");
    render(["a", "b", "c"], "a");
    press("Tab", { shiftKey: true });
    expect(activate).toHaveBeenLastCalledWith("c");
  });

  it("🔴 全屏时靠它够到溢出在滚动区外的标签：事件必须被吃掉（不能落到 WebView 的默认 Tab）", () => {
    render(["a", "b"], "a");
    const e = press("Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(activate).toHaveBeenCalledWith("b");
  });

  it("只有一个标签时不拦截（Tab 仍是正常焦点遍历）", () => {
    render(["a"], "a");
    const e = press("Tab");
    expect(e.defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it("焦点在输入框里时让路（搜索框 / 外观菜单里的输入）", () => {
    render(["a", "b"], "a");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const e = press("Tab");
    expect(e.defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    input.remove();
  });

  it("不带 Ctrl 的 Tab 完全不碰", () => {
    render(["a", "b"], "a");
    press("Tab", { ctrlKey: false });
    expect(activate).not.toHaveBeenCalled();
  });
});
