// @vitest-environment jsdom
import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SideNav, visibleNav } from "./SideNav";

vi.mock("./UpdateBadge", () => ({ UpdateBadge: () => null }));
vi.mock("./UpdateCollapsedDot", () => ({ UpdateCollapsedDot: () => null }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
function Harness({ tab }: { tab: string }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return <><SideNav activeTab={tab} navItems={visibleNav(true)} onNavigate={() => {}} unreadCount={0} collapsed={false} onTerminalSidebarReady={setHost}/>{host && createPortal(<input aria-label="连接搜索" defaultValue="保留搜索"/>, host)}</>;
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

it("中转项只在开关明确开启时出现，未知按不可见处理", () => {
  // 冷启动头一两百毫秒 relayEnabled 还是 undefined。那时露出「中转」、
  // 读到 false 后再消失，就是一次可见的闪烁（§4.9.3 第 5 条）。
  expect(visibleNav(undefined).some((item) => item.key === "relay")).toBe(false);
  expect(visibleNav(false).some((item) => item.key === "relay")).toBe(false);
  expect(visibleNav(true).some((item) => item.key === "relay")).toBe(true);
});

it("中转固定追加在末尾，既有 Ctrl+1~5 不变", () => {
  const keys = visibleNav(true).map((item) => item.key);
  expect(keys.slice(0, 5)).toEqual(["connect", "terminal", "security", "log", "ccgui"]);
  expect(keys[5]).toBe("relay");
  // 关闭时前 5 项一字不动 —— 顺序变化会把用户肌肉记忆里的 Ctrl+3 换成另一页。
  expect(visibleNav(false).map((item) => item.key)).toEqual(keys.slice(0, 5));
});
