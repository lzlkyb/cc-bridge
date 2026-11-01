import { describe, expect, it, vi } from "vitest";
import { markReconnected, RECONNECTED_MARK } from "./terminalSessionPhase";

describe("markReconnected", () => {
  it("画分隔线并把视口滚到底（重连不重建 xterm，视口会停在断开前的历史处）", () => {
    const write = vi.fn();
    const scrollToBottom = vi.fn();
    markReconnected({ write, scrollToBottom });
    expect(write).toHaveBeenCalledWith(RECONNECTED_MARK);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("分隔线是独立的整行，且带颜色标记", () => {
    expect(RECONNECTED_MARK.startsWith("\r\n")).toBe(true);
    expect(RECONNECTED_MARK.endsWith("\r\n")).toBe(true);
    expect(RECONNECTED_MARK).toContain("已重新连接");
  });
});
