// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CurrentConnectionProvider } from "../../hooks/useCurrentConnection";
import { currentConnection } from "../../lib/connectionAccess";
import type { StaticStatus } from "../../lib/types";
import type { StableConnection } from "../../lib/stableConnect";
import { CurrentConnectionAlert } from "./CurrentConnectionAlert";
import { CurrentConnectionStatus } from "./CurrentConnectionStatus";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const navigate = vi.fn();
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); navigate.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function render(phase: StableConnection["phase"], authIssue = false) {
  const status = { running: true, transport: "http", port: 7823, token: "fixture", host: "127.0.0.1", scope: "project", projectPath: "/srv/project",
    multiDeviceMode: authIssue, authFailureSources: authIssue ? 1 : 0 } as StaticStatus;
  const access = currentConnection(status, { method: "stable", selectedConnectionId: "server", connections: [{
    connectionId: "server", phase, configured: true, enabled: true, configMatches: true, port: 7823, scope: "project", projectPath: "/srv/project", needsSecret: false,
  } as StableConnection] });
  await act(async () => root.render(<CurrentConnectionProvider access={access}>
    <CurrentConnectionStatus status={status} onNavigate={navigate}/>
    <CurrentConnectionAlert status={status} onNavigate={navigate}/>
  </CurrentConnectionProvider>));
}

it.each(["error", "reconnecting"] as const)("%s 时顶栏保留连接状态，工作区不再显示重复横幅", async phase => {
  await render(phase);
  const statusButton = host.querySelector<HTMLButtonElement>('button[aria-label^="当前接入"]')!;
  expect(statusButton.textContent).toContain(phase === "error" ? "连接异常" : "正在重连");
  expect(host.textContent).not.toContain(phase === "error" ? "隧道连接需要处理" : "正在重连，固定地址不变");
  expect(host.querySelectorAll("button")).toHaveLength(1);
  await act(async () => statusButton.click());
  expect(navigate).toHaveBeenCalledWith("connect", "connect-guide");
});

it("独立的失效令牌访问提醒仍可定位接入，不与隧道异常混淆", async () => {
  await render("error", true);
  expect(host.textContent).toContain("本机收到使用失效令牌的访问");
  expect(host.textContent).not.toContain("隧道连接需要处理");
  const action = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "查看接入")!;
  await act(async () => action.click());
  expect(navigate).toHaveBeenCalledWith("connect", "connect-guide");
});
