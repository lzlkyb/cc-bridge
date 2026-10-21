import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getTerminalMode, resetTerminalModeForTest, setTerminalMode, subscribeTerminalMode } from "./terminalAppearance";
import { getFontId, resetFontFamilyForTest, setFontId, subscribeFontFamily } from "./terminalFontFamily";
import { getPreset, setPreset, subscribePreset } from "./terminalPreset";
import { saveFontSize, subscribeFontSize } from "./terminalFontSize";
import { loadScrollback, resetScrollbackForTest, saveScrollback, subscribeScrollback } from "./terminalScrollback";
import { loadTuiScrollSpeed, resetTuiScrollSpeedForTest, saveTuiScrollSpeed } from "./terminalScrollSpeed";

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("storage full"); } });
  resetTerminalModeForTest(); resetFontFamilyForTest(); resetScrollbackForTest(); resetTuiScrollSpeedForTest();
});
afterEach(() => vi.unstubAllGlobals());

it("无法持久化时仍广播字号和回滚，并返回失败给界面", () => {
  const sizeListener = vi.fn(); const bufferListener = vi.fn();
  const offSize = subscribeFontSize(sizeListener); const offBuffer = subscribeScrollback(bufferListener);
  try {
    expect(saveFontSize(19)).toBe(false); expect(sizeListener).toHaveBeenCalledWith(19);
    expect(saveScrollback(10000)).toBe(false); expect(loadScrollback()).toBe(10000);
    expect(bufferListener).toHaveBeenCalledWith(10000);
    expect(saveTuiScrollSpeed(5)).toBe(false); expect(loadTuiScrollSpeed()).toBe(5);
  } finally { offSize(); offBuffer(); }
});

it("明暗、字体与配色仍在当前会话生效，不能报告已保存", () => {
  const changed = vi.fn(); const offMode = subscribeTerminalMode(changed); const offFont = subscribeFontFamily(changed); const offPreset = subscribePreset(changed);
  const nextPreset = getPreset() === "mono" ? "classic" : "mono";
  try {
    expect(setTerminalMode("dark")).toBe(false); expect(getTerminalMode()).toBe("dark");
    expect(setFontId("fira")).toBe(false); expect(getFontId()).toBe("fira");
    expect(setPreset(nextPreset)).toBe(false); expect(getPreset()).toBe(nextPreset);
    expect(changed).toHaveBeenCalledTimes(3);
  } finally { offMode(); offFont(); offPreset(); }
});

it("同一值在存储恢复后可以重试持久化，不重复广播", () => {
  expect(setTerminalMode("dark")).toBe(false);
  const setItem = vi.fn(); vi.stubGlobal("localStorage", { getItem: () => null, setItem });
  const changed = vi.fn(); const off = subscribeTerminalMode(changed);
  try { expect(setTerminalMode("dark")).toBe(true); expect(setItem).toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); }
  finally { off(); }
});
