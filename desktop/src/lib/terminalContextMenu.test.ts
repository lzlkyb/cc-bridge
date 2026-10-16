import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { attachContextMenuGuard } from "./terminalContextMenu";
import { isSelectHold } from "./terminalInputHold";

type Entry = { target: object; type: string; fn: (e: unknown) => void };

/**
 * 假环境：Terminal.options + 能记录 / 触发监听的 container 与它所属文档的 window。
 * 守卫模块刻意从 `container.ownerDocument.defaultView` 取 window（而不是全局 window），
 * 所以这里必须把这条链造出来。
 */
function fakeEnv() {
  const entries: Entry[] = [];
  const bind = (target: object) => ({
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      entries.push({ target, type, fn });
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      const i = entries.findIndex((x) => x.target === target && x.type === type && x.fn === fn);
      if (i >= 0) entries.splice(i, 1);
    },
  });
  const win = {} as Record<string, unknown>;
  Object.assign(win, bind(win));
  const container = {} as Record<string, unknown>;
  Object.assign(container, bind(container), { ownerDocument: { defaultView: win } });
  const options = { disableStdin: false, rightClickSelectsWord: true };
  const term = { options } as unknown as Terminal;
  const fire = (target: object, type: string, ev: unknown) => {
    for (const e of [...entries]) if (e.target === target && e.type === type) e.fn(ev);
  };
  return { term, options, container, win, fire, listeners: () => entries.length };
}

describe("attachContextMenuGuard（右键保选区）", () => {
  it("安装时关掉 rightClickSelectsWord（mac 上默认 true 会选中光标下的词、覆盖用户选区）", () => {
    const { term, options, container } = fakeEnv();
    attachContextMenuGuard(term, container as unknown as HTMLElement);
    expect(options.rightClickSelectsWord).toBe(false);
  });

  it("右键按下闭闸：xterm 的右键报告被拦在 CoreService 门口，本地选区保住", () => {
    const { term, options, container, fire } = fakeEnv();
    attachContextMenuGuard(term, container as unknown as HTMLElement);
    fire(container, "pointerdown", { button: 2 });
    expect(isSelectHold(term)).toBe(true);
    expect(options.disableStdin).toBe(true);
  });

  it("左键 / 中键按下都不碰闸（它们的路径不受影响）", () => {
    const { term, options, container, fire } = fakeEnv();
    attachContextMenuGuard(term, container as unknown as HTMLElement);
    fire(container, "pointerdown", { button: 0 });
    fire(container, "pointerdown", { button: 1 });
    expect(isSelectHold(term)).toBe(false);
    expect(options.disableStdin).toBe(false);
  });

  it("右键抬起**延后一拍**才开闸：紧随的 mouseup 报告仍在闸内（否则选区照样被清）", () => {
    vi.useFakeTimers();
    try {
      const { term, options, container, win, fire } = fakeEnv();
      attachContextMenuGuard(term, container as unknown as HTMLElement);
      fire(container, "pointerdown", { button: 2 });
      fire(win, "pointerup", { button: 2 });
      // 同一拍：闸必须还闭着——mouseup 报告与 pointerup 在同一任务内派发。
      expect(isSelectHold(term)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(isSelectHold(term)).toBe(false);
      expect(options.disableStdin).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pointerup 挂在 window 上（指针已移出容器时也要能收尾开闸）", () => {
    const { container, win, listeners } = fakeEnv();
    attachContextMenuGuard({ options: {} } as unknown as Terminal, container as unknown as HTMLElement);
    expect(listeners()).toBe(2); // container 的 pointerdown + window 的 pointerup
    expect(container.addEventListener).toBeDefined();
    expect(win.addEventListener).toBeDefined();
  });

  it("卸载：摘掉两个监听并把闸松开（否则键盘会一直哑着）", () => {
    vi.useFakeTimers();
    try {
      const { term, container, fire, listeners } = fakeEnv();
      const detach = attachContextMenuGuard(term, container as unknown as HTMLElement);
      fire(container, "pointerdown", { button: 2 });
      expect(isSelectHold(term)).toBe(true);
      detach();
      expect(listeners()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(isSelectHold(term)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
