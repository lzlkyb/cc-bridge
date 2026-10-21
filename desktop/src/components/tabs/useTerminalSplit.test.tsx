// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSshSessions } from "./useSshSessions";
import { useTerminalSplit } from "./useTerminalSplit";
import type { SshConnection } from "../../lib/types";

const h = vi.hoisted(() => ({ invoke: vi.fn(), sequence: 0 }));
vi.mock("../../lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const conn = { id: "host", name: "server", username: "dev", host: "192.0.2.10", port: 22 } as SshConnection;
let ssh: ReturnType<typeof useSshSessions>, split: ReturnType<typeof useTerminalSplit>, root: Root, container: HTMLDivElement;
let area: HTMLDivElement;
function Harness() {
  ssh = useSshSessions();
  const ref = useRef(area);
  split = useTerminalSplit({ ssh, activeSession: ssh.sessions.find(s => s.sessionId === ssh.activeId) ?? null, areaRef: ref });
  return null;
}
beforeEach(async () => {
  vi.clearAllMocks(); h.sequence = 0;
  h.invoke.mockImplementation(async (cmd: string) => cmd === "ssh_connect" ? `session-${++h.sequence}` : undefined);
  container = document.createElement("div"); area = document.createElement("div"); document.body.append(container, area);
  Object.defineProperty(area, "clientWidth", { configurable: true, value: 1000 });
  Object.defineProperty(area, "offsetParent", { configurable: true, get: () => area.hidden ? null : document.body });
  area.getClientRects = () => (area.hidden ? [] : [area.getBoundingClientRect()]) as unknown as DOMRectList;
  root = createRoot(container); await act(async () => root.render(<Harness/>));
  await act(async () => { await ssh.connect(conn); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); area.remove(); });

it("收起分屏将副格转为独立标签，不断开或移除会话", async () => {
  const primary = ssh.sessions[0];
  await act(async () => { await split.openSplit(conn, "h"); }); const secondary = ssh.sessions[1];
  expect(split.split).toMatchObject({ ratio: 50, dir: "h", secTabId: secondary.tabId });
  await act(async () => split.closeSplit(primary.tabId));
  expect(split.split).toBeNull(); expect(ssh.sessions).toHaveLength(2);
  expect(ssh.sessions[1]).toMatchObject({ tabId: secondary.tabId, sessionId: secondary.sessionId, closedReason: null });
  expect(ssh.sessions[1].splitOnly).toBeUndefined(); expect(ssh.activeId).toBe(primary.sessionId);
  expect(h.invoke.mock.calls.filter(([cmd]) => cmd === "ssh_disconnect")).toHaveLength(0);
});
it("放大还原与切换方向保留原比例，窄窗口默认上下分屏", async () => {
  Object.defineProperty(area, "clientWidth", { value: 650 });
  await act(async () => split.toggleSplit());
  expect(split.split?.dir).toBe("v"); const secondary = ssh.sessions[1];
  await act(async () => split.setRatio(65));
  await act(async () => split.toggleZoom(secondary.tabId)); expect(split.split?.zoomedTabId).toBe(secondary.tabId);
  await act(async () => split.setDirection("h"));
  await act(async () => split.toggleZoom(secondary.tabId));
  expect(split.split).toMatchObject({ dir: "h", ratio: 65, zoomedTabId: null });
  await act(async () => split.closeSplit(ssh.sessions[0].tabId));
  await act(async () => split.toggleSplit()); expect(split.split?.dir).toBe("h");
});
it("连接尚未返回时收起分屏，迟到的副格作为普通标签保留", async () => {
  let resolve!: (id: string) => void;
  h.invoke.mockImplementation((cmd: string) => cmd === "ssh_connect" ? new Promise<string>(r => { resolve = r; }) : Promise.resolve());
  let opening!: Promise<void>;
  await act(async () => { opening = split.openSplit(conn, "h"); });
  await act(async () => split.closeSplit(ssh.sessions[0].tabId));
  await act(async () => { resolve("late-session"); await opening; });
  expect(split.split).toBeNull(); expect(ssh.sessions[1].sessionId).toBe("late-session"); expect(ssh.sessions[1].splitOnly).toBeUndefined();
});
it("关闭宿主标签时保留副格，连接中重复操作不会额外连接", async () => {
  await act(async () => { await split.openSplit(conn, "h"); }); const secondary = ssh.sessions[1];
  await act(async () => { await split.openSplit(conn, "h"); }); expect(ssh.sessions).toHaveLength(2);
  await act(async () => ssh.closeTab(ssh.sessions[0].sessionId));
  expect(ssh.sessions).toHaveLength(1); expect(ssh.sessions[0].splitOnly).toBeUndefined(); expect(ssh.activeId).toBe(secondary.sessionId);
});
it("终端页隐藏时快捷键不切分屏，显示时收起会话也保持连接", async () => {
  const key = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true, bubbles: true }));
  area.hidden = true; await act(async () => { key(); }); expect(split.split).toBeNull();
  area.hidden = false; await act(async () => { key(); }); expect(split.split).not.toBeNull();
  await act(async () => { key(); }); expect(split.split).toBeNull(); expect(ssh.sessions).toHaveLength(2);
});
it("工作区全屏时 offsetParent 为空也能使用分屏快捷键", async () => {
  Object.defineProperty(area, "offsetParent", { value: null });
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true })); });
  expect(split.split).not.toBeNull();
});
