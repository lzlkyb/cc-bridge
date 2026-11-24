// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { RelayLogEntry } from "../lib/types";
import { useRelayStatus } from "./useRelayStatus";

const ipc = vi.hoisted(() => vi.fn());
vi.mock("../lib/tauri", () => ({ invoke: ipc }));
vi.mock("../lib/appVisibility", () => ({ useAppHidden: () => false }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const { rows } = useRelayStatus();
  return <span>{rows[0]?.usage?.output ?? "等待"}</span>;
}

it("中转停止后仍会合并早已离开最近 50 条的长请求最终用量", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending: Pick<RelayLogEntry, "id" | "requestId" | "tsMs" | "status" | "usage"> = {
    id: 1, requestId: "long-stream", tsMs: Date.now() - 121_000, status: null, usage: null,
  };
  let historical = pending;
  ipc.mockImplementation(async (cmd: string) => cmd === "relay_status"
    ? { running: false, recent: [], stats: { inFlight: 0 } } : [historical]);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(host.textContent).toBe("等待");
    historical = { ...pending, status: 200, usage: { input: 12, cacheRead: null, cacheWrite: null, output: 28, partial: false } };
    await act(async () => vi.advanceTimersByTimeAsync(60_010));
    expect(host.textContent).toBe("28");
    expect(ipc.mock.calls.filter(([cmd]) => cmd === "relay_history")).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.useRealTimers();
  }
});
