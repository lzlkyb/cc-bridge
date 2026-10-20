import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GESTURE_COPY_CACHE_MS,
  SELECTION_CACHE_TTL_MS,
  createSelectionCache,
} from "./terminalSelectionCache";

describe("终端选区缓存", () => {
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

  it("🔴 自动复制只吃「本次手势」的缓存：超出 GESTURE_COPY_CACHE_MS 就返回空", () => {
    const c = createSelectionCache();
    c.remember("上一次的选区");
    vi.advanceTimersByTime(GESTURE_COPY_CACHE_MS + 1);
    // 自动复制路径（松手即复制）不能把旧选区当成刚选中的内容写进剪贴板。
    expect(c.read(GESTURE_COPY_CACHE_MS)).toBe("");
  });

  it("手动复制仍按 10 秒算：同一份缓存过了 1.5s，read() 默认还读得到", () => {
    const c = createSelectionCache();
    c.remember("选完过了几秒才点复制");
    vi.advanceTimersByTime(GESTURE_COPY_CACHE_MS + 1);
    expect(c.read()).toBe("选完过了几秒才点复制");
  });

  it("短时限内仍可兜底：TUI 重绘刚把 live selection 冲空时，自动复制还拿得到", () => {
    const c = createSelectionCache();
    c.remember("刚选中的");
    vi.advanceTimersByTime(GESTURE_COPY_CACHE_MS - 1);
    expect(c.read(GESTURE_COPY_CACHE_MS)).toBe("刚选中的");
  });

  it("短时限读空不清缓存：拖选空白后，手动复制（10 秒档）仍拿得到", () => {
    const c = createSelectionCache();
    c.remember("两秒前选的");
    vi.advanceTimersByTime(GESTURE_COPY_CACHE_MS + 500);
    expect(c.read(GESTURE_COPY_CACHE_MS)).toBe(""); // 自动复制：不认
    expect(c.read()).toBe("两秒前选的"); // 手动复制：还认
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
