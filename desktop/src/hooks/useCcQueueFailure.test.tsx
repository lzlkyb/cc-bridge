// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCcQueueFlush, useCcSendQueue } from "./useCcSendQueue";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("断开时暂停下一轮队列，用户继续后仅发送一次", async () => {
  let queue!: ReturnType<typeof useCcSendQueue>;
  const start = vi.fn().mockResolvedValue(true);
  let running = true, failed = false;
  function Probe() { queue = useCcSendQueue(); useCcQueueFlush(queue, { ready: true, busy: false, running, failed, start }); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => queue.enqueue({ text: "下一轮", images: [] }));
    running = false; failed = true;
    await act(async () => root.render(<Probe />));
    expect(queue.paused).toBe(true); expect(queue.queue).toHaveLength(1); expect(start).not.toHaveBeenCalled();
    await act(async () => queue.resume());
    expect(start).toHaveBeenCalledTimes(1); expect(queue.queue).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});
