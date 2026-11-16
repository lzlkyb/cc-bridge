// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useServiceControl } from "./useServiceControl";
import type { StaticStatus } from "../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), changed: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
let root: Root, host: HTMLDivElement, controls: ReturnType<typeof useServiceControl>[];
function Control({ index, status }: { index: number; status: StaticStatus }) {
  const control = useServiceControl(status, mocks.changed); controls[index] = control;
  return <button disabled={control.busy}>{control.pending ?? control.error ?? "空闲"}</button>;
}
const mount = (pending: "start" | "stop" | "restart" | null = null) => act(async () => root.render(<><Control index={0} status={{ serviceControl: { pending, error: null } } as StaticStatus}/><Control index={1} status={{ serviceControl: { pending, error: null } } as StaticStatus}/></>));
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mocks.invoke.mockReset(); mocks.changed.mockReset(); mocks.toast.mockReset(); controls = []; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("多入口在同一帧启动、停止、重启只提交一项操作", async () => {
  let finish!: () => void; mocks.invoke.mockImplementation(() => new Promise<void>(yes => { finish = yes; }));
  await mount(); let first!: Promise<boolean>, second!: Promise<boolean>;
  await act(async () => { first = controls[0].run("restart"); second = controls[1].run("stop"); });
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("restart_mcp_server");
  expect([...host.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  expect(await second).toBe(false);
  await act(async () => { finish(); expect(await first).toBe(true); });
  expect([...host.querySelectorAll("button")].every(button => !button.disabled)).toBe(true);
  expect(mocks.changed).toHaveBeenCalledOnce();
});
it("托盘操作中的后台状态会阻止页面重复发起服务操作", async () => {
  await mount("stop"); expect(await controls[0].run("start")).toBe(false);
  expect(mocks.invoke).not.toHaveBeenCalled();
  await mount(); mocks.invoke.mockResolvedValue(undefined);
  await act(async () => { expect(await controls[0].run("start")).toBe(true); });
});
it("失败后各入口共享错误，重试成功清除错误", async () => {
  await mount(); mocks.invoke.mockRejectedValueOnce(new Error("port occupied"));
  await act(async () => { expect(await controls[0].run("start")).toBe(false); });
  expect(controls[0].error).toContain("port occupied"); expect(controls[1].error).toContain("port occupied");
  mocks.invoke.mockResolvedValue(undefined);
  await act(async () => { expect(await controls[1].run("start")).toBe(true); });
  expect(controls[0].error).toBeNull(); expect(controls[1].error).toBeNull();
});
