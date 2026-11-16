// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PendingCommandPill } from "./PendingCommandPill";
import type { StaticStatus } from "../../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), write: vi.fn(), toast: vi.fn(), resolved: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../lib/utils", async original => ({ ...await original<typeof import("../../lib/utils")>(),
  copyText: async (text: string, copied: () => void, failed: (error: unknown) => void) => {
    try { await mocks.write(text); copied(); } catch (error) { failed(error); }
  },
}));
let root: Root, host: HTMLDivElement;
const render = (key = "a", command = "update-a") => act(async () => root.render(<PendingCommandPill
  status={{ currentAccess: { method: "direct", targetKey: key } } as StaticStatus}
  pending={{ ip: "10.0.0.2", cmd: command }} onResolved={mocks.resolved}/>));
const click = () => act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  mocks.invoke.mockReset().mockResolvedValue({ text: "update-a", targetKey: "a" });
  mocks.write.mockReset().mockResolvedValue(undefined); mocks.toast.mockReset(); mocks.resolved.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("剪贴板失败保留可重试入口，成功后才淡出收口", async () => {
  mocks.write.mockRejectedValueOnce(new Error("clipboard unavailable")); await render(); await click();
  expect(host.textContent).not.toContain("已复制"); await advance(3000); expect(mocks.resolved).not.toHaveBeenCalled();
  await click(); expect(host.textContent).toContain("已复制，待执行");
  await advance(1650); expect(mocks.resolved).toHaveBeenCalledTimes(1);
});
it("生成过程中切换目标，旧命令不能覆盖剪贴板", async () => {
  const request = deferred<{ text: string; targetKey: string }>(); mocks.invoke.mockReturnValueOnce(request.promise);
  await render(); await click(); expect(host.textContent).toContain("正在复制");
  await render("b", "update-b"); await act(async () => request.resolve({ text: "update-a", targetKey: "a" }));
  expect(mocks.write).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("已复制");
});
it("复制后切换目标取消旧淡出回调", async () => {
  await render(); await click(); await render("b", "update-b"); await advance(3000);
  expect(mocks.resolved).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("已复制");
});
it("卸载后不处理迟到的复制结果", async () => {
  const request = deferred<{ text: string; targetKey: string }>(); mocks.invoke.mockReturnValueOnce(request.promise);
  await render(); await click(); await act(async () => root.render(null));
  await act(async () => request.resolve({ text: "update-a", targetKey: "a" })); await advance(3000);
  expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.resolved).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
});
