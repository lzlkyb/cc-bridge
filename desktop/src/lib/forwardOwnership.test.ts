import { expect, it } from "vitest";
import { managedForwardLabel, manualForwardDraft, manualForwardStatus, sameForwardRoute, type ForwardContext } from "./forwardOwnership";
import type { ForwardRule, TunnelStatus } from "./types";

const legacy: ForwardRule = { id: "old", enabled: true, kind: "remote", listenHost: "127.0.0.1", listenPort: 7823, targetHost: "127.0.0.1", targetPort: 7823, note: "" };
const context: ForwardContext = { connectionId: "server", forwardAuto: "ask", managed: [{ connectionId: "server", rule: { ...legacy, id: "managed" }, enabled: true, phase: "ready", message: null }], manualRules: [], managedRuleIds: [legacy.id], conflicts: [] };

it("旧相同规则只读托管，额外规则继续编辑，原规则数据保持不变", () => {
  const extra = { ...legacy, id: "extra", listenPort: 8080, targetPort: 8080 };
  const original = [legacy, extra];
  const result = manualForwardDraft(original, context);
  expect(result.manualRules).toEqual([extra]);
  expect(result.managedCount).toBe(1);
  expect(original).toEqual([legacy, extra]);
});
it("同端口改成其它目标后立即恢复为手动规则并明确标记冲突", () => {
  const changed = { ...legacy, targetPort: 9000 };
  const result = manualForwardDraft([changed], context);
  expect(result.manualRules).toEqual([changed]);
  expect(result.conflicts[0].ruleId).toBe(legacy.id);
});
it("修改端口或停用冲突规则后可继续应用其它规则", () => {
  for (const rule of [{ ...legacy, targetPort: 9000, listenPort: 9001 }, { ...legacy, targetPort: 9000, enabled: false }]) {
    expect(manualForwardDraft([rule], context).conflicts).toEqual([]);
  }
});
it("通配监听与托管端口冲突，本机方向和远端自动分配端口保持独立", () => {
  expect(manualForwardDraft([{ ...legacy, listenHost: "0.0.0.0" }], context).conflicts).toHaveLength(1);
  expect(manualForwardDraft([{ ...legacy, kind: "local" }, { ...legacy, listenPort: 0 }], context).conflicts).toEqual([]);
});
it("IPv6 不同写法等价，独立的 IPv4 与 IPv6 监听保持分开", () => {
  const a = { ...legacy, listenHost: "[::1]", targetHost: "::1" };
  const b = { ...a, listenHost: "0:0:0:0:0:0:0:1", targetHost: "[::1]" };
  expect(sameForwardRoute(a, b)).toBe(true);
  expect(manualForwardDraft([a], context).conflicts).toEqual([]);
});
it("暂停、重连、配置中分别显示，并且均不释放旧规则的托管归属", () => {
  const managed = context.managed[0];
  expect(managedForwardLabel({ ...managed, phase: "stopped", enabled: false })).toBe("已暂停");
  expect(managedForwardLabel({ ...managed, phase: "reconnecting" })).toBe("重连中");
  expect(managedForwardLabel({ ...managed, phase: "running", enabled: false })).toBe("配置中");
  expect(manualForwardDraft([legacy], { ...context, managed: [{ ...managed, enabled: false }] }).manualRules).toEqual([]);
});
it("手动运行状态只保留额外规则，纯旧转发不能显示成额外转发运行中", () => {
  const old = { rule: legacy, state: "listening" as const, boundPort: null, message: null };
  const status: TunnelStatus = { connectionId: "server", state: "up", message: null, needsSecret: false, rules: [old] };
  expect(manualForwardStatus(status, context)).toBeUndefined();
  const extra = { ...old, rule: { ...legacy, id: "extra", listenPort: 8080 } };
  expect(manualForwardStatus({ ...status, rules: [old, extra] }, context)?.rules).toEqual([extra]);
});
