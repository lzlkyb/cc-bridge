import { expect, it } from "vitest";
import type { ForwardContext } from "./forwardOwnership";
import type { ForwardRule, TunnelStatus } from "./types";
import { forwardAddress, forwardConflict, forwardDisplay, forwardRule, forwardValues, newForwardValues, suggestForwardPort, validateForwardValues } from "./forwardPresentation";

const rule: ForwardRule = { id: "web", kind: "local", enabled: true, listenHost: "127.0.0.1", listenPort: 3000, targetHost: "127.0.0.1", targetPort: 3000, note: "开发网页" };
const values = { ...newForwardValues("local"), targetPort: "3000", accessPort: "3000" };
const status = (changes: Partial<TunnelStatus> = {}): TunnelStatus => ({ connectionId: "server", state: "up", needsSecret: false, message: null,
  rules: [{ rule, state: "listening", boundPort: 3000, message: null }], ...changes });
const owner: ForwardContext = { connectionId: "server", forwardAuto: "ask", manualRules: [], managedRuleIds: [], conflicts: [],
  managed: [{ connectionId: "server", rule: { ...rule, kind: "remote", listenPort: 8888 }, phase: "ready", enabled: true, message: null }] };

it.each(["", "0", "65536", "1e3", "-1", "1.5", "abc"])("无效端口 %s 给出端口校验错误，不伪装成冲突", port => {
  expect(validateForwardValues({ ...values, accessPort: port }, []).accessPort).toContain("范围");
  expect(validateForwardValues({ ...values, targetPort: port }, []).targetPort).toContain("范围");
});
it("自动分配仅对服务器访问本机有效，未知端口不生成 0 地址", () => {
  const automatic = { ...newForwardValues("remote"), targetPort: "7823", automaticPort: true };
  expect(validateForwardValues(automatic, [])).toEqual({});
  expect(forwardRule("auto", automatic).listenPort).toBe(0);
  expect(forwardAddress(forwardRule("auto", automatic))).toBeNull();
  expect(validateForwardValues({ ...automatic, kind: "local" }, []).accessPort).toContain("范围");
});
it("IPv6 和合法自定义地址保留，危险主机字符被拒绝", () => {
  const ipv6 = { ...values, listenHost: "[::1]", targetHost: "[2001:db8::2]" };
  expect(validateForwardValues(ipv6, [])).toEqual({});
  expect(forwardRule("ipv6", ipv6)).toMatchObject({ listenHost: "::1", targetHost: "2001:db8::2" });
  expect(forwardAddress(forwardRule("ipv6", ipv6))).toBe("[::1]:3000");
  expect(validateForwardValues({ ...values, targetHost: "host -o ProxyCommand=bad" }, []).targetHost).toBeTruthy();
});
it("通配 IPv6 监听展示可用的 IPv6 回环地址", () => {
  expect(forwardAddress({ ...rule, listenHost: "::" })).toBe("[::1]:3000");
  expect(forwardAddress({ ...rule, listenHost: "0.0.0.0" })).toBe("127.0.0.1:3000");
});
it("同方向端口按后端约束检查，已停用规则和另一方向不占用", () => {
  expect(forwardConflict(rule, [{ ...rule, id: "other", listenHost: "127.0.0.2" }])).toBeUndefined();
  expect(forwardConflict(rule, [{ ...rule, id: "proxy", kind: "dynamic" }])).toContain("已有");
  expect(forwardConflict(rule, [{ ...rule, id: "off", enabled: false }])).toBeUndefined();
  expect(forwardConflict(rule, [{ ...rule, id: "reverse", kind: "remote" }])).toBeUndefined();
});
it("同端口还要看监听地址：不同回环 IP 可共存，通配地址抢掉一切", () => {
  expect(forwardConflict(rule, [{ ...rule, id: "same" }])).toContain("已有");
  expect(forwardConflict(rule, [{ ...rule, id: "wildcard", listenHost: "0.0.0.0" }])).toContain("重叠");
  expect(forwardConflict(rule, [{ ...rule, id: "star", listenHost: "*" }])).toContain("重叠");
  expect(forwardConflict({ ...rule, listenHost: "0.0.0.0" }, [{ ...rule, id: "loopback", listenHost: "127.0.0.1" }])).toContain("重叠");
  expect(forwardConflict(rule, [{ ...rule, id: "v6", listenHost: "::1" }])).toBeUndefined();
});
it("托管端口来自实际归属，默认示例端口不被硬编码占用", () => {
  expect(forwardConflict({ ...rule, kind: "remote", listenPort: 8888, targetPort: 9000 }, [], owner)).toContain("Claude Code");
  expect(forwardConflict({ ...rule, kind: "remote", listenPort: 7823 }, [], owner)).toBeUndefined();
  expect(suggestForwardPort({ ...values, accessPort: "3000" }, [{ ...rule, id: "other", listenPort: 3001 }])).toBe("3002");
});
it("仅保存修改保留运行快照的旧地址，备注修改不要求重启", () => {
  const pending = forwardDisplay({ ...rule, listenPort: 3001 }, status());
  expect(pending).toMatchObject({ pending: true, address: "127.0.0.1:3000", canCopy: true });
  expect(pending.actual).toEqual(rule);
  expect(forwardDisplay({ ...rule, note: "新名称" }, status()).pending).toBe(false);
});
it("停用尚未应用仍展示实际地址，应用停止后禁止复制", () => {
  expect(forwardDisplay({ ...rule, enabled: false }, status())).toMatchObject({ pending: true, phase: "running", canCopy: true });
  expect(forwardDisplay({ ...rule, enabled: false }, status({ state: "stopped" }))).toMatchObject({ pending: false, phase: "stopped", canCopy: false });
});
it("新保存规则不会借用其他规则的运行状态", () => {
  expect(forwardDisplay({ ...rule, id: "new" }, status())).toMatchObject({ phase: "stopped", canCopy: false, pending: false });
});
it("自动分配展示实际 boundPort，停止后清除分配地址", () => {
  const automatic = { ...rule, kind: "remote" as const, listenPort: 0 };
  const allocated = status({ rules: [{ rule: automatic, state: "listening", boundPort: 32123, message: null }] });
  expect(forwardValues(automatic).automaticPort).toBe(true);
  expect(forwardDisplay(automatic, allocated)).toMatchObject({ address: "127.0.0.1:32123", canCopy: true });
  expect(forwardDisplay(automatic, { ...allocated, state: "reconnecting" })).toMatchObject({ address: "127.0.0.1:32123", canCopy: false });
  expect(forwardDisplay(automatic, { ...allocated, state: "stopped" }).address).toBeNull();
});
it("监听失败不因整体已登录而显示可用；固定地址重连期间保留", () => {
  expect(forwardDisplay(rule, status({ rules: [{ rule, state: "failed", boundPort: null, message: "占用" }] }))).toMatchObject({ phase: "error", canCopy: false });
  expect(forwardDisplay(rule, status({ state: "reconnecting" }))).toMatchObject({ phase: "reconnecting", address: "127.0.0.1:3000", canCopy: false });
});
