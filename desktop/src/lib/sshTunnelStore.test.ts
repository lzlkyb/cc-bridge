import { beforeEach, expect, it, vi } from "vitest";
import type { SshConnection, TunnelStatus } from "./types";
import type { ForwardContext } from "./forwardOwnership";

// 事件监听回调就地保存：B4 的回归要靠它直接喂 `ssh_tunnel_status` 事件。
// 注意 lib/tauri 的 listen 会解包 payload，这里存/传的都是状态对象本身。
const eventListeners = vi.hoisted(
  () => new Map<string, (payload: unknown) => void>(),
);

vi.mock("./tauri", () => ({
  invoke: vi.fn(async () => []),
  listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    eventListeners.set(event, handler);
    return () => {
      eventListeners.delete(event);
    };
  }),
}));
vi.mock("../components/ui/toast", () => ({ toast: vi.fn() }));

import { invoke } from "./tauri";
import { dismissForwardOffer, forwardPanelOpen, getForwardOffer, offerForward, setForwardPanelConnId } from "./sshTunnelStore";
import { toast } from "../components/ui/toast";

const tunnelEvent = (connectionId: string, state: TunnelStatus["state"]) =>
  eventListeners.get("ssh_tunnel_status")?.({
    connectionId, state, rules: [], message: null, needsSecret: false,
  } as TunnelStatus);

const rule = { id: "r", enabled: true, kind: "local", listenHost: "127.0.0.1", listenPort: 18080, targetHost: "127.0.0.1", targetPort: 22, note: "" } as const;
const conn = (extra: Partial<SshConnection> = {}) =>
  ({ id: "c", name: "测试机", host: "192.0.2.10", port: 22, username: "dev", authType: "password", forwards: [rule], ...extra }) as SshConnection;
let context: ForwardContext;

beforeEach(() => {
  dismissForwardOffer();
  setForwardPanelConnId(null);
  vi.mocked(invoke).mockReset();
  vi.mocked(toast).mockClear();
  context = { connectionId: "c", forwardAuto: "ask", manualRules: [rule], managedRuleIds: [], conflicts: [], managed: [] };
  vi.mocked(invoke).mockImplementation(async command => command === "ssh_forward_context" ? context : []);
});

it("默认询问：挂起询问并带上连接弹窗里的一次性密码，不直接开启", async () => {
  await offerForward(conn(), { password: "once" });
  expect(getForwardOffer()?.creds).toEqual({ password: "once" });
  expect(invoke).toHaveBeenCalledWith("ssh_forward_context", { connectionId: "c" });
  expect(invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});

it("记住了自动开启：不询问，直接带着一次性密码开启", async () => {
  context.forwardAuto = "connect";
  await offerForward(conn({ forwardAuto: "connect" }), { password: "once" });
  expect(getForwardOffer()).toBeNull();
  expect(invoke).toHaveBeenCalledWith("ssh_tunnel_start", { connectionId: "c", password: "once", passphrase: null });
});

it("记住了不开启、或没有启用的规则：什么都不做", async () => {
  context.forwardAuto = "off";
  await offerForward(conn({ forwardAuto: "off" }));
  context.manualRules = [{ ...rule, enabled: false }];
  await offerForward(conn({ forwards: context.manualRules }));
  expect(getForwardOffer()).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});

it("旧 Claude Code 转发已由隧道托管：连接 SSH 不再询问或启动第二条转发", async () => {
  const legacy = { ...rule, kind: "remote" as const, listenPort: 7823, targetPort: 7823 };
  context = {
    connectionId: "c", forwardAuto: "ask", manualRules: [], managedRuleIds: [legacy.id], conflicts: [],
    managed: [{ connectionId: "c", rule: legacy, phase: "ready", enabled: true, message: null }],
  };
  await offerForward(conn({ forwards: [legacy] }));
  expect(getForwardOffer()).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});

it("暂停与重连期间，即使旧规则选择自动开启也不重新拉起隧道", async () => {
  context.manualRules = [];
  for (const forwardAuto of ["ask", "connect", "launch"] as const) {
    context.forwardAuto = forwardAuto;
    await offerForward(conn({ forwardAuto }));
    expect(getForwardOffer()).toBeNull();
  }
  expect(invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});

it("混合规则仅询问额外手动转发，不计入已托管规则", async () => {
  context.managedRuleIds = ["legacy"];
  await offerForward(conn({ forwards: [{ ...rule, id: "legacy" }, rule] }));
  expect(getForwardOffer()?.rules).toEqual([rule]);
});

it("端口冲突定位到原转发面板，既不弹确认也不启动", async () => {
  context.forwardAuto = "launch";
  context.conflicts = [{ ruleId: "r", message: "7823 已由隧道管理" }];
  await offerForward(conn());
  expect(getForwardOffer()).toBeNull();
  expect(forwardPanelOpen()).toBe(true);
  expect(toast).toHaveBeenCalledWith("7823 已由隧道管理", "error");
  expect(invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});

it("首次状态加载期间已有手动转发运行，不重复询问", async () => {
  context.manualStatus = { connectionId: "c", state: "up", rules: [], message: null, needsSecret: false } as TunnelStatus;
  await offerForward(conn());
  expect(getForwardOffer()).toBeNull();
});

it("关闭询问后迟到的设置读取不会重新显示弹窗或自动启动", async () => {
  let resolve!: (value: ForwardContext) => void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const reading = offerForward(conn(), { password: "once" });
  dismissForwardOffer();
  context.forwardAuto = "connect";
  resolve(context);
  await reading;
  expect(getForwardOffer()).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});

it("连接另一服务器后，旧服务器迟到的结果不能覆盖当前询问", async () => {
  let resolve!: (value: ForwardContext) => void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const old = offerForward(conn());
  const other = { ...context, connectionId: "other" };
  vi.mocked(invoke).mockResolvedValueOnce(other);
  await offerForward(conn({ id: "other" }));
  resolve(context);
  await old;
  expect(getForwardOffer()?.conn.id).toBe("other");
});

it("读取关联失败保持 SSH 连接，不猜测规则或发起转发", async () => {
  vi.mocked(invoke).mockRejectedValueOnce("读取失败");
  await offerForward(conn({ forwardAuto: "connect" }));
  expect(getForwardOffer()).toBeNull();
  expect(toast).toHaveBeenCalledWith(expect.stringContaining("可在端口转发面板重试"), "error");
  expect(invoke).not.toHaveBeenCalledWith("ssh_tunnel_start", expect.anything());
});

// B4：offer 只归它自己那条连接的托管隧道管。跨连接的 stable 事件曾经会反复
// 触发 offerForward——弹窗被不断关掉重建，还每次白烧一次 IPC。
it("另一台服务器的托管隧道事件不会误触当前询问", async () => {
  await offerForward(conn());
  expect(getForwardOffer()).not.toBeNull();
  const before = vi.mocked(invoke).mock.calls.length;
  tunnelEvent("stable:other", "reconnecting");
  await new Promise(done => setTimeout(done, 0));
  expect(getForwardOffer()).not.toBeNull();
  expect(vi.mocked(invoke).mock.calls.length).toBe(before);
});

it("本服务器的托管隧道事件才会重新核对询问", async () => {
  await offerForward(conn());
  expect(getForwardOffer()).not.toBeNull();
  const before = vi.mocked(invoke).mock.calls.length;
  tunnelEvent("stable:c", "reconnecting");
  await new Promise(done => setTimeout(done, 0));
  // 重连中不代表连上：手动规则仍未运行，询问照旧挂起。
  expect(getForwardOffer()).not.toBeNull();
  expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(before);
});
