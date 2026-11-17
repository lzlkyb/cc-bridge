import { describe, expect, it } from "vitest";
import { currentAccessChain, currentConnection, shouldShowIpChangeBanner, type ConnectionAccess } from "./connectionAccess";
import type { StaticStatus } from "./types";
import type { StableConnectSnapshot, StableConnection } from "./stableConnect";

const access: ConnectionAccess = {
  method: "stable", serverName: "订单服务器", connectionId: "orders", address: "http://127.0.0.1:17823/mcp",
  previousAddress: null, scope: "project", projectPath: "/srv/orders", entryName: "my-bridge", targetId: "orders-target", targetKey: "current-orders",
  configured: true, configMatches: true, configurationVerified: true, verifiedAt: 1000, channelReady: true,
  channelDetail: "已连通", channelPhase: "ready", state: "waiting", tone: "live", title: "隧道已连通，等待 Claude Code",
  detail: "请重新打开服务器上的 Claude Code", short: "接入待验证", action: "检查接入", selectionPending: false,
  canCopyAddress: true, canCopyCommand: true, canUpdateIp: false, tokenUpdatePending: false,
  sourceScope: "project", sourceProjectPath: "/srv/orders", updateCommand: "",
};
const status = { running: true, host: "0.0.0.0", port: 7823, token: "fixture", transport: "http", connectClient: "claude-code",
  scope: "project", projectPath: "/srv/orders", lanIps: ["10.0.0.2"], lastSelectedIp: "10.0.0.2", currentAccess: access } as StaticStatus;
const record = { connectionId: "orders", port: 17823, scope: "project", projectPath: "/srv/orders", configured: true,
  configMatches: true, enabled: true, phase: "ready", needsSecret: false, verifiedAt: 1000,
  target: { id: "orders-target", name: "my-bridge", scope: "project", projectPath: "/srv/orders", url: access.address } } as StableConnection;
const snapshot = (patch?: Partial<StableConnection>): StableConnectSnapshot => ({ method: "stable", selectedConnectionId: "orders", connections: [{ ...record, ...patch }] });

describe("统一当前接入", () => {
  it("同一后台目标直接复用摘要，所有入口使用同一对象", () => {
    expect(currentConnection(status, snapshot())).toBe(access);
  });
  it("选择未配置的隧道立即清除直连地址和命令能力", () => {
    const direct = { ...access, method: "direct" as const, connectionId: null, address: "http://10.0.0.2:7823/mcp" };
    const next = currentConnection({ ...status, currentAccess: direct }, { method: "stable", selectedConnectionId: "new", connections: [] })!;
    expect(next.state).toBe("setup");
    expect(next.address).toBe("");
    expect(next.canCopyAddress || next.canCopyCommand || next.canUpdateIp).toBe(false);
  });
  it("重连事件早于状态轮询时保留固定地址，并且不显示直连故障", () => {
    const next = currentConnection({ ...status, ipChanged: true, remoteReachable: false, firewallEnabled: true, firewallPortOpen: false }, snapshot({ phase: "reconnecting" }))!;
    expect(next.state).toBe("recovery");
    expect(next.address).toBe(access.address);
    expect(next.canUpdateIp).toBe(false);
    const chain = currentAccessChain(status, next);
    expect(chain.segments[1]).toMatchObject({ key: "tunnel", name: "隧道通道", tone: "pending" });
  });
  it("切换服务器后不继承旧服务器的地址与核实证据", () => {
    const next = currentConnection(status, { method: "stable", selectedConnectionId: "other", connections: [] })!;
    expect(next.connectionId).toBe("other");
    expect(next.targetKey).not.toBe(access.targetKey);
    expect(next.configurationVerified).toBe(false);
    expect(next.verifiedAt).toBeNull();
    expect(next.address).toBe("");
  });
  it("配置执行、暂停、登录与配置变化各自保留明确状态", () => {
    for (const [patch, state] of [
      [{ phase: "running" }, "applying"], [{ phase: "stopped" }, "paused"],
      [{ phase: "error", needsSecret: true }, "login"], [{ configMatches: false }, "changed"],
    ] as const) {
      const next = currentConnection(status, snapshot(patch))!;
      expect(next.state).toBe(state);
      expect(next.address).toBe(access.address);
      expect(next.channelReady).toBe(state === "changed");
    }
  });
  it("服务器接入仍指向直连地址时不报已连通，链路中间段同步降级", () => {
    // 本机记录里的地址已经是对的，只有服务器上的条目还停在旧 LAN 地址：
    // 这时不能显示「隧道已连通，等待 Claude Code」，否则用户会以为只差重开客户端。
    const next = currentConnection(status, snapshot({ target: { ...record.target!, url: "http://10.0.0.2:17823/mcp" } }))!;
    expect(next.state).toBe("changed");
    expect(next.title).toBe("隧道已连通，服务器接入待更新");
    expect(next.short).toBe("接入待更新");
    expect(next.channelDetail).toBe("已连通 · 接入未指向");
    expect(next.configurationVerified).toBe(false);
    expect(next.previousAddress).toBe("http://10.0.0.2:17823/mcp");
    expect(currentAccessChain(status, next).segments[1]).toMatchObject({ tone: "ok", detail: "已连通 · 接入未指向" });
  });
  it("服务器接入已指向固定地址时保持等待状态", () => {
    const next = currentConnection(status, snapshot())!;
    expect(next.state).toBe("waiting");
    expect(next.configurationVerified).toBe(true);
  });
  it("历史请求与远端配置核实都不能提升客户端验证节点", () => {
    const chain = currentAccessChain({ ...status, stats: { totalRequests: 999 } } as StaticStatus, access);
    expect(chain.segments[2]).toMatchObject({ tone: "idle", detail: "客户端待验证" });
    expect(chain.headline).toContain("等待 Claude Code");
  });
  it("配置写入之后确有隧道流量，才把接入验证点亮", () => {
    // 隧道是裸 TCP 转发：能从 127.0.0.1 打进来就只可能是 sshd 转回来的，
    // 这是本机唯一拿得到的客户端侧硬证据。
    const chain = currentAccessChain(status, { ...access, clientVerifiedAt: 1234567890000 });
    expect(chain.segments[2].tone).toBe("ok");
    expect(chain.segments[2].detail).toMatch(/^已验证 \d{2}:\d{2}$/);
  });
  it("相同服务器换端口或原条目后，不沿用旧地址和复制身份", () => {
    const target = { id: "new-target", name: "another-bridge", scope: "project", projectPath: "/srv/orders", url: "http://127.0.0.1:18823/mcp" } as NonNullable<StableConnection["target"]>;
    const next = currentConnection(status, snapshot({ port: 18823, target, verifiedAt: 2000 }))!;
    expect(next.address).toBe(target.url);
    expect(next.entryName).toBe(target.name);
    expect(next.targetId).toBe(target.id);
    expect(next.targetKey).not.toBe(access.targetKey);
    expect(next.verifiedAt).toBe(2000);
  });
  it("配置检查失败或执行中不能显示上次核实成功", () => {
    const target = { id: "target", name: "my-bridge", scope: "project", projectPath: "/srv/orders", url: access.address } as NonNullable<StableConnection["target"]>;
    for (const phase of ["running", "error"] as const) {
      const next = currentConnection(status, snapshot({ target, phase }))!;
      expect(next.configurationVerified).toBe(false);
      expect(next.channelReady).toBe(false);
    }
  });
});

/**
 * 2026-11-16 用户反馈：横幅出现「10.203.5.22 → 10.203.5.22」。
 * 旧条件把 ipResolvedByUser 当成变化证据 —— 用户只是点过地址选择器、地址没变也弹。
 */
describe("地址变化横幅的出现条件", () => {
  const base = { stableMode: false };

  it("隧道模式 / 已关闭提示：一律不显示", () => {
    expect(shouldShowIpChangeBanner({ ...base, stableMode: true, ipChanged: true })).toBe(false);
    expect(shouldShowIpChangeBanner({ ...base, dismissed: true, ipChanged: true })).toBe(false);
  });

  it("后端标记 ipChanged 或接入快照 ip-changed：显示", () => {
    expect(shouldShowIpChangeBanner({ ...base, ipChanged: true })).toBe(true);
    expect(shouldShowIpChangeBanner({ ...base, state: "ip-changed" })).toBe(true);
  });

  it("点过地址选择但地址没变：不显示自相矛盾的 X → X 横幅", () => {
    expect(shouldShowIpChangeBanner({ ...base, previousIp: "10.203.5.22", selectedIp: "10.203.5.22" })).toBe(false);
  });

  it("之前地址与当前选中不同：显示", () => {
    expect(shouldShowIpChangeBanner({ ...base, previousIp: "10.203.5.22", selectedIp: "10.0.7.185" })).toBe(true);
  });

  it("没有可比对的历史（首次安装）：不显示", () => {
    expect(shouldShowIpChangeBanner({ ...base, previousIp: null, selectedIp: "10.0.7.185" })).toBe(false);
    expect(shouldShowIpChangeBanner({ ...base, selectedIp: "10.0.7.185" })).toBe(false);
  });
});
