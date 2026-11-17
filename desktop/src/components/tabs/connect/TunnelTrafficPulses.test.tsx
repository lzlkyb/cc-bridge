// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "../../../lib/tauri";
import { TunnelTrafficPulses } from "./TunnelTrafficPulses";

vi.mock("../../../lib/tauri", () => ({ listen: vi.fn() }));

const listeners = new Map<string, (payload: unknown) => void>();
const unsubscribed = vi.fn();
const animate = vi.fn(function (this: SVGPathElement) {
  return { path: this, playState: "running", cancel: vi.fn() };
});
let host: HTMLDivElement;
let root: Root;

async function mount(connectionId = "orders") {
  await act(async () => root.render(<svg><TunnelTrafficPulses connectionId={connectionId}/></svg>));
}

function traffic(toLocal: number, toRemote: number, connectionId = "orders", at = Date.now()) {
  listeners.get("stable_tunnel_traffic")?.({ connectionId, at, toLocal, toRemote });
}

function status(state: string, connectionId = "stable:orders") {
  listeners.get("ssh_tunnel_status")?.({ connectionId, state });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    listeners.set(event, handler as (payload: unknown) => void);
    return () => {
      if (listeners.get(event) === handler) listeners.delete(event);
      unsubscribed(event);
    };
  });
  Object.defineProperty(SVGElement.prototype, "animate", { value: animate, configurable: true });
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  Reflect.deleteProperty(SVGElement.prototype, "animate");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  listeners.clear();
});

describe("隧道传输光迹", () => {
  it("两条轨道各自响应真实方向，繁忙时同方向只留一条光迹", async () => {
    await mount();
    const [request, response] = host.querySelectorAll("path");
    traffic(0, 0);
    traffic(500, 0, "other");
    traffic(500, 0, "orders", Date.now() - 2000);
    expect(animate).not.toHaveBeenCalled();
    traffic(500, 0);
    traffic(700, 0);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.results[0].value.path).toBe(request);
    traffic(0, 1200);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.results[1].value.path).toBe(response);
    animate.mock.results[1].value.playState = "finished";
    traffic(0, 50);
    expect(animate).toHaveBeenCalledTimes(3);
  });

  it("忽略直连状态，在本隧道重连时立即取消并且不回放", async () => {
    await mount();
    traffic(10, 20);
    const pulse = animate.mock.results[0].value;
    status("stopped", "orders");
    expect(pulse.cancel).not.toHaveBeenCalled();
    status("reconnecting");
    expect(pulse.cancel).toHaveBeenCalledOnce();
    traffic(10, 20);
    expect(animate).toHaveBeenCalledTimes(2);
    status("up");
    traffic(10, 0);
    expect(animate).toHaveBeenCalledTimes(3);
    await act(async () => root.render(<svg/>));
    expect(animate.mock.results[2].value.cancel).toHaveBeenCalledOnce();
    expect(unsubscribed).toHaveBeenCalledTimes(2);
  });
});
