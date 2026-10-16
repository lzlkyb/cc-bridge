import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COPY_DEDUP_MS,
  SELECTION_CACHE_TTL_MS,
  createSelectionCache,
} from "./terminalSelectionCache";

describe("终端选区缓存 + 复制去重", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("只记非空选区——TUI 每帧重绘都会 fire 空选区，不能把缓存冲掉", () => {
    const c = createSelectionCache();
    c.remember("hello");
    c.remember("");
    c.remember(undefined);
    expect(c.read()).toBe("hello");
  });

  it("🔴 超期即废：不让一份 5000 行的历史常驻（否则「复制选中」会静默复制整个滚动历史）", () => {
    const c = createSelectionCache();
    c.remember("hello");
    vi.advanceTimersByTime(SELECTION_CACHE_TTL_MS + 1);
    expect(c.read()).toBe("");
  });

  it("去重窗口内只放行一次（同一次松手可能触发多个 pointerup）", () => {
    const c = createSelectionCache();
    expect(c.claim()).toBe(true);
    expect(c.claim()).toBe(false);
    vi.advanceTimersByTime(COPY_DEDUP_MS + 1);
    expect(c.claim()).toBe(true);
  });

  it("write：先剥行尾空白再写剪贴板，回调带剪辑后的字数（提示文案要用）", async () => {
    vi.useRealTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const done = vi.fn();
    createSelectionCache().write("abc  ", done);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("abc");
    expect(done).toHaveBeenCalledWith(true, 3);
  });

  it("write 失败也回调（成败都报，不吞）", async () => {
    vi.useRealTimers();
    const writeText = vi.fn().mockRejectedValue(new Error("nope"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const done = vi.fn();
    createSelectionCache().write("abc", done);
    await Promise.resolve();
    expect(done).toHaveBeenCalledWith(false, 3);
  });
});
