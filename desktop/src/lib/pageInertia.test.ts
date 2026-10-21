// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachPageInertia } from "./pageInertia";

let host: HTMLDivElement, cleanup: () => void, time: number, id: number;
let frames: Map<number, FrameRequestCallback>, motion: EventTarget & { matches: boolean };
function pane(parent: Element = host) {
  const el = document.createElement("div"); el.style.overflowY = "auto"; el.style.lineHeight = "20px";
  Object.defineProperties(el, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  parent.append(el); return el;
}
function wheel(el: Element, init: WheelEventInit = {}) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100, ...init });
  el.dispatchEvent(event); return event;
}
function frame(now: number) {
  time = now; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now));
}
beforeEach(() => {
  time = 0; id = 0; frames = new Map();
  motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => motion);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.set(++id, fn); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  host = document.createElement("div"); document.body.append(host); cleanup = attachPageInertia(document);
});
afterEach(() => {
  cleanup(); host.remove(); document.documentElement.removeAttribute("data-app-hidden");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it("粗粒度滚轮在短时间内缓停，停稳后没有常驻动画", () => {
  const el = pane(); expect(wheel(el).defaultPrevented).toBe(true);
  frame(80); expect(el.scrollTop).toBeGreaterThan(0); expect(el.scrollTop).toBeLessThan(100);
  frame(160); expect(el.scrollTop).toBe(100); expect(frames.size).toBe(0);
});
it("连续输入累加，反向输入立即取消旧方向的余量", () => {
  const el = pane(); wheel(el); wheel(el); frame(80);
  const position = el.scrollTop; wheel(el, { deltaY: -100 }); frame(160);
  expect(el.scrollTop).toBeLessThan(position); frame(240); expect(el.scrollTop).toBe(75);
});
it("支持 SVG 图标上的滚轮，并按行或页换算距离", () => {
  const el = pane(), icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"); el.append(icon);
  wheel(icon, { deltaMode: 1, deltaY: 3 }); frame(160); expect(el.scrollTop).toBe(60);
  wheel(el, { deltaMode: 2, deltaY: 1 }); frame(320); expect(el.scrollTop).toBe(160);
});
it("精细像素流及其后续大增量保留原生惯性", () => {
  const el = pane(); expect(wheel(el, { deltaY: 5.5 }).defaultPrevented).toBe(false);
  for (const now of [100, 400, 700, 1000]) {
    time = now; expect(wheel(el).defaultPrevented).toBe(false);
  }
  expect(frames.size).toBe(0);
  time = 1400; expect(wheel(el).defaultPrevented).toBe(true);
});
it.each(["ctrlKey", "metaKey", "shiftKey", "altKey"])("保留带 %s 的缩放或修饰操作", key => {
  expect(wheel(pane(), { [key]: true }).defaultPrevented).toBe(false);
});
it("横向、不可取消和已处理的事件不接管", () => {
  const el = pane(); expect(wheel(el, { deltaX: 100 }).defaultPrevented).toBe(false);
  expect(wheel(el, { cancelable: false }).defaultPrevented).toBe(false);
  el.addEventListener("wheel", e => e.preventDefault()); wheel(el); expect(frames.size).toBe(0);
});
it.each(["terminal-workspace", "xterm"])("不改变 %s 内部的远端滚轮归属", name => {
  const el = pane(); el.className = name;
  expect(wheel(el).defaultPrevented).toBe(false); expect(frames.size).toBe(0);
});
it("输入控件与菜单继续精准滚动", () => {
  const el = pane(), input = document.createElement("textarea"), menu = pane(el);
  el.append(input); menu.setAttribute("role", "menu");
  expect(wheel(input).defaultPrevented).toBe(false); expect(wheel(menu).defaultPrevented).toBe(false);
});
it("嵌套区域优先滚动，边界尊重 contain，普通边界允许交给父区域", () => {
  const outer = pane(), inner = pane(outer);
  wheel(inner); frame(160); expect(inner.scrollTop).toBe(100); expect(outer.scrollTop).toBe(0);
  inner.scrollTop = 900; inner.style.overscrollBehaviorY = "contain";
  expect(wheel(inner).defaultPrevented).toBe(false);
  inner.style.overscrollBehaviorY = "auto"; wheel(inner); frame(320); expect(outer.scrollTop).toBe(100);
});
it.each(["pointerdown", "touchstart", "keydown", "visibilitychange"])("%s 立即停止滑行，拖动和按键保持跟手", type => {
  const el = pane(); wheel(el); frame(40); const position = el.scrollTop;
  document.dispatchEvent(new Event(type)); frame(200);
  expect(el.scrollTop).toBe(position); expect(frames.size).toBe(0);
});
it("减少动态效果即时终止惯性并保留原生滚轮", () => {
  const el = pane(); wheel(el); motion.matches = true; motion.dispatchEvent(new Event("change"));
  expect(frames.size).toBe(0); expect(wheel(el).defaultPrevented).toBe(false);
});
it("页面隐藏、内容卸载或程序定位后不再拉回旧滚动位置", () => {
  const el = pane(); wheel(el); el.scrollTop = 500; frame(80); expect(el.scrollTop).toBe(500);
  wheel(el); document.documentElement.dataset.appHidden = ""; frame(160); expect(frames.size).toBe(0);
  document.documentElement.removeAttribute("data-app-hidden"); wheel(el); el.remove(); frame(240); expect(frames.size).toBe(0);
});
it("卸载后取消动画并移除全局监听", () => {
  const el = pane(); wheel(el); cleanup(); expect(frames.size).toBe(0);
  expect(wheel(el).defaultPrevented).toBe(false);
});
