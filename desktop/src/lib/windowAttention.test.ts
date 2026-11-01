// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requestUserAttention: vi.fn(async (_type: number) => {}),
  broken: false,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (h.broken) throw new Error("not a tauri window");
    return { requestUserAttention: h.requestUserAttention };
  },
}));

import { flashWindow } from "./windowAttention";

describe("flashWindow（后台标签的 BEL / OSC 9 提醒）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.broken = false;
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });
  afterEach(() => vi.restoreAllMocks());

  it("窗口没聚焦时闪任务栏（Informational，不是闪到点的 Critical）", async () => {
    flashWindow();
    await Promise.resolve();
    expect(h.requestUserAttention).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("窗口已聚焦就不闪（页面内的 toast 与标签圆点已经够了）", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    flashWindow();
    await Promise.resolve();
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });

  it("非 Tauri 环境（浏览器 dev / 单测）同步抛错也不炸：静默降级", () => {
    h.broken = true;
    expect(() => flashWindow()).not.toThrow();
    expect(h.requestUserAttention).not.toHaveBeenCalled();
  });

  it("requestUserAttention 返回 rejected 不产生未处理拒绝", async () => {
    h.requestUserAttention.mockRejectedValueOnce(new Error("denied"));
    expect(() => flashWindow()).not.toThrow();
    await Promise.resolve();
  });
});
