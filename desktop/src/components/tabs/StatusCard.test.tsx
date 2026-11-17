// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionAccess } from "../../lib/connectionAccess";
import type { StaticStatus } from "../../lib/types";
import { StatusCard } from "./StatusCard";

vi.mock("../../hooks/useCurrentConnection", () => ({
  useCurrentConnection: (status?: StaticStatus) => status?.currentAccess,
}));
vi.mock("../../hooks/useServiceControl", () => ({ useServiceControl: () => ({ busy: false }) }));
vi.mock("../../hooks/useLiveStatus", () => ({ useLiveStatus: () => ({}) }));
vi.mock("../../hooks/useDashboardMotion", () => ({ useDashboardMotion: () => false }));
vi.mock("../ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./RecentActivity", () => ({ RecentActivity: () => null }));

const tunnel = {
  method: "stable", serverName: "订单服务器", scope: "project", projectPath: "/srv/orders",
  state: "waiting", channelReady: true, channelDetail: "已连通", tone: "live", configured: true,
  configMatches: true, address: "http://127.0.0.1:7823/mcp", title: "隧道已连通，等待 Claude Code",
} as ConnectionAccess;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

function render(patch: Partial<ConnectionAccess> = {}, running = true) {
  const status = { running, currentAccess: { ...tunnel, ...patch } } as StaticStatus;
  act(() => root.render(<StatusCard status={status} displayHost="localhost" port={7823} onChanged={() => {}}/>));
  return host;
}

describe("当前接入卡片", () => {
  it("先展示连接结论，再展示两个端点和双向轨道", () => {
    const host = render();
    const route = host.querySelector(".tunnel-route");
    expect(route?.previousElementSibling?.classList.contains("connection-card-detail")).toBe(true);
    expect([...host.querySelectorAll(".tunnel-route-end strong")].map(node => node.textContent))
      .toEqual(["Claude Code", "CC Bridge"]);
    expect(route?.textContent).toContain("SSH 加密转发");
    expect(route?.textContent).toContain("请求发往本机");
    expect(route?.textContent).toContain("响应返回远程服务器");
    expect(host.querySelectorAll('[data-connected="true"]')).toHaveLength(2);
    expect(host.querySelector(".connection-card-headline")?.textContent).toContain("等待 Claude Code");
  });

  it("重连时断开双向线并说明固定地址保留，即使之前验证过客户端", () => {
    const host = render({ state: "recovery", tone: "warn", channelReady: false, short: "正在重连",
      title: "正在重连，固定地址不变", clientVerifiedAt: 1000 });
    expect(host.querySelectorAll('[data-connected="false"]')).toHaveLength(2);
    expect(host.querySelector('.tunnel-route[data-reconnecting="true"] .tunnel-route-interruption')).not.toBeNull();
    expect(host.querySelector(".connection-status-card")?.classList.contains("status-card--live")).toBe(true);
    expect(host.querySelector(".tunnel-route-state")?.textContent).toBe("正在重连");
    expect(host.querySelector(".connection-card-headline")?.textContent).toContain("固定地址不变");
    expect(host.querySelector(".tunnel-route-direction")).toBeNull();
  });

  it("隧道连通但接入待更新时，只点亮 SSH 到本机的一段", () => {
    const host = render({ state: "changed", configMatches: false, short: "接入待更新" });
    expect([...host.querySelectorAll("[data-connected]")].map(node => node.getAttribute("data-connected")))
      .toEqual(["false", "true"]);
    expect(host.querySelector(".tunnel-route-state")?.textContent).toBe("接入待更新");
  });

  it("区分隧道暂停和本机服务未运行", () => {
    const paused = render({ state: "paused", channelReady: false, short: "已暂停" });
    expect(paused.querySelector(".tunnel-route-state")?.textContent).toBe("已暂停");
    expect(paused.querySelectorAll('[data-connected="false"]')).toHaveLength(2);
    const stopped = render({}, false);
    expect(stopped.querySelector(".tunnel-route-end:last-child small")?.textContent).toBe("本机服务已停止");
    expect(stopped.querySelectorAll('[data-connected="false"]')).toHaveLength(2);
  });

  it("IP 直连继续渲染原有服务链路", () => {
    const host = render({ method: "direct" });
    expect(host.querySelector(".tunnel-route")).toBeNull();
    expect(host.querySelector('[aria-label="服务链路状态"]')?.textContent).toContain("地址检查");
  });
});
