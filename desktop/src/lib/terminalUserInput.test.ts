import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args: unknown) => undefined));
vi.mock("./tauri", () => ({ invoke }));
import { interceptTerminalUserInput, releaseTerminalInputThrottle, sendTerminalUserInput } from "./terminalUserInput";

afterEach(() => vi.clearAllMocks());

describe("terminal user input routing", () => {
  it("默认原样发送，拦截仅作用于指定会话", async () => {
    const stop = interceptTerminalUserInput("buffered", () => true);
    try {
      await sendTerminalUserInput("buffered", "one\rtwo\r");
      expect(invoke).not.toHaveBeenCalled();
      await sendTerminalUserInput("other", "one\r");
      expect(invoke).toHaveBeenCalledExactlyOnceWith("ssh_input", { sessionId: "other", data: "one\r" });
    } finally { stop(); }
  });
  it("观察但不拦截时仍只发送一次，解除后立即恢复", async () => {
    const observe = vi.fn(() => false);
    const stop = interceptTerminalUserInput("observe", observe);
    await sendTerminalUserInput("observe", "first");
    stop();
    await sendTerminalUserInput("observe", "second");
    expect(observe).toHaveBeenCalledExactlyOnceWith("first");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("旧清理不能解除新会话处理器", async () => {
    const old = interceptTerminalUserInput("replace", () => false);
    const current = interceptTerminalUserInput("replace", () => true);
    old();
    try {
      await sendTerminalUserInput("replace", "held");
      expect(invoke).not.toHaveBeenCalled();
    } finally { current(); }
  });
  it("正常发送失败交给调用方反馈", async () => {
    invoke.mockRejectedValueOnce(new Error("disconnected"));
    await expect(sendTerminalUserInput("failed", "input")).rejects.toThrow("disconnected");
  });

  it("移动报告被节流，随后的按键并进同一条写入——顺序不能靠两次 IPC 的调度碰运气", async () => {
    // 假时钟：不推进时间，待发的移动报告就只会被动合并，不会自己从定时器里冒出来。
    vi.useFakeTimers();
    const motion1 = "\x1b[<35;1;1M";
    const motion2 = "\x1b[<35;2;2M";
    try {
      await sendTerminalUserInput("motion", motion1); // 首条立刻发
      await sendTerminalUserInput("motion", motion2); // 进窗口，待发
      await sendTerminalUserInput("motion", "a"); // 按键：与待发合并
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenNthCalledWith(1, "ssh_input", { sessionId: "motion", data: motion1 });
      expect(invoke).toHaveBeenNthCalledWith(2, "ssh_input", { sessionId: "motion", data: motion2 + "a" });
    } finally {
      releaseTerminalInputThrottle("motion");
      vi.useRealTimers();
    }
  });
});
