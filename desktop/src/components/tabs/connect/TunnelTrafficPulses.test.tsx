// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "../../../lib/tauri";
import { TunnelTrafficPulses } from "./TunnelTrafficPulses";

vi.mock("../../../lib/tauri", () => ({ listen: vi.fn() }));

const listeners = new Map<string, (payload: unknown) => void>();
const unsubscribed = vi.fn();
const animate = vi.fn(function (this: SVGPathElement, _frames: Keyframe[], _options: KeyframeAnimationOptions) {
  return { path: this, playState: "running", cancel: vi.fn(), onfinish: () => {} };
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
  vi.useFakeTimers();
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
  vi.useRealTimers();
});

describe("隧道传输光迹", () => {
  it("传输量每秒合并一次，空闲不留刷新定时器，减少动态效果仍显示数据", async () => {
    const onSample = vi.fn();
    await act(async () => root.render(<svg><TunnelTrafficPulses connectionId="orders" motion={false} onSample={onSample}/></svg>));
    for (let i = 0; i < 5; i++) traffic(100, 200);
    expect(onSample).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample.mock.calls[0][0]).toMatchObject({ toLocal: 500, toRemote: 1000 });
    act(() => vi.advanceTimersByTime(1000));
    expect(onSample.mock.calls[1][0]).toMatchObject({ toLocal: 0, toRemote: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("持续流量延续光迹，停止后不排队回放，卸载释放定时器", async () => {
    await mount();
    traffic(10, 0);
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 900 });
    act(() => vi.advanceTimersByTime(800));
    traffic(20, 0);
    const animation = animate.mock.results[0].value;
    animation.playState = "finished";
    animation.onfinish();
    expect(animate).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1000));
    animate.mock.results[1].value.playState = "finished";
    animate.mock.results[1].value.onfinish();
    expect(animate).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<svg/>));
    expect(vi.getTimerCount()).toBe(0);
  });
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
