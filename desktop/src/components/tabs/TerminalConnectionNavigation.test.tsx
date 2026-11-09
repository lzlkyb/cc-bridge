// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { TerminalConnectionRow } from "./TerminalConnectionRow";
import { emptySshConnection } from "../../lib/sshConnectionForm";
import type { SshSessionRef } from "./TerminalConnectionItem";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const conn = { ...emptySshConnection(), id: "c", name: "公司", host: "10.0.19.194", username: "developer" };
const session = (id: string, extra = {}): SshSessionRef => ({ tabId: id, sessionId: id, conn, closedReason: null, ...extra });
const callbacks = { onConnect: vi.fn(), onDisconnect: vi.fn(), onNewTerminal: vi.fn(), onActivate: vi.fn(), onOpenFiles: vi.fn(), onEdit: vi.fn(), onDeleteRequest: vi.fn(), onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(props = {}) { await act(async () => root.render(<TerminalConnectionRow conn={conn} liveCount={0} isActive={false} connecting={false} confirmingDelete={false} session={undefined} {...callbacks} {...props}/>)); }

it("在线状态独立于选中状态；点击在线项切换会话，未连接项才建立连接", async () => {
  await render({ session: session("s1"), liveCount: 1 });
  expect(host.textContent).toContain("已连接"); expect(host.querySelector(".terminal-connection-user")?.textContent).toBe("developer"); expect(host.querySelector(".terminal-connection-expand")?.textContent).toContain("1 个会话");
  await act(async () => host.querySelector<HTMLButtonElement>(".terminal-connection-pick")!.click());
  expect(callbacks.onActivate).toHaveBeenCalledWith("s1"); expect(callbacks.onConnect).not.toHaveBeenCalled();
  await render(); await act(async () => host.querySelector<HTMLButtonElement>(".terminal-connection-pick")!.click());
  expect(callbacks.onConnect).toHaveBeenCalledWith(conn);
});
it("展开后可切换保留的断开标签，不把分屏副格暴露为普通标签", async () => {
  await render({ sessions: [session("s1"), session("s2", { closedReason: "已手动断开", label: "日志" }), session("split", { splitOnly: true })] });
  await act(async () => host.querySelector<HTMLButtonElement>(".terminal-connection-expand")!.click());
  const tabs = host.querySelectorAll<HTMLButtonElement>(".terminal-connection-sessions button"); expect(tabs.length).toBe(2);
  await act(async () => tabs[1].click()); expect(callbacks.onActivate).toHaveBeenCalledWith("s2");
});
it("失败显示恢复操作，连接中阻止重复请求，删除说明真实会话影响", async () => {
  await render({ connectionError: "目标主机不可达" });
  expect(host.textContent).toContain("连接失败"); expect(host.textContent).toContain("目标主机不可达");
  await act(async () => host.querySelector<HTMLButtonElement>(".terminal-connection-failure button")!.click());
  expect(callbacks.onConnect).toHaveBeenCalledOnce();
  await render({ connecting: true }); expect(host.querySelector<HTMLButtonElement>(".terminal-connection-pick")!.disabled).toBe(true);
  await render({ confirmingDelete: true, liveCount: 2 }); expect(host.textContent).toContain("将断开 2 个会话并关闭终端");
});
