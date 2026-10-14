import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_TERMINAL_MODE,
  TERMINAL_MODES,
  getTerminalMode,
  loadTerminalMode,
  resetTerminalModeForTest,
  resolveTerminalMode,
  saveTerminalMode,
  setTerminalMode,
  subscribeTerminalMode,
  toTerminalMode,
} from "./terminalAppearance";

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

describe("resolveTerminalMode", () => {
  it("auto 跟随应用主题（两个方向都要跟）", () => {
    expect(resolveTerminalMode("auto", "light")).toBe("light");
    expect(resolveTerminalMode("auto", "dark")).toBe("dark");
  });

  it("固定档位无视应用主题", () => {
    expect(resolveTerminalMode("dark", "light")).toBe("dark");
    expect(resolveTerminalMode("dark", "dark")).toBe("dark");
    expect(resolveTerminalMode("light", "dark")).toBe("light");
    expect(resolveTerminalMode("light", "light")).toBe("light");
  });

  it("三态全覆盖（防止将来加档位漏改这里）", () => {
    expect(TERMINAL_MODES.map((m) => m.id)).toEqual(["auto", "dark", "light"]);
  });
});

describe("toTerminalMode（窄化）", () => {
  it("合法值原样通过", () => {
    expect(toTerminalMode("auto")).toBe("auto");
    expect(toTerminalMode("dark")).toBe("dark");
    expect(toTerminalMode("light")).toBe("light");
  });

  it("非法值回落 auto —— 回落到 dark 会把浅色应用的用户直接拖黑", () => {
    expect(toTerminalMode(null)).toBe(DEFAULT_TERMINAL_MODE);
    expect(toTerminalMode("")).toBe(DEFAULT_TERMINAL_MODE);
    expect(toTerminalMode("DARK")).toBe(DEFAULT_TERMINAL_MODE);
    expect(toTerminalMode("sepia")).toBe(DEFAULT_TERMINAL_MODE);
  });
});

describe("持久化与广播", () => {
  beforeEach(() => {
    installMemoryStorage();
    resetTerminalModeForTest();
  });

  it("默认 auto；存的值能读回来", () => {
    expect(loadTerminalMode()).toBe("auto");
    saveTerminalMode("dark");
    expect(loadTerminalMode()).toBe("dark");
    resetTerminalModeForTest();
    expect(getTerminalMode()).toBe("dark");
  });

  it("写坏的值（手改 / 旧版本残留）读回 auto", () => {
    localStorage.setItem("cc-bridge.terminal-mode", "solarized");
    expect(loadTerminalMode()).toBe("auto");
  });

  it("setTerminalMode 通知订阅者；同值重复设置不重复通知", () => {
    let n = 0;
    const off = subscribeTerminalMode(() => (n += 1));
    setTerminalMode("light");
    expect(n).toBe(1);
    expect(getTerminalMode()).toBe("light");
    // 同值：xterm 重新赋值 options 会重绘，能省则省
    setTerminalMode("light");
    expect(n).toBe(1);
    setTerminalMode("dark");
    expect(n).toBe(2);
    off();
    setTerminalMode("auto");
    expect(n).toBe(2);
  });
});
