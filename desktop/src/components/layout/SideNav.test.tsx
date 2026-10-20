// @vitest-environment jsdom
import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SideNav } from "./SideNav";

vi.mock("./UpdateBadge", () => ({ UpdateBadge: () => null }));
vi.mock("./UpdateCollapsedDot", () => ({ UpdateCollapsedDot: () => null }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
function Harness({ tab }: { tab: string }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return <><SideNav activeTab={tab} onNavigate={() => {}} unreadCount={0} collapsed={false} onTerminalSidebarReady={setHost}/>{host && createPortal(<input aria-label="连接搜索" defaultValue="保留搜索"/>, host)}</>;
}
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("切换其他页面只隐藏连接区域，保留 portal 节点及输入状态", async () => {
  await act(async () => root.render(<Harness tab="terminal"/>));
  const input = container.querySelector("input")!; input.value = "生产";
  expect(container.querySelector("aside")?.dataset.mode).toBe("terminal");
  await act(async () => root.render(<Harness tab="connect"/>));
  expect(container.querySelector<HTMLElement>(".app-terminal-connections")?.hidden).toBe(true);
  await act(async () => root.render(<Harness tab="terminal"/>));
  expect(container.querySelector("input")).toBe(input); expect(input.value).toBe("生产");
});
