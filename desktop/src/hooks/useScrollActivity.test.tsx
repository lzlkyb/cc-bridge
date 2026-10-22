// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useScrollActivity } from "./useScrollActivity";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
function Harness() {
  const onScrollCapture = useScrollActivity();
  return <main onScrollCapture={onScrollCapture}>
    <div className="page-scroll"><div className="terminal-scroll" /></div>
    <div className="page-scroll" />
  </main>;
}
const scroll = (element: Element) => element.dispatchEvent(new Event("scroll"));
beforeEach(async () => {
  vi.useFakeTimers(); host = document.createElement("div"); document.body.append(host);
  root = createRoot(host); await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it("滚动立即增强，连续滚动延后淡出，保持同一内容节点", () => {
  const page = host.querySelector(".page-scroll")!;
  scroll(page); expect(page.hasAttribute("data-scrolling")).toBe(true);
  vi.advanceTimersByTime(600); scroll(page); vi.advanceTimersByTime(600);
  expect(page.hasAttribute("data-scrolling")).toBe(true);
  vi.advanceTimersByTime(100); expect(page.hasAttribute("data-scrolling")).toBe(false);
  expect(host.querySelector(".page-scroll")).toBe(page);
});
it("嵌套终端或普通内容的滚动不会触发主页面滑块", () => {
  scroll(host.querySelector(".terminal-scroll")!);
  expect(host.querySelector("[data-scrolling]")).toBeNull();
  expect(host.querySelector("[data-scroll-started]")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it("离开顶部后保留滚动边缘，缓停后仍保留，回到顶部才移除", () => {
  const page = host.querySelector<HTMLElement>(".page-scroll")!;
  page.scrollTop = 9; scroll(page);
  expect(page.hasAttribute("data-scroll-started")).toBe(true);
  vi.advanceTimersByTime(700);
  expect(page.hasAttribute("data-scrolling")).toBe(false);
  expect(page.hasAttribute("data-scroll-started")).toBe(true);
  page.scrollTop = 8; scroll(page);
  expect(page.hasAttribute("data-scroll-started")).toBe(false);
});
it("分类各自保留顶部状态，切换可见性不会清除原分类的位置", () => {
  const [first, second] = host.querySelectorAll<HTMLElement>(".page-scroll");
  first.scrollTop = 120; scroll(first); first.hidden = true;
  scroll(second);
  expect(first.hasAttribute("data-scroll-started")).toBe(true);
  expect(second.hasAttribute("data-scroll-started")).toBe(false);
  first.hidden = false;
  expect(first.scrollTop).toBe(120);
  expect(first.hasAttribute("data-scroll-started")).toBe(true);
});
it("多个滚动容器独立恢复静止状态", () => {
  const [first, second] = host.querySelectorAll(".page-scroll");
  scroll(first); vi.advanceTimersByTime(300); scroll(second); vi.advanceTimersByTime(400);
  expect(first.hasAttribute("data-scrolling")).toBe(false);
  expect(second.hasAttribute("data-scrolling")).toBe(true);
  vi.advanceTimersByTime(300); expect(second.hasAttribute("data-scrolling")).toBe(false);
});
it("卸载时移除增强状态并取消待执行定时器", async () => {
  const page = host.querySelector(".page-scroll")!;
  scroll(page); await act(async () => root.render(null));
  expect(page.hasAttribute("data-scrolling")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
