// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SshFileEditorNotice } from "./SshFileEditorNotice";

let root: Root;
let host: HTMLDivElement;
const noop = () => {};

function render(props: Partial<Parameters<typeof SshFileEditorNotice>[0]> = {}) {
  return act(async () => {
    root.render(
      <SshFileEditorNotice
        conflict={false}
        remoteMtime={0}
        truncated={false}
        size={0}
        error={null}
        busy={false}
        onReload={noop}
        onForceSave={noop}
        onOpenExternal={noop}
        {...props}
      />,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("无冲突 / 非截断 / 无错误时不渲染任何条", async () => {
  await render();
  expect(host.innerHTML).toBe("");
});

it("🔴 远端被改：内联条给出「重新加载」与「仍然覆盖保存」两条出路，不弹窗", async () => {
  const onReload = vi.fn();
  const onForceSave = vi.fn();
  await render({ conflict: true, remoteMtime: 1732000000, onReload, onForceSave });
  const bar = host.querySelector('[role="status"]')!;
  expect(bar.textContent).toContain("服务器上的文件在你打开之后被改过");
  const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.map((b) => b.textContent)).toEqual(["重新加载（放弃我的修改）", "仍然覆盖保存"]);
  // 没有 dialog：冲突不该抢走用户正在编辑的上下文（R17）
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => buttons[1].click());
  expect(onForceSave).toHaveBeenCalledOnce();
  expect(onReload).not.toHaveBeenCalled();
});

it("大文件只读：提示上限，且不再重复「用本机编辑器打开」（顶栏常驻那个）", async () => {
  await render({ truncated: true, size: 5 * 1024 * 1024 });
  const bar = host.querySelector('[role="status"]')!;
  expect(bar.textContent).toContain("5.0 MB");
  expect(bar.textContent).toContain("2 MB");
  expect(bar.querySelector("button")).toBeNull();
});

it("二进制文件：引导用本机编辑器打开，并给按钮", async () => {
  const onOpenExternal = vi.fn();
  await render({ error: "binary", onOpenExternal });
  const bar = host.querySelector('[role="alert"]')!;
  expect(bar.textContent).toContain("不是 UTF-8 或 GBK/GB18030");
  await act(async () => bar.querySelector<HTMLButtonElement>("button")!.click());
  expect(onOpenExternal).toHaveBeenCalledOnce();
});

it("普通读取失败：原样带出错误文案，不给外部打开按钮", async () => {
  await render({ error: "No such file or directory" });
  const bar = host.querySelector('[role="alert"]')!;
  expect(bar.textContent).toContain("No such file or directory");
  expect(bar.querySelector("button")).toBeNull();
});

it("冲突优先于截断提示（两个条件同时成立时只显示冲突）", async () => {
  await render({ conflict: true, truncated: true, size: 1024 });
  expect(host.textContent).toContain("被改过");
  expect(host.textContent).not.toContain("内联编辑上限");
});
