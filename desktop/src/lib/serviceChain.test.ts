import { describe, it, expect } from "vitest";
import { computeChain, showsFirewallSegment, type ChainInput } from "./serviceChain";

const NOW = 1_000_000;

/** 默认：Windows、运行中、防火墙已放行、远程刚调用过。 */
function input(over: Partial<ChainInput> = {}): ChainInput {
  return {
    running: true,
    startupError: null,
    remoteReachable: true,
    platform: "windows",
    firewallPortOpen: true,
    firewallAvailable: true,
    totalRequests: 1284,
    lastIncreaseAt: NOW - 15_000,
    now: NOW,
    port: 7823,
    ...over,
  };
}

const seg = (r: ReturnType<typeof computeChain>, key: string) =>
  r.segments.find((s) => s.key === key)!;

describe("serviceChain", () => {
  it("全通：三段全绿，基调 live", () => {
    const r = computeChain(input());
    expect(r.tone).toBe("live");
    expect(r.segments.map((s) => s.tone)).toEqual(["ok", "ok", "ok"]);
    expect(seg(r, "remote").detail).toBe("15 秒前");
  });

  it("启动失败：断在第一段，错误原文当副标题", () => {
    const r = computeChain(
      input({ running: false, startupError: "端口 7823 已被占用" }),
    );
    expect(r.tone).toBe("error");
    expect(seg(r, "service").tone).toBe("bad");
    expect(seg(r, "remote").tone).toBe("idle");
    expect(r.sub).toBe("端口 7823 已被占用");
  });

  it("已停止：整条链路置灰，不报错", () => {
    const r = computeChain(input({ running: false, startupError: null }));
    expect(r.tone).toBe("stopped");
    expect(r.segments.every((s) => s.tone === "idle")).toBe(true);
  });

  it("防火墙未放行且远程从未调用 → 明确指出卡在防火墙", () => {
    const r = computeChain(
      input({ firewallPortOpen: false, totalRequests: 0, lastIncreaseAt: null }),
    );
    expect(r.tone).toBe("warn");
    expect(seg(r, "firewall").tone).toBe("bad");
    expect(seg(r, "firewall").detail).toBe("7823/TCP 未放行");
    expect(r.headline).toContain("防火墙");
  });

  it("🔴 防火墙探测说未放行、但远程已成功调用过 → 不得报「连不进来」", () => {
    // 事实胜于探测：规则可能建在别的配置文件上，此时报错是误报。
    const r = computeChain(input({ firewallPortOpen: false, totalRequests: 500 }));
    expect(r.tone).toBe("live");
    expect(r.headline).not.toContain("连不进来");
    expect(seg(r, "remote").tone).toBe("ok");
  });

  it("🔴 netsh 不可用 → 防火墙段为 unknown，既不撞绿也不报红", () => {
    const r = computeChain(input({ firewallAvailable: false, firewallPortOpen: null }));
    expect(seg(r, "firewall").tone).toBe("unknown");
    expect(seg(r, "firewall").detail).toBe("无法检测");
    expect(r.tone).toBe("live");
    expect(r.sub).toContain("实际不影响");
  });

  it("macOS 不画防火墙段", () => {
    expect(showsFirewallSegment("macos")).toBe(false);
    const r = computeChain(input({ platform: "macos", firewallPortOpen: null }));
    expect(r.segments.map((s) => s.key)).toEqual(["service", "remote"]);
  });

  it("首次接入（远程从未调用）：第三段为中性空态而非错误", () => {
    const r = computeChain(input({ totalRequests: 0, lastIncreaseAt: null }));
    expect(seg(r, "remote").tone).toBe("idle");
    expect(seg(r, "remote").detail).toBe("尚未发生");
    expect(r.headline).toBe("本机已就绪，等远程接入");
  });

  it("🔴 本会话未观测到增量时，只陈述计数，**不得编时间**", () => {
    // 真实场景：用户刚从托盘恢复窗口，序列因断层被清空，
    // 但服务已跑了很久、远程也调用过很多次。
    const r = computeChain(input({ lastIncreaseAt: null, totalRequests: 1284 }));
    expect(seg(r, "remote").detail).toBe("已调用 1,284 次");
    expect(seg(r, "remote").detail).not.toMatch(/前$/);
  });

  it("remoteReachable 只能影响第一段副标题，不得点亮第三段", () => {
    const on = computeChain(input({ remoteReachable: true, totalRequests: 0, lastIncreaseAt: null }));
    const off = computeChain(input({ remoteReachable: false, totalRequests: 0, lastIncreaseAt: null }));
    expect(seg(on, "service").detail).toBe("运行中 · 地址已绑定");
    expect(seg(off, "service").detail).toBe("运行中");
    // 两者的第三段必须一样——本机探针证明不了远程可达
    expect(seg(on, "remote")).toEqual(seg(off, "remote"));
  });

  it("端口改过时防火墙文案跟着变，不写死 7823", () => {
    const r = computeChain(
      input({ port: 9000, firewallPortOpen: false, totalRequests: 0, lastIncreaseAt: null }),
    );
    expect(seg(r, "firewall").detail).toBe("9000/TCP 未放行");
  });

  it("时间差文案分档", () => {
    const at = (agoMs: number) =>
      seg(computeChain(input({ lastIncreaseAt: NOW - agoMs })), "remote").detail;
    expect(at(3_000)).toBe("刚刚");
    expect(at(42_000)).toBe("42 秒前");
    expect(at(5 * 60_000)).toBe("5 分钟前");
    expect(at(3 * 3600_000)).toBe("3 小时前");
  });
});
