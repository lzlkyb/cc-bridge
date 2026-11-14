// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JournalSettings } from "./JournalSettings";
import type { StaticStatus } from "../../../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../ui/toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

const base = { journalEnabled: true, journalRetentionDays: 30, journalDir: "C:\\data\\journal" } as StaticStatus;
let host: HTMLDivElement, root: Root;
const saved = vi.fn();
const findButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
const click = async (text: string) => act(async () => findButton(text).click());
const days = () => document.querySelector<HTMLInputElement>('input[aria-label="变更日志保留天数"]')!;
const change = async (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(days(), value);
  days().dispatchEvent(new Event("input", { bubbles: true }));
});
const mount = (status: StaticStatus = base) => act(async () => root.render(<JournalSettings status={status} onSaved={saved} />));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  mocks.invoke.mockReset().mockResolvedValue({ restartRequired: false });
  mocks.toast.mockClear(); saved.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("变更日志设置", () => {
  it("状态未读到时按关闭展示；开启成功后提示重新连接", async () => {
    await mount({ ...base, journalEnabled: undefined } as unknown as StaticStatus);
    expect(days().closest("fieldset")?.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("save_config", { patch: { journalEnabled: true } });
    expect(mocks.toast.mock.calls.some(([msg]) => String(msg).includes("/mcp 重连"))).toBe(true);
  });
  it("缩短保留期必须确认，取消不落盘，确认后保存一次", async () => {
    await mount(); await change("7");
    expect(host.textContent).toContain("缩短保留期会删掉超期的日志");
    await click("应用"); expect(mocks.invoke).not.toHaveBeenCalled();
    await click("取消"); expect(mocks.invoke).not.toHaveBeenCalled();
    await click("应用"); await click("确定缩短");
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("save_config", { patch: { journalRetentionDays: 7 } });
    expect(host.textContent).toContain("当前生效：7 天");
  });
  it("延长保留期不确认，小于 1 不可应用", async () => {
    await mount(); await change("0");
    expect(findButton("应用").disabled).toBe(true);
    await change("90"); await click("应用");
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("save_config", { patch: { journalRetentionDays: 90 } });
  });
  it("关闭日志后保留天数置灰，但仍可打开目录", async () => {
    await mount({ ...base, journalEnabled: false });
    expect(days().closest("fieldset")?.disabled).toBe(true);
    expect(findButton("打开目录").closest("fieldset")).toBeNull();
    await click("打开目录");
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("reveal_journal_dir");
  });
});
