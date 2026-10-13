import { describe, it, expect, beforeEach } from "vitest";
import {
  loadTuiScrollSpeed,
  saveTuiScrollSpeed,
  resetTuiScrollSpeedForTest,
  DEFAULT_TUI_SCROLL_SPEED,
  TUI_SCROLL_SPEEDS,
} from "./terminalScrollSpeed";

// vitest 跑在 node 环境（项目没装 jsdom），没有 localStorage——
// 用内存桩盖住，与 uploadDir.test.ts 同一套做法。
function installMemoryStorage() {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    },
  });
}

describe("TUI 滚动速度持久化", () => {
  beforeEach(() => {
    installMemoryStorage();
    resetTuiScrollSpeedForTest();
  });

  it("默认 1；非法值（手改/残留）回落默认", () => {
    expect(loadTuiScrollSpeed()).toBe(DEFAULT_TUI_SCROLL_SPEED);
    localStorage.setItem("cc-bridge.tui-scroll-speed", "99");
    expect(loadTuiScrollSpeed()).toBe(DEFAULT_TUI_SCROLL_SPEED);
    localStorage.setItem("cc-bridge.tui-scroll-speed", "abc");
    expect(loadTuiScrollSpeed()).toBe(DEFAULT_TUI_SCROLL_SPEED);
  });

  it("保存后读回一致；合法档位就是 1/3/5", () => {
    expect(TUI_SCROLL_SPEEDS).toEqual([1, 3, 5]);
    saveTuiScrollSpeed(5);
    expect(loadTuiScrollSpeed()).toBe(5);
    saveTuiScrollSpeed(3);
    expect(loadTuiScrollSpeed()).toBe(3);
  });
});
