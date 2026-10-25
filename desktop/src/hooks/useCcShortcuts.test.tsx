// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCcShortcuts } from "./useCcShortcuts";

let root: Root, host: HTMLDivElement;

/** 探针组件：把 onNewSession 接到 mock 上，渲染即挂上 window 监听。 */
function Probe({ onNewSession }: { onNewSession: () => void }) {
  useCcShortcuts({ onNewSession });
  return null;
}

/** 在 `target`（默认 window）上派发一次 keydown。用 bubbles 走真实冒泡路径。 */
const press = async (init: KeyboardEventInit, target: EventTarget = window) => {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("Ctrl+N 开新会话", async () => {
  const onNewSession = vi.fn();
  await act(async () => root.render(<Probe onNewSession={onNewSession} />));
  await press({ code: "KeyN", key: "n", ctrlKey: true });
  expect(onNewSession).toHaveBeenCalledTimes(1);
});

it("mac 上 ⌘N 同样触发", async () => {
  const onNewSession = vi.fn();
  await act(async () => root.render(<Probe onNewSession={onNewSession} />));
  await press({ code: "KeyN", key: "n", metaKey: true });
  expect(onNewSession).toHaveBeenCalledTimes(1);
});

it("Ctrl+N 会 preventDefault，避免被 WebView2 当默认行为吞掉", async () => {
  const onNewSession = vi.fn();
  await act(async () => root.render(<Probe onNewSession={onNewSession} />));
  const ev = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: "KeyN",
    key: "n",
    ctrlKey: true,
  });
  await act(async () => window.dispatchEvent(ev));
  expect(ev.defaultPrevented).toBe(true);
});

it("焦点在输入框时不劫持（输入密码/命令参数的场景）", async () => {
  const onNewSession = vi.fn();
  await act(async () => root.render(<Probe onNewSession={onNewSession} />));
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  await press({ code: "KeyN", key: "n", ctrlKey: true }, input);
  expect(onNewSession).not.toHaveBeenCalled();
  input.remove();
});

it("Ctrl+Shift+N 与裸 n 不触发", async () => {
  const onNewSession = vi.fn();
  await act(async () => root.render(<Probe onNewSession={onNewSession} />));
  await press({ code: "KeyN", key: "N", ctrlKey: true, shiftKey: true });
  await press({ code: "KeyN", key: "n" });
  await press({ code: "KeyM", key: "m", ctrlKey: true });
  expect(onNewSession).not.toHaveBeenCalled();
});

it("长按只触发一次（e.repeat）", async () => {
  const onNewSession = vi.fn();
  await act(async () => root.render(<Probe onNewSession={onNewSession} />));
  await press({ code: "KeyN", key: "n", ctrlKey: true, repeat: true });
  expect(onNewSession).not.toHaveBeenCalled();
});

it("Ctrl+Alt+N 不触发（AltGr 是部分布局的字符输入键）", async () => {
  const onNewSession = vi.fn();
  await act(async () => root.render(<Probe onNewSession={onNewSession} />));
  await press({ code: "KeyN", key: "n", ctrlKey: true, altKey: true });
  expect(onNewSession).not.toHaveBeenCalled();
});

it("卸载后不再响应（切走页即卸载）", async () => {
  const onNewSession = vi.fn();
  await act(async () => root.render(<Probe onNewSession={onNewSession} />));
  await act(async () => root.unmount());
  await press({ code: "KeyN", key: "n", ctrlKey: true });
  expect(onNewSession).not.toHaveBeenCalled();
});
