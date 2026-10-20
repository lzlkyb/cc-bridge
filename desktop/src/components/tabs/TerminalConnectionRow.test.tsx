// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalConnectionRow } from "./TerminalConnectionRow";
import type { SshConnection } from "../../lib/types";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const conn = { id: "host", name: "生产服务器", username: "dev", host: "192.0.2.10", port: 22 } as SshConnection;
const props = { conn, session: undefined, liveCount: 0, isActive: false, connecting: false, confirmingDelete: false, onConnect: vi.fn(), onDisconnect: vi.fn(), onNewTerminal: vi.fn(), onActivate: vi.fn(), onOpenFiles: vi.fn(), onEdit: vi.fn(), onDeleteRequest: vi.fn(), onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() };
let root: Root, container: HTMLDivElement;
const render = async (overrides: Partial<ComponentProps<typeof TerminalConnectionRow>> = {}) => act(async () => root.render(<TerminalConnectionRow {...props} {...overrides}/>));
const menuItem = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === text)!;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("连接开始后，已打开的菜单和主入口均不能重复发起连接", async () => {
  await render(); await act(async () => container.querySelector<HTMLButtonElement>(".terminal-connection-more")!.click());
  await render({ connecting: true });
  expect(menuItem("连接").disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>(".terminal-connection-pick")!.disabled).toBe(true);
  await act(async () => { menuItem("连接").click(); container.querySelector<HTMLButtonElement>(".terminal-connection-pick")!.click(); });
  expect(props.onConnect).not.toHaveBeenCalled();
  await render(); await act(async () => menuItem("连接").click());
  expect(props.onConnect).toHaveBeenCalledOnce();
});

it("单击在线服务器切换实际会话，文件入口仍指向同一连接", async () => {
  await render({ session: { conn, sessionId: "live", tabId: "tab", closedReason: null }, liveCount: 1 });
  await act(async () => container.querySelector<HTMLButtonElement>(".terminal-connection-pick")!.click());
  expect(props.onActivate).toHaveBeenCalledWith("live"); expect(props.onConnect).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>(".terminal-connection-more")!.click());
  await act(async () => menuItem("文件管理").click());
  expect(props.onOpenFiles).toHaveBeenCalledWith(conn);
});

it("删除必须经过行内确认，菜单项本身只请求确认", async () => {
  await render(); await act(async () => container.querySelector<HTMLButtonElement>(".terminal-connection-more")!.click());
  await act(async () => menuItem("删除连接").click());
  expect(props.onDeleteRequest).toHaveBeenCalledOnce(); expect(props.onConfirmDelete).not.toHaveBeenCalled();
  await render({ confirmingDelete: true });
  const confirm = [...container.querySelectorAll("button")].find(button => button.textContent === "确认删除")!;
  await act(async () => confirm.click()); expect(props.onConfirmDelete).toHaveBeenCalledOnce();
});
