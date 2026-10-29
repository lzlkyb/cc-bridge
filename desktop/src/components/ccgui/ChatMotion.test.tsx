// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerNotices } from "./ComposerNotices";
import { MOTION } from "../../lib/motion";

let root: Root, host: HTMLDivElement;
let changePreference: (event: { matches: boolean }) => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("matchMedia", () => ({ matches: false,
    addEventListener: (_: string, listener: typeof changePreference) => { changePreference = listener; },
    removeEventListener: vi.fn(),
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<ComposerNotices queueCount={1} queuePaused
    queueItems={[{ id: "keep", text: "保留的消息", images: [] }]}
    onClearQueue={() => {}} onRemoveQueue={() => {}} slashReject={null} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function click(text: string) { act(() => [...host.querySelectorAll("button")].find(button => button.textContent === text)!.click()); }
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
const reveal = () => host.querySelector<HTMLElement>(".cc-queue-reveal");

it("离场期间内容不可交互，快速重新展开会取消旧卸载", () => {
  click("管理"); advance(40);
  expect(reveal()?.dataset.entered).toBe("true");
  click("收起");
  expect(reveal()?.inert).toBe(true);
  expect(reveal()?.getAttribute("aria-hidden")).toBe("true");
  advance(40); click("管理"); advance(MOTION.exit + 40);
  expect(reveal()?.textContent).toContain("保留的消息");
  expect(reveal()?.inert).toBe(false);
  click("收起"); advance(MOTION.exit);
  expect(reveal()).toBeNull();
  expect(host.querySelector(".cc-composer-queue-peek")?.textContent).toContain("保留的消息");
});

it("退出中切换减少动态效果立即清理，不残留定时任务", () => {
  click("管理"); advance(40); click("收起");
  act(() => changePreference({ matches: true }));
  expect(reveal()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  click("管理"); expect(reveal()?.dataset.entered).toBe("true");
  click("收起"); expect(reveal()).toBeNull();
});
