// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingSave } from "./useSettingSave";
import { BackupAuditGroup } from "./BackupAuditGroup";
import { SecurityGroup } from "./SecurityGroup";
import { TransportRow } from "./TransportRow";
import { RemoteTlsPanel } from "./RemoteTlsPanel";
import type { StaticStatus, TlsStatus } from "../../../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), refetch: vi.fn(), query: { isError: false, isPending: false } }));
vi.mock("../../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../ui/toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: tls, ...mocks.query, refetch: mocks.refetch }) }));
const tls: TlsStatus = { enabled: false, boundToAll: true, banEnabled: true, banThreshold: 5, banWindowMin: 10,
  fingerprintSha256: "abcdef", fingerprintShort: "abc", notAfterEpoch: 1800000000, sans: ["127.0.0.1"], regenerated: false, regenerateReason: null };
const status = { auditEnabled: true, backupEnabled: true, auditRetentionDays: 30, shellEnabled: true, transport: "http", platform: "windows" } as StaticStatus;
let host: HTMLDivElement, root: Root;
const saved = vi.fn();
const findButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
const click = async (text: string) => act(async () => findButton(text).click());
const change = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  mocks.invoke.mockReset().mockResolvedValue({ restartRequired: false });
  mocks.toast.mockClear(); mocks.refetch.mockReset().mockResolvedValue({ isError: false, data: tls });
  mocks.query.isError = false; mocks.query.isPending = false; saved.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("设置保存契约", () => {
  let api: ReturnType<typeof useSettingSave>;
  function Probe() { api = useSettingSave(saved); return <div />; }
  it("同项重复提交被阻止，独立项可以并行且分别反馈", async () => {
    const first = deferred<unknown>(), second = deferred<unknown>();
    mocks.invoke.mockImplementation((_command, { patch }) => patch.a ? first.promise : second.promise);
    await act(async () => root.render(<Probe />));
    let a!: Promise<boolean>, b!: Promise<boolean>, duplicate!: Promise<boolean>;
    await act(async () => { a = api.save({ a: true }, "a"); duplicate = api.save({ a: false }, "a"); b = api.save({ b: true }, "b"); });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(await duplicate).toBe(false);
    expect(api!.pendingKeys).toEqual(["a", "b"]);
    await act(async () => first.resolve({})); expect(await a).toBe(true);
    expect(api!.isSaved("a")).toBe(true); expect(api!.isPending("b")).toBe(true);
    await act(async () => second.resolve({})); expect(await b).toBe(true);
    expect(api!.savedKeys).toEqual(["a", "b"]);
  });
  it("失败返回 false、保留行内错误，不误报成功；重试可恢复", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => root.render(<Probe />));
    let result: boolean | undefined;
    await act(async () => { result = await api.save({ a: true }, "a"); });
    expect(result).toBe(false); expect(api!.errorFor("a")).toContain("disk full");
    expect(saved).not.toHaveBeenCalled(); expect(api!.isSaved("a")).toBe(false);
    await act(async () => { result = await api.save({ a: true }, "a"); });
    expect(result).toBe(true); expect(api!.errorFor("a")).toBeUndefined();
  });
});

describe("审计保留策略", () => {
  const mount = () => act(async () => root.render(<BackupAuditGroup status={status} onSaved={saved} />));
  it("输入、等待、失焦均不提交或清理，空值可编辑", async () => {
    vi.useFakeTimers(); await mount();
    await change(input("审计保留天数"), ""); expect(input("审计保留天数").value).toBe("");
    expect(findButton("应用保留策略").disabled).toBe(true);
    await change(input("审计保留天数"), "7");
    await act(async () => { input("审计保留天数").dispatchEvent(new FocusEvent("focusout", { bubbles: true })); vi.advanceTimersByTime(1200); });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("缩短期限必须确认，取消不落盘，确认后仅保存一次", async () => {
    await mount(); await change(input("审计保留天数"), "7"); await click("应用保留策略");
    expect(document.body.textContent).toContain("立即删除早于 7 天"); expect(mocks.invoke).not.toHaveBeenCalled();
    await click("取消"); expect(mocks.invoke).not.toHaveBeenCalled();
    await click("应用保留策略"); await click("应用并清理");
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("save_config", { patch: { auditRetentionDays: 7 } });
    expect(host.textContent).toContain("当前生效：7 天");
  });
  it("永久保留显式选择后仍需应用，失败保留当前策略与草稿", async () => {
    await mount(); await click("永久保留"); expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.invoke.mockRejectedValueOnce(new Error("read only")); await click("应用保留策略");
    expect(host.textContent).toContain("当前生效：30 天"); expect(input("审计保留天数").value).toBe("0");
    expect(host.textContent).toContain("read only");
  });
  it("手动立即清理使用生效值，不把尚未应用的草稿冒充策略", async () => {
    await mount(); await change(input("审计保留天数"), "90"); await click("立即清理");
    expect(document.body.textContent).toContain("当前保留天数（30 天）");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("HTTPS 保存与重启", () => {
  const mount = () => act(async () => root.render(<SecurityGroup status={status} onSaved={saved} section="network" />));
  it("保存失败不会重启或提示开启成功", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("save denied")); await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("save_config", { patch: { remoteTlsEnabled: true } });
    expect(host.textContent).toContain("save denied");
    expect(mocks.toast.mock.calls.some(([, kind]) => kind === "success")).toBe(false);
  });
  it("保存成功而重启失败，明确保留已保存状态并报告运行未生效", async () => {
    mocks.invoke.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("port busy")); await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["save_config", "restart_mcp_server"]);
    expect(host.textContent).toContain("配置已保存，但重启服务失败");
    expect(mocks.toast.mock.calls.some(([, kind]) => kind === "success")).toBe(false);
  });
  it("状态读取失败不允许按默认关闭值修改", async () => {
    mocks.query.isError = true; await mount();
    expect(host.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
    expect(host.textContent).toContain("无法读取 HTTPS 状态");
  });
});

describe("协议切换", () => {
  it("等待保存确认后才关闭迁移弹框并提示成功", async () => {
    const request = deferred<boolean>(), onSelect = vi.fn(() => request.promise);
    await act(async () => root.render(<TransportRow status={status} onSelect={onSelect} />));
    await click("SSE"); await click("我已复制，确认切换");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>('button[aria-busy="true"]')?.disabled).toBe(true);
    await act(async () => request.resolve(true));
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("已切换到 SSE"), "success");
  });
  it("失败保留迁移弹框与重试入口", async () => {
    await act(async () => root.render(<TransportRow status={status} onSelect={async () => false} />));
    await click("SSE"); await click("我已复制，确认切换");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("协议未保存，请重试");
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

describe("封禁组合策略", () => {
  const mount = () => act(async () => root.render(<RemoteTlsPanel status={status} tls={{ ...tls, enabled: true }} onSaved={saved} onRefetch={mocks.refetch} />));
  it("两个数字编辑和失焦不保存，一次应用组合配置且只重启一次", async () => {
    await mount();
    await change(document.getElementById("remote-ban-threshold") as HTMLInputElement, "8");
    await change(document.getElementById("remote-ban-window") as HTMLInputElement, "15");
    await act(async () => document.getElementById("remote-ban-window")!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(mocks.invoke).not.toHaveBeenCalled(); await click("应用封禁策略");
    expect(mocks.invoke.mock.calls).toEqual([["save_config", { patch: { remoteBanThreshold: 8, remoteBanWindowMin: 15 } }], ["restart_mcp_server"]]);
  });
  it("非法或空数字不回填，不允许应用", async () => {
    await mount(); await change(document.getElementById("remote-ban-threshold") as HTMLInputElement, "");
    expect((document.getElementById("remote-ban-threshold") as HTMLInputElement).value).toBe("");
    expect(findButton("应用封禁策略").disabled).toBe(true);
    expect(host.textContent).toContain("请按范围输入整数");
  });
});
