// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SshTerminalToolbar, type SshTerminalToolbarProps } from "./SshTerminalToolbar";
import type { SshConnection } from "../../lib/types";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const noop = () => {};
const actions = { onSearch: vi.fn(), onCopy: vi.fn(), onPaste: vi.fn(), onDisconnect: vi.fn() };
const props: SshTerminalToolbarProps = { pane: true, conn: { name: "server-a", host: "192.0.2.10" } as SshConnection, closed: false, focused: false, inputErr: null, selectMode: false, shiftActive: false, dragSelecting: false, fullscreen: false, imgBusy: false, ...actions, onCopyScreen: noop, onPasteImage: noop, onRepaint: noop, onToggleSelectMode: noop, onClear: noop, onToggleFullscreen: noop, onExport: noop };
async function render(closed = false) { await act(async () => root.render(<SshTerminalToolbar {...props} closed={closed}/>)); }
async function menu() { await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="更多"]')!.click()); }
function item(label: string) { return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(e => e.textContent?.startsWith(label))!; }
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("每格就地查找，更多菜单保留复制、图片、历史和明确的断开入口", async () => {
  await render(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查找此窗格"]')!.click()); expect(actions.onSearch).toHaveBeenCalledOnce();
  await menu(); expect(document.querySelector('[role="menu"]')?.parentElement).toBe(document.body);
  expect(item("粘贴剪贴板图片")).toBeTruthy(); expect(item("命令历史")).toBeTruthy(); expect(item("导出终端内容")).toBeTruthy();
  await act(async () => item("复制选中").click()); expect(actions.onCopy).toHaveBeenCalledOnce();
  await menu(); await act(async () => item("断开此会话").click()); expect(actions.onDisconnect).toHaveBeenCalledOnce();
});
it("断开态仍能复制历史，禁止粘贴和重复断开", async () => {
  await render(true); await menu();
  expect(item("复制选中").disabled).toBe(false); expect(item("粘贴").disabled).toBe(true); expect(item("断开此会话").disabled).toBe(true);
  await act(async () => item("粘贴").click()); expect(actions.onPaste).not.toHaveBeenCalled();
});
