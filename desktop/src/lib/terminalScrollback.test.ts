import { describe, it, expect, beforeEach } from "vitest";
import {
  loadScrollback,
  saveScrollback,
  clampScrollback,
  subscribeScrollback,
  resetScrollbackForTest,
  DEFAULT_SCROLLBACK,
  SCROLLBACK_OPTIONS,
} from "./terminalScrollback";

// vitest 跑在 node 环境（项目没装 jsdom），没有 localStorage——
// 用内存桩盖住，与 terminalScrollSpeed.test.ts 同一套做法。
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

describe("回滚缓冲持久化", () => {
  beforeEach(() => {
    installMemoryStorage();
    resetScrollbackForTest();
  });

  it("默认 5000；非法值回落默认而不是炸", () => {
    expect(loadScrollback()).toBe(DEFAULT_SCROLLBACK);
    localStorage.setItem("cc-bridge.terminal-scrollback", "abc");
    resetScrollbackForTest(); // 模块级缓存挡住重复读盘，逐案清掉才真正重读
    expect(loadScrollback()).toBe(DEFAULT_SCROLLBACK);
    localStorage.setItem("cc-bridge.terminal-scrollback", "0");
    resetScrollbackForTest();
    expect(loadScrollback()).toBe(100); // clamp 到硬下限，而不是 0
  });

  it("clamp：NaN 回默认、越界夹到 [100, 100000]、小数取整", () => {
    expect(clampScrollback(NaN)).toBe(DEFAULT_SCROLLBACK);
    expect(clampScrollback(5)).toBe(100);
    expect(clampScrollback(999_999_999)).toBe(100_000);
    expect(clampScrollback(4999.6)).toBe(5000);
  });

  it("保存即广播；订阅退订后不再收到", () => {
    const seen: number[] = [];
    const off = subscribeScrollback((n) => seen.push(n));
    saveScrollback(10000);
    off();
    saveScrollback(50000);
    expect(seen).toEqual([10000]);
    expect(loadScrollback()).toBe(50000);
  });

  it("选项档位单调且覆盖默认", () => {
    expect(SCROLLBACK_OPTIONS).toEqual([1000, 5000, 10000, 50000]);
    expect(SCROLLBACK_OPTIONS).toContain(DEFAULT_SCROLLBACK);
  });
});
