// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCcSteering } from "./useCcSteering";
import type { CcTarget } from "./useCcSession";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: h.invoke }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, api: ReturnType<typeof useCcSteering>;
const targetRef = { current: { connectionId: null, cwd: "D:/proj", claudePath: null, model: "opus", permissionMode: "default" } as CcTarget };
const options = { sessionIdRef: { current: 7 }, targetRef, sessionId: "cli-7", ready: true, running: true, busy: false, dispatch: vi.fn(), start: vi.fn() };
function Probe() { api = useCcSteering(options); return null; }
const render = () => act(async () => root.render(<Probe />));
beforeEach(async () => { vi.clearAllMocks(); options.running = true; options.ready = true; options.busy = false; root = createRoot(document.createElement("div")); await render(); });
afterEach(async () => { await act(async () => root.unmount()); });

it("运行中直接补充并携带目标、消息 UUID 与原始图片", async () => {
  h.invoke.mockResolvedValue("written");
  const image = { mediaType: "image/png", data: "original", thumb: "thumbnail", bytes: 8, width: 1, height: 1 };
  await act(async () => expect(await api.steer("补充", [image])).toBe(true));
  expect(h.invoke).toHaveBeenCalledWith("cc_steer", expect.objectContaining({ sessionId: 7, input: expect.objectContaining({ expectedSessionId: "cli-7", mode: "steer", messageId: expect.any(String), req: expect.objectContaining({ cwd: "D:/proj", images: [{ mediaType: "image/png", data: "original", thumb: "thumbnail" }] }) }) }));
  expect(options.start).not.toHaveBeenCalled();
});
it("未确认的 IPC 重试复用 UUID，即使本轮已结束也不新发一轮", async () => {
  h.invoke.mockRejectedValueOnce("连接抖动").mockResolvedValueOnce("complete");
  await act(async () => expect(await api.sendNow("调整", [])).toBe(false));
  const first = h.invoke.mock.calls[0][1].input.messageId;
  options.running = false; await render();
  await act(async () => expect(await api.sendNow("调整", [])).toBe(true));
  expect(h.invoke.mock.calls[1][1].input.messageId).toBe(first);
  expect(options.start).not.toHaveBeenCalled();
});
it("连按不会重复调用，未确认响应保留草稿", async () => {
  let finish!: (state: string) => void;
  h.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let first!: Promise<boolean>;
  await act(async () => { first = api.sendNow("调整", []); expect(await api.sendNow("调整", [])).toBe(false); });
  expect(h.invoke).toHaveBeenCalledTimes(1);
  await act(async () => { finish("unconfirmed"); expect(await first).toBe(false); });
  expect(api.busy).toBe(false);
});
it("空闲时普通发送，初始化或正在停止时保留输入", async () => {
  options.running = false; options.start.mockResolvedValue(true); await render();
  await act(async () => expect(await api.steer("新任务", [])).toBe(true));
  expect(options.start).toHaveBeenCalledWith("新任务", []);
  options.busy = true; await render();
  await act(async () => expect(await api.sendNow("调整", [])).toBe(false));
  expect(h.invoke).not.toHaveBeenCalled();
});
