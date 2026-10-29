// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { UserMessageBubble } from "./UserMessageBubble";
import { SessionSidebar } from "./SessionSidebar";
import { SessionHistoryList } from "./SessionHistoryList";

let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (node: React.ReactNode) => act(() => root.render(node));
const stored = { rowId: 2, connectionId: "", sessionId: "stored", cwd: "D:/project", title: "API 记录", titleLocked: true, preview: "", model: "opus", permissionMode: "default", messageCount: 2, updatedAt: 0, archivedAt: null, dropped: 0 };

it("历史消息编辑的输入法 Esc 和 Ctrl+Enter 不取消或提交", () => {
  const fork = vi.fn(); render(<UserMessageBubble text="原消息" onFork={fork} />);
  act(() => [...host.querySelectorAll("button")].find(button => button.textContent === "编辑并新开会话")!.click());
  const area = host.querySelector("textarea")!;
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }));
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true }));
  });
  expect(host.querySelector("textarea")).toBe(area); expect(fork).not.toHaveBeenCalled();
  act(() => area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector("textarea")).toBeNull();
});

it("仅历史会话匹配时不出现没有匹配的会话", () => {
  render(<SessionSidebar entries={[]} active="" collapsed={false} targets={[]} stored={[stored]} archived={false} archivedCount={0}
    onToggleCollapsed={() => {}} onToggleArchived={() => {}} onPick={() => {}} onNew={() => {}} onClose={() => {}} onOpenStored={() => {}}
    actions={{ rename: async () => {}, archive: async () => {}, archived: {} }} />);
  expect(host.textContent).toContain("API 记录");
  expect(host.textContent).not.toContain("没有匹配的会话");
});

it("历史会话子按钮的回车不打开会话，行本身回车仍打开", () => {
  const open = vi.fn(); render(<SessionHistoryList rows={[stored]} targets={[]} onOpen={open} onRename={async () => {}} onArchive={async () => {}} />);
  const row = host.querySelector('[role="button"]')!;
  act(() => row.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(open).not.toHaveBeenCalled();
  act(() => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(open).toHaveBeenCalledWith(2);
});
