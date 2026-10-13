import { describe, it, expect, beforeEach } from "vitest";
import {
  TUI_FULLSCREEN_CMD,
  TUI_GUIDE_FLIP_THRESHOLD,
  loadGuideDismissed,
  saveGuideDismissed,
  wasTuiSent,
  markTuiSent,
} from "./terminalTuiGuide";

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

function installThrowingStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
      clear: () => {},
    },
  });
}

describe("一键 fullscreen 引导持久化", () => {
  beforeEach(() => installMemoryStorage());

  it("命令以 \\r 结尾（回车提交），绝不能是 \\n", () => {
    expect(TUI_FULLSCREEN_CMD).toBe("/tui fullscreen\r");
    expect(TUI_FULLSCREEN_CMD).not.toContain("\n");
  });

  it("翻转阈值 ≥ 2（设计稿屏4）", () => {
    expect(TUI_GUIDE_FLIP_THRESHOLD).toBeGreaterThanOrEqual(2);
  });

  it("dismissed 默认 false；保存后 true", () => {
    expect(loadGuideDismissed()).toBe(false);
    saveGuideDismissed();
    expect(loadGuideDismissed()).toBe(true);
  });

  it("sent：未发送为 false；markTuiSent 后为 true；跨会话互不影响", () => {
    expect(wasTuiSent("s1")).toBe(false);
    markTuiSent("s1");
    expect(wasTuiSent("s1")).toBe(true);
    expect(wasTuiSent("s2")).toBe(false);
  });

  it("sent 记录容量封顶：最旧的被淘汰，不无限增长", () => {
    for (let i = 0; i < 40; i++) markTuiSent(`s${i}`);
    expect(wasTuiSent("s0")).toBe(false);
    expect(wasTuiSent("s39")).toBe(true);
  });

  it("坏 JSON / 非对象 JSON 不抛，当作没发过", () => {
    localStorage.setItem("cc-bridge.tui-guide-sent", "{oops");
    expect(wasTuiSent("s1")).toBe(false);
    localStorage.setItem("cc-bridge.tui-guide-sent", "[1,2]");
    expect(wasTuiSent("s1")).toBe(false);
  });

  it("localStorage 不可用（隐私模式）时不抛、降级为默认值", () => {
    installThrowingStorage();
    expect(() => saveGuideDismissed()).not.toThrow();
    expect(() => markTuiSent("s1")).not.toThrow();
    expect(loadGuideDismissed()).toBe(false);
    expect(wasTuiSent("s1")).toBe(false);
  });
});
