import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_FONT_ID,
  FONT_STACKS,
  fontStackOf,
  getFontStack,
  loadFontId,
  loadFontStack,
  resetFontFamilyForTest,
  saveFontId,
  setFontId,
  subscribeFontFamily,
  toFontId,
} from "./terminalFontFamily";
import { TERMINAL_FONT } from "./terminalTheme";

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

describe("字体栈表", () => {
  it("默认项就是 2.7.x 的老字体栈（老用户零感知）", () => {
    expect(FONT_STACKS[0].id).toBe(DEFAULT_FONT_ID);
    expect(FONT_STACKS[0].stack).toBe(TERMINAL_FONT);
  });

  it("每套都以 monospace 收尾 —— 终端只能等宽，最后一道兜底不能丢", () => {
    for (const f of FONT_STACKS) {
      expect(f.stack.trim().endsWith("monospace")).toBe(true);
    }
  });

  it("每套都带中文回退 —— 缺了中文会回退到系统默认字体、CJK 列宽错位", () => {
    for (const f of FONT_STACKS) {
      expect(f.stack).toMatch(/Microsoft YaHei|PingFang SC|Noto Sans CJK SC/);
    }
  });

  it("id 不重复，且每一项都有名字与说明（选择器直接渲染它们）", () => {
    const ids = FONT_STACKS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FONT_STACKS) {
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.desc.length).toBeGreaterThan(0);
    }
  });
});

describe("fontStackOf / toFontId", () => {
  it("按 id 取栈", () => {
    const consolas = FONT_STACKS.find((f) => f.id === "consolas");
    expect(consolas).toBeDefined();
    expect(fontStackOf("consolas")).toBe(consolas?.stack);
  });

  it("内置字体在表内，且栈首 family 与打包的 FontFace 同名（对不上就是静默回退）", () => {
    expect(fontStackOf("jetbrains").startsWith('"JetBrains Mono"')).toBe(true);
    expect(fontStackOf("fira").startsWith('"Fira Code"')).toBe(true);
  });

  it("全部预设开箱即用：不再携带安装状态字段（probe/url 随内置化删除）", () => {
    for (const f of FONT_STACKS) {
      expect(f).not.toHaveProperty("probe");
      expect(f).not.toHaveProperty("url");
    }
  });

  it("旧版本遗留的预设 id（cascadia/maple/cjk）窄化回默认项，无残留影响", () => {
    // cascadia：装了 Cascadia 的机器上与系统默认渲染同一字体；没装的机器上它回退
    // Consolas、与 Consolas 预设重复——任何机器上都与另一项重复，故预设已删
    expect(toFontId("cascadia")).toBe(DEFAULT_FONT_ID);
    expect(toFontId("maple")).toBe(DEFAULT_FONT_ID);
    expect(toFontId("cjk")).toBe(DEFAULT_FONT_ID);
  });

  it("非法 id 取默认栈，调用方不必自己兜底", () => {
    expect(fontStackOf("nope" as never)).toBe(TERMINAL_FONT);
  });

  it("窄化：非法值回落默认", () => {
    expect(toFontId("jetbrains")).toBe("jetbrains");
    expect(toFontId(null)).toBe(DEFAULT_FONT_ID);
    expect(toFontId("Comic Sans")).toBe(DEFAULT_FONT_ID);
  });
});

describe("持久化与广播", () => {
  beforeEach(() => {
    installMemoryStorage();
    resetFontFamilyForTest();
  });

  it("默认系统默认；存的值能读回（id 与栈两条路一致）", () => {
    expect(loadFontId()).toBe("default");
    expect(loadFontStack()).toBe(TERMINAL_FONT);
    saveFontId("fira");
    resetFontFamilyForTest();
    expect(loadFontId()).toBe("fira");
    expect(loadFontStack()).toBe(fontStackOf("fira"));
  });

  it("setFontId 通知订阅者；同值不重复通知", () => {
    let n = 0;
    const off = subscribeFontFamily(() => (n += 1));
    setFontId("consolas");
    expect(n).toBe(1);
    expect(getFontStack()).toBe(fontStackOf("consolas"));
    setFontId("consolas");
    expect(n).toBe(1);
    off();
    setFontId("jetbrains");
    expect(n).toBe(1);
  });
});
