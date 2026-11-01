// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useTerminalFocusReturn } from "./useTerminalFocusReturn";

let root: Root, host: HTMLDivElement, term: { focus: ReturnType<typeof vi.fn> };
const focusedRef = { current: false };
const termRef: { current: Terminal | null } = { current: null };
const hostsRef: { current: (Element | null)[] } = { current: [] };
let chrome: HTMLDivElement, input: HTMLInputElement;

function Probe() {
  useTerminalFocusReturn(termRef, focusedRef, hostsRef);
  return null;
}

/** 真实指针序列：pointerdown（capture）→ 浏览器移焦点 → click（冒泡）→ 我们的处理。 */
function clickOn(el: Element) {
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  act(() => {
    (el as HTMLElement).focus?.();
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  term = { focus: vi.fn() };
  termRef.current = term as unknown as Terminal;
  focusedRef.current = false;
  host = document.createElement("div");
  document.body.append(host);
  chrome = document.createElement("div");
  chrome.innerHTML = `<button id="copy">复制</button><input id="search" /><div id="canvas"></div>`;
  host.append(chrome);
  input = chrome.querySelector<HTMLInputElement>("#search")!;
  hostsRef.current = [chrome];
  root = createRoot(host.appendChild(document.createElement("div")));
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("useTerminalFocusReturn", () => {
  it("🔴 终端持有焦点时点工具栏按钮 → 动作后焦点回到终端", () => {
    focusedRef.current = true; // 点击前终端是聚焦的
    clickOn(chrome.querySelector("#copy")!);
    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it("点击时终端本来就没聚焦（用户从别处点进来）→ 不抢焦点", () => {
    focusedRef.current = false;
    clickOn(chrome.querySelector("#copy")!);
    expect(term.focus).not.toHaveBeenCalled();
  });

  it("点在属于本终端 chrome 之外的地方 → 不抢焦点", () => {
    focusedRef.current = true;
    const outside = document.createElement("button");
    document.body.append(outside);
    clickOn(outside);
    outside.remove();
    expect(term.focus).not.toHaveBeenCalled();
  });

  it("动作自己把焦点拿走了（搜索框自动聚焦）→ 不抢", () => {
    focusedRef.current = true;
    act(() => {
      chrome.querySelector("#copy")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    act(() => {
      input.focus(); // 等价于「打开查找框后 input 自动聚焦」
      chrome.querySelector("#copy")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
    expect(term.focus).not.toHaveBeenCalled();
  });

  it("点在输入框上 → 不抢", () => {
    focusedRef.current = true;
    clickOn(input);
    expect(term.focus).not.toHaveBeenCalled();
  });
});
