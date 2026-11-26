// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalGlobalSearch } from "./TerminalGlobalSearch";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { SshConnection } from "../../lib/types";

const h = vi.hoisted(() => ({ activate: vi.fn(), close: vi.fn(), scrollToLine: vi.fn(), focus: vi.fn() }));
vi.mock("../../lib/terminalRegistry", () => ({
  getTerminal: () => ({ scrollToLine: h.scrollToLine, focus: h.focus }),
  listTerminals: () => [{ sessionId: "a", term: { buffer: { active: {} } } }],
}));
vi.mock("../../lib/terminalGlobalSearch", () => ({
  MAX_HITS: 200,
  searchAllReport: () => ({ hits: [{ sessionId: "a", line: 3, text: "hello world" }], invalidPattern: false, truncated: false }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const conn = { id: "c1", name: "dev", host: "192.0.2.10" } as SshConnection;
const sessions: SshSessionRef[] = [{ sessionId: "a", tabId: "ta", conn, closedReason: null }];
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<TerminalGlobalSearch sessions={sessions} onActivate={h.activate} onClose={h.close} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const input = () => host.querySelector<HTMLInputElement>("input")!;
function type(text: string) {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const waitDebounce = () => act(async () => {
  await new Promise((r) => setTimeout(r, 220));
});
function esc(opts: { composing?: boolean; target?: Element } = {}) {
  const e = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    isComposing: opts.composing ?? false,
  });
  act(() => {
    (opts.target ?? window).dispatchEvent(e);
  });
  return e;
}

describe("跨标签搜索：跳转与 Esc", () => {
  it("🔴 点结果跳转即关窗：否则焦点已交给终端，遮罩还盖着整屏，Esc 只能发给远端", async () => {
    type("hello");
    await waitDebounce();
    const hit = host.querySelector<HTMLButtonElement>("button[title^='跳到']")!;
    expect(hit).toBeTruthy();
    await act(async () => hit.click());
    expect(h.activate).toHaveBeenCalledWith("a");
    expect(h.scrollToLine).toHaveBeenCalledWith(3);
    expect(h.focus).toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("Esc 关窗（焦点在输入框里）", () => {
    input().focus();
    const e = esc();
    expect(e.defaultPrevented).toBe(true);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("🔴 IME 组词中的 Esc 属于输入法：不关窗", () => {
    input().focus();
    esc({ composing: true });
    expect(h.close).not.toHaveBeenCalled();
  });

  it("🔴 焦点在终端里时 Esc 原样留给远端（vim / Claude Code 的刚需）", () => {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    xterm.tabIndex = 0;
    host.append(xterm);
    xterm.focus();
    const e = esc({ target: xterm });
    expect(e.defaultPrevented).toBe(false);
    expect(h.close).not.toHaveBeenCalled();
    xterm.remove();
  });

  it("焦点不在输入框也不在终端（Tab 出了浮层）时 Esc 仍能关窗", () => {
    const btn = document.createElement("button");
    host.append(btn);
    btn.focus();
    esc({ target: btn });
    expect(h.close).toHaveBeenCalledTimes(1);
    btn.remove();
  });
});