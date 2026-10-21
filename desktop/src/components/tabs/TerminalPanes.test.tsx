// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanes } from "./TerminalPanes";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { SplitInfo } from "./useTerminalSplit";
import type { SshConnection } from "../../lib/types";

const h = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn(), action: vi.fn(), ratio: vi.fn(), zoom: vi.fn(), focus: vi.fn() }));
vi.mock("../../lib/terminalRegistry", () => ({ getTerminal: (id: string) => ({ focus: () => h.focus(id) }) }));
vi.mock("./SshTerminal", () => ({ SshTerminal: ({ sessionId, toolbarHost, toolbarActive, pane, visible }: { sessionId: string; toolbarHost: HTMLDivElement | null; toolbarActive: boolean; pane?: string; visible: boolean }) => {
  useEffect(() => { h.mount(sessionId); return () => { h.unmount(sessionId); }; }, [sessionId]);
  return <div tabIndex={0} data-session={sessionId} data-visible={visible}>{sessionId}{toolbarHost && (pane || toolbarActive) && createPortal(<button onClick={() => h.action(sessionId)}>操作 {sessionId}</button>, toolbarHost)}</div>;
} }));
vi.mock("./TerminalRestore", () => ({ RestoredTabPlaceholder: () => <div>恢复占位</div> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const conn = { id: "host", name: "服务器", username: "dev", host: "192.0.2.10" } as SshConnection;
const sessions: SshSessionRef[] = ["a", "b", "c"].map(id => ({ sessionId: id, tabId: `tab-${id}`, conn, closedReason: null, splitOnly: id === "b" }));
const split: SplitInfo = { secTabId: "tab-b", ratio: 58, dir: "h" };
let root: Root, container: HTMLDivElement, host: HTMLDivElement;
const noop = () => {};
function Harness({ activeId, splitState, data = sessions }: { activeId: string; splitState: SplitInfo | null; data?: SshSessionRef[] }) {
  const [focus, setFocus] = useState<string | null>(null);
  return <TerminalPanes sessions={data} activeId={activeId} split={splitState} toolbarHost={host} focusedTabId={focus} onFocusPane={setFocus} connections={[conn]} connectingId={null} emptyState={<div>空态</div>} dragSelectEnabled copyOnSelectEnabled fullscreen={false} onToggleFullscreen={noop} onClosed={noop} onReconnect={noop} onCloseTab={noop} onCwd={noop} onMeta={noop} onOpenFilePath={noop} onPickSplitConn={noop} onCloseSplit={noop} onToggleDir={noop} onSplitRatio={h.ratio} onZoomPane={h.zoom} onDisconnect={noop}/>;
}
async function render(activeId = "a", splitState: SplitInfo | null = null, data = sessions) { await act(async () => root.render(<Harness activeId={activeId} splitState={splitState} data={data}/>)); }
async function focus(id: string) { await act(async () => container.querySelector<HTMLElement>(`[data-session="${id}"]`)!.focus()); }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div"); host = document.createElement("div"); document.body.append(container, host); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); host.remove(); vi.unstubAllGlobals(); });

describe("terminal workspace lifecycle and shared actions", () => {
  it("分屏、切页签和改变布局不重挂后台终端，也不丢失画布节点", async () => {
    await render(); const original = container.querySelector('[data-session="a"]');
    await render("a", split); await focus("b");
    expect(host.textContent).toBe("");
    const pane = container.querySelector('[aria-label="服务器 #3"]')!;
    await act(async () => pane.querySelector<HTMLButtonElement>('.terminal-pane-tools button')!.click()); expect(h.action).toHaveBeenLastCalledWith("b");
    await render("c", null); expect(host.textContent).toBe("操作 c");
    await render("a", null); expect(host.textContent).toBe("操作 a");
    expect(container.querySelector('[data-session="a"]')).toBe(original);
    expect(h.mount).toHaveBeenCalledTimes(3); expect(h.unmount).not.toHaveBeenCalled();
  });
  it("关闭或移除焦点副格，工具栏回主格；已断开会话保持原节点", async () => {
    await render("a", split); await focus("b"); expect(host.textContent).toBe("");
    await render("a", null); expect(host.textContent).toBe("操作 a");
    await render("a", split); await focus("b");
    await render("a", split, [sessions[0], sessions[2]]); expect(host.textContent).toBe("");
    expect(container.querySelector('[aria-label="服务器 #1"] .terminal-pane-tools')?.textContent).toBe("操作 a");
    const original = container.querySelector('[data-session="a"]');
    await render("a", null, [{ ...sessions[0], closedReason: "连接断开" }, sessions[2]]);
    expect(container.querySelector('[data-session="a"]')).toBe(original);
  });
  it("恢复占位不会保留先前页签的工具栏", async () => {
    await render("a", split); await focus("b");
    await render("c", null, sessions.map(s => s.sessionId === "c" ? { ...s, closedReason: "restored" } : s));
    expect(host.textContent).toBe(""); expect(container.textContent).toContain("恢复占位");
  });
  it("放大任一格仅隐藏另一格，恢复比例时画布、工具栏与会话节点不重建", async () => {
    await render("a", split); const a = container.querySelector('[data-session="a"]'), b = container.querySelector('[data-session="b"]');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="放大窗格 服务器 #3"]')!.click()); expect(h.zoom).toHaveBeenCalledWith("tab-b");
    await render("a", { ...split, zoomedTabId: "tab-b" });
    expect(a?.getAttribute("data-visible")).toBe("false"); expect(b?.getAttribute("data-visible")).toBe("true");
    expect(container.querySelector('[role="separator"]')).toBeNull();
    await render("a", split);
    expect(container.querySelector('[data-session="a"]')).toBe(a); expect(container.querySelector('[data-session="b"]')).toBe(b);
    expect(h.mount).toHaveBeenCalledTimes(3); expect(h.unmount).not.toHaveBeenCalled();
  });
  it("上下布局的分割条支持键盘和双击均分", async () => {
    await render("a", { ...split, dir: "v" }); const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(h.ratio).toHaveBeenLastCalledWith(63);
    await act(async () => separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(h.ratio).toHaveBeenLastCalledWith(50);
  });
  it.each(["a", "b"])("从 %s 的还原按钮返回分屏后，输入明确归该会话", async id => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; });
    await render("a", { ...split, zoomedTabId: `tab-${id}` });
    const ordinal = id === "a" ? "1" : "3";
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="还原分屏 服务器 #${ordinal}"]`)!.click());
    await render("a", split);
    await act(async () => frames.forEach(fn => fn(0)));
    expect(h.focus).toHaveBeenCalledExactlyOnceWith(id);
  });
});
