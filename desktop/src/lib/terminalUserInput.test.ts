import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args: unknown) => undefined));
vi.mock("./tauri", () => ({ invoke }));
import { interceptTerminalUserInput, sendTerminalUserInput } from "./terminalUserInput";

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
});
