import { beforeEach, expect, it, vi } from "vitest";
import { listenTerminalOutput } from "./terminalOutput";

const h = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), off: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: h.invoke, listen: h.listen }));
beforeEach(() => { vi.clearAllMocks(); h.invoke.mockResolvedValue(undefined); h.listen.mockResolvedValue(h.off); });

it("解析完成才确认输出，后台延迟解析时不提前释放额度", async () => {
  let parsed: (() => void) | undefined;
  const write = vi.fn((_data: string, done: () => void) => { parsed = done; });
  const stop = await listenTerminalOutput("s", write);
  const streamId = h.invoke.mock.calls.find(([cmd]) => cmd === "ssh_output_attach")![1].streamId;
  const feed = h.listen.mock.calls[0][1];
  feed({ sessionId: "s", streamId, sequence: 1, data: "日志中文" });
  expect(write).toHaveBeenCalledOnce();
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_output_ack", expect.anything());
  parsed!();
  expect(h.invoke).toHaveBeenCalledWith("ssh_output_ack", { sessionId: "s", streamId, sequence: 1 });
  stop();
});
it("旧订阅和重复输出不能写入新终端或释放其额度", async () => {
  const write = vi.fn((_data, done) => done());
  const stop = await listenTerminalOutput("s", write);
  const streamId = h.invoke.mock.calls.find(([cmd]) => cmd === "ssh_output_attach")![1].streamId;
  const feed = h.listen.mock.calls[0][1];
  feed({ sessionId: "s", streamId: "old", sequence: 1, data: "old" });
  feed({ sessionId: "another", streamId, sequence: 1, data: "other" });
  feed({ sessionId: "s", streamId, sequence: 1, data: "ok" });
  feed({ sessionId: "s", streamId, sequence: 1, data: "duplicate" });
  expect(write).toHaveBeenCalledOnce();
  stop(); feed({ sessionId: "s", streamId, sequence: 2, data: "late" });
  expect(write).toHaveBeenCalledOnce();
  expect(h.off).toHaveBeenCalledOnce();
  expect(h.invoke).toHaveBeenCalledWith("ssh_output_detach", { sessionId: "s", streamId });
});
it("取消后迟到的解析回调不再确认，接线失败释放监听器", async () => {
  let parsed: (() => void) | undefined;
  const stop = await listenTerminalOutput("s", (_data, done) => { parsed = done; });
  const streamId = h.invoke.mock.calls.find(([cmd]) => cmd === "ssh_output_attach")![1].streamId;
  h.listen.mock.calls[0][1]({ sessionId: "s", streamId, sequence: 1, data: "x" });
  stop(); parsed!();
  expect(h.invoke).not.toHaveBeenCalledWith("ssh_output_ack", expect.anything());
  h.invoke.mockRejectedValueOnce(new Error("closed"));
  await expect(listenTerminalOutput("gone", vi.fn())).rejects.toThrow("closed");
  expect(h.off).toHaveBeenCalledTimes(2);
});
it("异步接线尚未返回时卸载，不向已销毁的终端写入", async () => {
  let cancelled = false;
  let attached!: () => void;
  h.invoke.mockReturnValueOnce(new Promise<void>(resolve => { attached = resolve; }));
  const write = vi.fn();
  const wiring = listenTerminalOutput("s", write, () => cancelled);
  await Promise.resolve();
  const streamId = h.invoke.mock.calls[0][1].streamId;
  cancelled = true;
  h.listen.mock.calls[0][1]({ sessionId: "s", streamId, sequence: 1, data: "late" });
  expect(write).not.toHaveBeenCalled();
  attached(); const stop = await wiring; stop();
  expect(h.invoke).toHaveBeenCalledWith("ssh_output_detach", { sessionId: "s", streamId });
});
it("真实 xterm 持续解析超过原溢出阈值的数据，逐批回执而不堆积", async () => {
  const { Terminal } = await import("@xterm/xterm");
  const term = new Terminal({ scrollback: 100 });
  const data = "x".repeat(64 * 1024);
  const batches = 1024; // 64 Mi 字符，超过原先约 50M 字符的异常阈值。
  let streamId = "", sequence = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const feed = () => h.listen.mock.calls[0][1]({ sessionId: "s", streamId, sequence: ++sequence, data });
  h.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "ssh_output_attach") streamId = args.streamId;
    if (cmd === "ssh_output_ack") {
      expect(args.sequence).toBe(sequence);
      if (sequence === batches) finish();
      else queueMicrotask(feed);
    }
  });
  const stop = await listenTerminalOutput("s", (chunk, parsed) => term.write(chunk, parsed));
  try {
    feed(); await done;
    expect(sequence * data.length).toBeGreaterThan(50_000_000);
    expect(term.buffer.active.length).toBeLessThanOrEqual(124);
  } finally { stop(); term.dispose(); }
}, 60_000);
