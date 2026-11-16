// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TokenManager } from "./TokenManager";
import type { StaticStatus } from "../../lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), refresh: vi.fn(), update: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("../../hooks/useAutoAnimateRM", () => ({ useAutoAnimateRM: () => ({ current: null }) }));
let root: Root, host: HTMLDivElement;
const status = (id: string, token = "old-token", pending = false) => ({ token,
  currentAccess: { method: "stable", connectionId: id, scope: "project", projectPath: `/srv/${id}`, targetKey: `${id}:${token}`, tokenUpdatePending: pending } }) as StaticStatus;
const render = (id = "a", token = "old-token", pending = false) => act(async () => root.render(<TokenManager
  status={status(id, token, pending)} projectPath={`/srv/${id}`} onRefresh={mocks.refresh} onStableUpdate={mocks.update}/>));
const click = (text: string) => act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent?.trim() === text)!.click());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mocks.invoke.mockReset(); mocks.toast.mockReset(); mocks.refresh.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("生成期间切换服务器，不把旧目标的完成提示加到新服务器", async () => {
  const request = deferred<string>(); mocks.invoke.mockReturnValueOnce(request.promise);
  await render(); await click("重生成"); await click("确定"); await render("b");
  await act(async () => request.resolve("next-token"));
  expect(host.textContent).not.toContain("原接入的 Token 待同步"); expect(mocks.toast).not.toHaveBeenCalled();
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
it("后台确认原接入已应用后，令牌待同步提示随统一状态收起", async () => {
  mocks.invoke.mockResolvedValueOnce("next-token"); await render(); await click("重生成"); await click("确定");
  expect(host.textContent).toContain("原接入的 Token 待同步");
  await render("a", "next-token", true); expect(host.textContent).toContain("原接入的 Token 待同步");
  await render("a", "next-token", false); expect(host.textContent).not.toContain("原接入的 Token 待同步");
});
