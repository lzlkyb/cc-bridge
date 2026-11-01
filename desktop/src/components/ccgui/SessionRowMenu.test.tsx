// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionRowMenu } from "./SessionRowMenu";
vi.mock("./ChatPopover", () => ({ ChatPopover: ({ children, label }: { children: ReactNode; label: string }) => <div role="dialog" aria-label={label}>{children}</div> }));
let host: HTMLDivElement, root: Root;
const remove = vi.fn();
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); remove.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function click(text: string) { const el = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text); expect(el).toBeTruthy(); await act(async () => el!.click()); }
async function open(rowId: number | null = 7) {
  act(() => root.render(<SessionRowMenu rowId={rowId} title="登录排查" archived={false} onRename={vi.fn()} onArchive={vi.fn()} onDelete={remove} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-haspopup]')!.click());
}
it("删除必须确认，取消不调用后端，成功后关闭菜单", async () => {
  remove.mockResolvedValue(undefined); await open(); await click("删除会话…");
  expect(remove).not.toHaveBeenCalled(); expect(host.textContent).toContain("不会撤销文件修改");
  await click("取消"); expect(remove).not.toHaveBeenCalled();
  await click("删除会话…"); await click("确认删除");
  expect(remove).toHaveBeenCalledTimes(1); expect(host.querySelector('[role="dialog"]')).toBeNull();
});
it("删除失败时显示错误，允许重试且不丢确认对象", async () => {
  remove.mockRejectedValue(new Error("删除失败")); await open(); await click("删除会话…"); await click("确认删除");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("删除失败");
  expect(host.textContent).toContain("登录排查"); remove.mockResolvedValue(undefined); await click("确认删除"); expect(remove).toHaveBeenCalledTimes(2);
});
it("未落盘的空白会话也能删除，但不能重命名或归档", async () => {
  await open(null); expect(host.textContent).toContain("还没落过盘"); await click("删除会话…"); expect(host.textContent).toContain("确认删除");
});
