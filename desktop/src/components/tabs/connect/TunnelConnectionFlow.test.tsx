// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionAccess } from "../../../lib/connectionAccess";
import type { TunnelStatus } from "../../../lib/types";
import { invoke } from "../../../lib/tauri";
import { TunnelConnectionFlow } from "./TunnelConnectionFlow";

let runtime: TunnelStatus | undefined;
let hidden = false;
vi.mock("../../../lib/sshTunnelStore", () => ({ stableRuntimeId: (id: string) => `stable:${id}`, useTunnelStatus: () => runtime }));
vi.mock("../../../lib/appVisibility", () => ({ useAppHidden: () => hidden }));
vi.mock("../../../lib/tauri", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("../../ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const access = { method: "stable", connectionId: "orders", configured: true, configMatches: true, channelReady: false,
  state: "recovery", short: "自动重连中", title: "恢复隧道", detail: "等待网络恢复", channelDetail: "Connection timed out" } as ConnectionAccess;
let host: HTMLDivElement;
let root: Root;
const navigate = vi.fn();
const render = async (running = true, state = access) => {
  await act(async () => root.render(<TunnelConnectionFlow access={state} service={{ key: "service", name: "本机服务", tone: running ? "ok" : "idle", detail: running ? "运行中" : "已停止" }} motion={!hidden} onNavigate={navigate}/>));
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  hidden = false;
  runtime = { connectionId: "stable:orders", state: "reconnecting", message: "Connection timed out", needsSecret: false, rules: [],
    phase: "waiting", attempt: 3, disconnectedAt: 77_000, retryAt: 108_000, lastFailure: "Connection timed out" };
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("隧道连接进度", () => {
  it("按真实截止时间倒计时，立即重试只唤醒本隧道", async () => {
    await render();
    expect(host.textContent).toContain("已断开 23 秒");
    expect(host.textContent).toContain("连接超时 · 8 秒后自动重试");
    act(() => vi.advanceTimersByTime(3000));
    expect(host.textContent).toContain("5 秒后自动重试");
    const button = [...host.querySelectorAll("button")].find(e => e.textContent?.includes("立即重试"))!;
    await act(async () => button.click());
    expect(invoke).toHaveBeenCalledWith("stable_tunnel_retry", { connectionId: "orders" });
    act(() => vi.advanceTimersByTime(5000));
    expect(host.textContent).toContain("即将开始下一次重试");
    expect(button.disabled).toBe(true);
  });

  it("按后端阶段显示重连动画，身份失败与本机停止时停止动画", async () => {
    runtime = { ...runtime!, state: "connecting", phase: "auth", retryAt: null };
    await render();
    expect(host.textContent).toContain("第 3 次尝试 · 正在验证服务器身份");
    expect(host.querySelector('.tunnel-route-spinner')).not.toBeNull();
    expect(host.querySelector('.tunnel-route-interruption')).not.toBeNull();
    expect(host.textContent).toContain("本机服务正常");
    runtime = { ...runtime, state: "error", needsSecret: true };
    await render(true, { ...access, state: "login" });
    expect(host.textContent).toContain("需要重新登录服务器");
    expect(host.querySelector('.tunnel-route-interruption')).toBeNull();
    expect(host.querySelector('.tunnel-route-spinner')).toBeNull();
    runtime = { ...runtime, state: "connecting", needsSecret: false };
    await render(false);
    expect(host.querySelector('.tunnel-route-interruption')).toBeNull();
  });

  it("页面隐藏时没有刷新定时器，恢复后使用当前时间", async () => {
    hidden = true;
    await render();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.querySelector('.tunnel-route')?.getAttribute('data-motion')).toBe('false');
    act(() => vi.advanceTimersByTime(4000));
    hidden = false;
    await render();
    expect(host.textContent).toContain("4 秒后自动重试");
    const details = [...host.querySelectorAll("button")].find(e => e.textContent?.includes("查看详情"))!;
    act(() => details.click());
    expect(navigate).toHaveBeenCalledWith("connect", "connect-guide");
  });
});
