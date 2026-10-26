// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCcSession, type CcTarget } from "./useCcSession";

/**
 * 待发队列的失败处理。
 *
 * 事件流（订阅 / 快照 / 序号补漏）有自己的测试与生命周期，这里整体替掉，只留
 * `ready` 与会话 id 两个旋钮：队列的行为只取决于「就绪没」「`cc_start` 成不成」。
 */
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  ready: false,
  seqRef: { current: 0 },
  sessionIdRef: { current: "sid-1" as string | null },
}));
vi.mock("../lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("./useCcEventStream", () => ({
  useCcEventStream: () => ({
    ready: h.ready,
    restored: null,
    clearRestored: () => {},
    seqRef: h.seqRef,
    sessionIdRef: h.sessionIdRef,
  }),
}));
vi.mock("./useCcOpenHistory", () => ({ useCcOpenHistory: () => vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const target: CcTarget = {
  connectionId: null,
  cwd: null,
  claudePath: null,
  model: null,
  permissionMode: "default" as CcTarget["permissionMode"],
};
const restore = { current: { kind: "none" } as const };

let api: ReturnType<typeof useCcSession>, root: Root;
function Probe() {
  api = useCcSession(target, restore);
  return null;
}
const rerender = () => act(async () => root.render(<Probe />));

beforeEach(async () => {
  vi.clearAllMocks();
  h.ready = false;
  root = createRoot(document.createElement("div"));
  await rerender();
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("useCcSession 待发队列", () => {
  /// 失败后若不暂停：running 回 false 会让 effect 立刻发下一条，CLI 没装这类
  /// 「每条都失败」的情形下整队消息会被逐条发错、逐条丢掉，草稿再也找不回来。
  it("队首发送失败：放回队首、其余保留、暂停自动发送", async () => {
    h.invoke.mockRejectedValue(new Error("claude 不存在"));
    await act(async () => {
      await api.start("甲");
      await api.start("乙");
    });
    expect(api.queue.map((q) => q.text)).toEqual(["甲", "乙"]);

    h.ready = true;
    await rerender();
    await rerender();

    const starts = h.invoke.mock.calls.filter((c) => c[0] === "cc_start");
    expect(starts).toHaveLength(1);
    expect(api.queue.map((q) => q.text)).toEqual(["甲", "乙"]);
    expect(api.queuePaused).toBe(true);
    expect(api.view.error).toContain("claude 不存在");
  });

  it("清空队列同时解除暂停", async () => {
    h.invoke.mockRejectedValue(new Error("x"));
    await act(async () => {
      await api.start("甲");
    });
    h.ready = true;
    await rerender();
    await rerender();
    expect(api.queuePaused).toBe(true);

    await act(async () => api.clearQueue());
    expect(api.queue).toEqual([]);
    expect(api.queuePaused).toBe(false);
  });

  it("发送成功时照常出队，不暂停", async () => {
    h.invoke.mockResolvedValue(undefined);
    await act(async () => {
      await api.start("甲");
    });
    h.ready = true;
    await rerender();
    await rerender();

    const starts = h.invoke.mock.calls.filter((c) => c[0] === "cc_start");
    expect(starts).toHaveLength(1);
    expect(api.queue).toEqual([]);
    expect(api.queuePaused).toBe(false);
  });
});
