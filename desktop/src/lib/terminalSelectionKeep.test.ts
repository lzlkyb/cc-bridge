import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { attachSelectionKeepGuard } from "./terminalSelectionKeep";

/**
 * 假环境：守卫只做三件读操作（`e.buttons` / `term.modes.mouseTrackingMode` /
 * `term.hasSelection()`）和一次 `stopPropagation()`，不需要真 DOM。
 * 「capture 阶段 stopPropagation 能让子元素收不到事件」是浏览器语义，不是本模块的
 * 逻辑，这里只锁判据 + 注册阶段（第 6 条）。
 */
function fakeTerm(mode: string, hasSelection: boolean): Terminal {
  return {
    modes: { mouseTrackingMode: mode },
    hasSelection: () => hasSelection,
  } as unknown as Terminal;
}

function fakeContainer() {
  const listeners: { type: string; fn: (e: unknown) => void; capture?: unknown }[] = [];
  const container = {
    addEventListener: (type: string, fn: (e: unknown) => void, capture?: unknown) => {
      listeners.push({ type, fn, capture });
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      const i = listeners.findIndex((x) => x.type === type && x.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const fire = (buttons: number) => {
    const ev = { buttons, stopPropagation: vi.fn() };
    for (const l of [...listeners]) if (l.type === "mousemove") l.fn(ev);
    return ev;
  };
  return { container: container as unknown as HTMLElement, fire, listeners };
}

describe("attachSelectionKeepGuard（选区保活）", () => {
  it("ANY 追踪 + 有选区 + 没按键 ⇒ 吞掉 mousemove（否则 xterm 会发 SGR 报告→清选区）", () => {
    const { container, fire } = fakeContainer();
    const term = fakeTerm("any", true);
    attachSelectionKeepGuard(term, container);
    expect(fire(0).stopPropagation).toHaveBeenCalled();
  });

  it("按住键的拖动不吞：选区延伸与远端拖拽报告都走原路", () => {
    const { container, fire } = fakeContainer();
    attachSelectionKeepGuard(fakeTerm("any", true), container);
    expect(fire(1).stopPropagation).not.toHaveBeenCalled();
  });

  it("没有选区不吞：hover 报告照常转发给 TUI", () => {
    const { container, fire } = fakeContainer();
    attachSelectionKeepGuard(fakeTerm("any", false), container);
    expect(fire(0).stopPropagation).not.toHaveBeenCalled();
  });

  it("鼠标追踪没开不吞（普通 shell 不产生报告，避免无谓地掐掉链接悬停）", () => {
    const { container, fire } = fakeContainer();
    attachSelectionKeepGuard(fakeTerm("none", true), container);
    expect(fire(0).stopPropagation).not.toHaveBeenCalled();
  });

  it("以 **capture** 注册：xterm 的 ANY 监听挂在容器子元素上，只有 capture 抢得到先手", () => {
    const { container, listeners } = fakeContainer();
    attachSelectionKeepGuard(fakeTerm("any", true), container);
    expect(listeners).toHaveLength(1);
    expect(listeners[0].capture).toBe(true);
  });

  it("卸载摘干净（终端跨重连保留，残留监听会跟着旧实例走）", () => {
    const { container, listeners } = fakeContainer();
    const detach = attachSelectionKeepGuard(fakeTerm("any", true), container);
    detach();
    expect(listeners).toHaveLength(0);
  });
});
