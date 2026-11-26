// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useTerminalTypography } from "./useTerminalTypography";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement, container: HTMLDivElement, screen: HTMLDivElement;
let api: ReturnType<typeof useTerminalTypography>;
let term: Terminal;
const doFit = vi.fn();
const reached: WheelEvent[] = [];

function Harness() {
  api = useTerminalTypography({ termRef: { current: term }, containerRef: { current: container }, doFit });
  return null;
}

/** xterm 的 wheel 监听挂在容器子元素上：用它有没有收到事件判断「这一格会不会发给远端」。 */
function wheel(init: WheelEventInit) {
  const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, ...init });
  act(() => {
    screen.dispatchEvent(e);
  });
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  reached.length = 0;
  host = document.createElement("div");
  container = document.createElement("div");
  screen = document.createElement("div");
  screen.className = "xterm";
  container.append(screen);
  host.append(container);
  document.body.append(host);
  screen.addEventListener("wheel", (e) => reached.push(e));
  term = { options: { fontSize: 14, fontFamily: "monospace" } } as unknown as Terminal;
  root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Ctrl+滚轮缩放字号", () => {
  it("🔴 缩放时这一格不能落到 xterm：否则远端 TUI 同时滚一屏（报告已经发出去了）", async () => {
    const before = api.fontSize;
    const e = wheel({ ctrlKey: true });
    expect(e.defaultPrevented).toBe(true); // 否则 WebView 缩放整页
    expect(reached).toHaveLength(0); // xterm 收不到 ⇒ 不会编码成 SGR 报告 / 滚 scrollback
    await act(async () => {});
    expect(api.fontSize).toBe(before + 1);
  });

  it("普通滚轮照常交给 xterm（本地滚动 / SGR 转发都不受影响）", () => {
    const e = wheel({});
    expect(e.defaultPrevented).toBe(false);
    expect(reached).toHaveLength(1);
  });

  it("Shift+滚轮也不被缩放分支拦（它归滚轮守卫的本地历史）", () => {
    wheel({ shiftKey: true });
    expect(reached).toHaveLength(1);
  });
});