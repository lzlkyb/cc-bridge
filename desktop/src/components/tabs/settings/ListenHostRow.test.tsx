// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListenHostRow } from "./ListenHostRow";
import type { StaticStatus } from "../../../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../ui/toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
const saved = vi.fn();
const mount = (h: string) =>
  act(async () => root.render(<ListenHostRow status={{ host: h, port: 7823 } as StaticStatus} onSaved={saved} />));
// 确认框走 portal 挂在 body 上，按钮一律从 body 找。
const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
const click = (text: string) => act(async () => button(text)!.click());
const calls = (cmd: string) => mocks.invoke.mock.calls.filter((c) => c[0] === cmd);
// ConfirmDialog 先播退场动画（rAF + MOTION.exit）再回调 onCancel / onConfirm，得等它走完。
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 600)); });

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue({ restartRequired: true });
  mocks.toast.mockReset(); saved.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("监听地址", () => {
  it("仅本机时明确告诉用户远程连不上，点「所有网卡」直接保存并重启", async () => {
    await mount("127.0.0.1");
    expect(host.textContent).toContain("远程服务器无法连接");
    expect(button("仅本机")!.getAttribute("aria-pressed")).toBe("true");
    await click("所有网卡");
    expect(calls("save_config")).toEqual([["save_config", { patch: { host: "0.0.0.0" } }]]);
    expect(calls("restart_mcp_server")).toHaveLength(1);
    expect(saved).toHaveBeenCalled();
  });

  it("切到「仅本机」必须确认，取消则什么都不写", async () => {
    await mount("0.0.0.0");
    await click("仅本机");
    expect(mocks.invoke).not.toHaveBeenCalled();
    await click("取消"); await settle();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(button("改为仅本机")).toBeUndefined();
    await click("仅本机");
    await click("改为仅本机"); await settle();
    expect(calls("save_config")).toEqual([["save_config", { patch: { host: "127.0.0.1" } }]]);
  });

  it("旧版的具体网卡 IP 照实显示为不可点的选中项", async () => {
    await mount("10.0.0.9");
    const legacy = button("当前：10.0.0.9")!;
    expect(legacy.disabled).toBe(true);
    expect(legacy.getAttribute("aria-pressed")).toBe("true");
    expect(button("所有网卡")!.disabled).toBe(false);
  });

  it("已保存但重启失败时给出重试入口，重试不重复保存", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === "restart_mcp_server" ? Promise.reject(new Error("busy")) : Promise.resolve({ restartRequired: true }));
    await mount("127.0.0.1");
    await click("所有网卡");
    expect(host.textContent).toContain("监听地址已保存，但服务重启失败");
    // 轮询回来的 status 已是新值：再点同一项不会保存，只能靠重试按钮。
    await mount("0.0.0.0");
    mocks.invoke.mockResolvedValue({});
    await click("重试重启服务");
    expect(calls("save_config")).toHaveLength(1);
    expect(calls("restart_mcp_server")).toHaveLength(2);
    expect(host.textContent).not.toContain("重启失败");
    expect(button("重试重启服务")).toBeUndefined();
  });
});
