// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalFilePanelHost } from "./TerminalFilePanelHost";
import { setForwardPanelConnId } from "../../lib/sshTunnelStore";
import type { SshConnection } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";

// 只桩到 SshFileBrowser：断线判定与重连出口正是本组件的全部逻辑，
// 深层浏览器（列目录 / 传输 / 拖放）在这里全是噪声。
const h = vi.hoisted(() => ({
  props: null as null | { disconnected?: boolean; onReconnect?: () => void },
}));
vi.mock("./SshFileBrowser", () => ({
  SshFileBrowser: (p: { disconnected?: boolean; onReconnect?: () => void }) => {
    h.props = p;
    return (
      <div>
        <span data-testid="disc">{String(!!p.disconnected)}</span>
        {p.onReconnect && (
          <button type="button" onClick={() => p.onReconnect!()}>
            重新连接
          </button>
        )}
      </div>
    );
  },
}));

// 转发面板本体要 QueryClient + 后端，这里只验宿主「什么时候显示它」。
vi.mock("./TerminalForwardPanel", () => ({
  TerminalForwardPanel: () => <div data-testid="forward" />,
}));
vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(async () => []), listen: vi.fn(async () => () => {}) }));
vi.mock("./ForwardOnConnectPrompt", () => ({ ForwardOnConnectPrompt: () => null }));

const conn = { id: "one", name: "测试服务器", host: "192.0.2.10", port: 22, username: "demo" } as SshConnection;
const extra = { activeId: null, connections: [conn] };
const live: SshSessionRef = { tabId: "t1", sessionId: "s1", conn, closedReason: null };
const dead: SshSessionRef = { tabId: "t1", sessionId: "s1", conn, closedReason: "连接已断开" };
const splitDead: SshSessionRef = { ...dead, tabId: "t2", sessionId: "s2", splitOnly: true };

let root: Root, host: HTMLDivElement;
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

it("有活会话时不提示断线，会话全断开才提示", async () => {
  const onConnect = vi.fn().mockResolvedValue(null);
  const panel = (sessions: SshSessionRef[]) => (
    <TerminalFilePanelHost conn={conn} onBack={() => {}} sessions={sessions} {...extra} onConnect={onConnect} />
  );
  await act(async () => root.render(panel([live])));
  expect(host.querySelector('[data-testid="disc"]')!.textContent).toBe("false");
  await act(async () => root.render(panel([dead])));
  expect(host.querySelector('[data-testid="disc"]')!.textContent).toBe("true");
  expect(onConnect).not.toHaveBeenCalled();
});

it("重连回到原标签（intoTab + forSplit），而不是另开一个", async () => {
  const onConnect = vi.fn().mockResolvedValue("t2");
  await act(async () =>
    root.render(<TerminalFilePanelHost conn={conn} onBack={() => {}} sessions={[splitDead]} {...extra} onConnect={onConnect} />),
  );
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")][0].click());
  // 分屏格里的会话必须回分屏格：intoTab 定位标签、forSplit 标记副格身份，
  // 少任何一个都会开出一个跑到标签栏上的重复终端。
  expect(onConnect).toHaveBeenCalledExactlyOnceWith(conn, { intoTab: "t2", forSplit: true });
});

it("一个会话都不剩时，重连才走新开一路", async () => {
  const onConnect = vi.fn().mockResolvedValue("t1");
  await act(async () =>
    root.render(<TerminalFilePanelHost conn={conn} onBack={() => {}} sessions={[]} {...extra} onConnect={onConnect} />),
  );
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")][0].click());
  expect(onConnect).toHaveBeenCalledExactlyOnceWith(conn);
});

it("转发面板不依赖终端会话；打开文件面板或切标签会把它收起", async () => {
  const onConnect = vi.fn();
  const panel = (fileConn: SshConnection | null, activeId: string | null) => (
    <TerminalFilePanelHost conn={fileConn} onBack={() => {}} sessions={[]} activeId={activeId} connections={[conn]} onConnect={onConnect} />
  );
  const forwardShown = () => !!host.querySelector('[data-testid="forward"]');
  await act(async () => root.render(panel(null, null)));
  await act(async () => setForwardPanelConnId("one"));
  expect(forwardShown()).toBe(true);
  await act(async () => root.render(panel(null, "s9")));
  expect(forwardShown()).toBe(false);
  await act(async () => setForwardPanelConnId("one"));
  await act(async () => root.render(panel(conn, "s9")));
  expect(forwardShown()).toBe(false);
  // 连接已被删：面板不渲染，而不是拿着一个不存在的连接报错。
  await act(async () => root.render(panel(null, "s9")));
  await act(async () => setForwardPanelConnId("gone"));
  expect(forwardShown()).toBe(false);
});
