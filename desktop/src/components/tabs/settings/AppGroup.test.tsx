// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { AppGroup } from "./AppGroup";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../ui/toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("./AppearanceSettings", () => ({ AppearanceSettings: () => null }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const autostart = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="开机自动启动"]')!;
beforeEach(() => { mocks.invoke.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe("自启设置的未知与失败状态", () => {
  it("读取失败显示未知并禁用开关，重试成功后才显示确认值", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("read failure"));
    await act(async () => root.render(<AppGroup />));
    const row = host.querySelector('#app-startup')!;
    expect(row.textContent).toContain("状态未知");
    expect(row.textContent).not.toContain("已关闭");
    expect(autostart().disabled).toBe(true);
    mocks.invoke.mockResolvedValueOnce(true);
    const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "重试")!;
    await act(async () => retry.click());
    expect(autostart().disabled).toBe(false);
    expect(autostart().getAttribute("aria-checked")).toBe("true");
    expect(row.textContent).not.toContain("无法读取");
  });
  it("保存失败保留原确认值，并提供持久可读的行内错误", async () => {
    mocks.invoke.mockResolvedValueOnce(true);
    await act(async () => root.render(<AppGroup />));
    mocks.invoke.mockRejectedValueOnce(new Error("write failure"));
    await act(async () => autostart().click());
    expect(autostart().getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('#app-startup [role="alert"]')?.textContent).toContain("原设置未改变");
    expect(mocks.invoke).toHaveBeenLastCalledWith("set_autostart", { enabled: false });
  });
});
