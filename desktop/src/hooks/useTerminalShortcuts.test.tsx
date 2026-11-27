// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTerminalShortcuts } from "./useTerminalShortcuts";
import { toast } from "../components/ui/toast";

vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
let clipboardDescriptor: PropertyDescriptor | undefined;
const terminalKeydown = vi.fn();
const writeText = vi.fn<(text: string) => Promise<void>>();
const getSelection = vi.fn<() => string>();
const hasSelection = vi.fn<() => boolean>();
const clearSelection = vi.fn();
const args = {
  sessionId: "shortcuts",
  termRef: { current: { getSelection, hasSelection, clearSelection } as unknown as Terminal },
  focusedRef: { current: true },
  closedRef: { current: false },
  pasteRef: { current: async () => false },
  pasteImageRef: { current: () => undefined },
  cwdRef: { current: null },
  fontZoomRef: { current: () => undefined },
};

function Harness() {
  useTerminalShortcuts(args);
  return null;
}

function keydown(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, ...init });
  host.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  hasSelection.mockReturnValue(true);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  host = document.createElement("div");
  host.addEventListener("keydown", terminalKeydown);
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness/>));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
});

it("空白选区的 Ctrl+C 保留选区和剪贴板，也不会送到终端", () => {
  getSelection.mockReturnValue("   \n   ");
  expect(keydown({ key: "c" }).defaultPrevented).toBe(true);
  expect(terminalKeydown).not.toHaveBeenCalled();
  expect(writeText).not.toHaveBeenCalled();
  expect(clearSelection).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith("选区中没有可复制的文字", "info");
  hasSelection.mockReturnValue(false);
  expect(keydown({ key: "c" }).defaultPrevented).toBe(false);
  expect(terminalKeydown).toHaveBeenCalledOnce();
});

it("剪贴板拒绝写入时保留选区并提示失败", async () => {
  getSelection.mockReturnValue("selected");
  writeText.mockRejectedValueOnce(new Error("Clipboard access denied"));
  await act(async () => { keydown({ key: "c" }); });
  expect(writeText).toHaveBeenCalledWith("selected");
  expect(terminalKeydown).not.toHaveBeenCalled();
  expect(clearSelection).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith("复制失败", "error");
});

it("Windows 输入法的 Ctrl+C 保持系统默认动作，其他组合键继续传递", () => {
  expect(keydown({ key: "Process", code: "KeyC", isComposing: true }).defaultPrevented).toBe(false);
  expect(terminalKeydown).not.toHaveBeenCalled();
  const other = keydown({ key: "Process", code: "KeyV", isComposing: true });
  expect(terminalKeydown).toHaveBeenCalledExactlyOnceWith(other);
});
