// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SshFileEditorNotice } from "./SshFileEditorNotice";

const h = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../ui/toast", () => ({ toast: h.toast }));

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
  vi.clearAllMocks();
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

it("普通读取失败：带出错误文案 + 只给「复制诊断信息」，不给外部打开按钮", async () => {
  await render({ error: "No such file or directory" });
  const bar = host.querySelector('[role="alert"]')!;
  expect(bar.textContent).toContain("读取失败：No such file or directory");
  // 二进制以外的错误没有「用本机编辑器打开」，但要有复制入口（诊断拿去贴给人）
  expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    "复制诊断信息",
  ]);
});

it("🔴 保存失败说「保存失败」并给定心丸（旧版一律显示「读取失败」，主体都说错了）", async () => {
  await render({ error: "目标目录 /etc 属主 root", errorKind: "save" });
  const bar = host.querySelector('[role="alert"]')!;
  expect(bar.textContent).toContain("保存失败：目标目录 /etc 属主 root");
  expect(bar.textContent).not.toContain("读取失败");
  expect(bar.textContent).toContain("你的修改没有写入，编辑器里的内容还在");
});

it("复制诊断信息：整段（含前缀）进剪贴板，按钮就地切「已复制」", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  await render({ error: "[Errno 13] Permission denied（属主 claude-svc，权限 0600）" });
  const btn = host.querySelector<HTMLButtonElement>('[role="alert"] button')!;
  await act(async () => btn.click());
  expect(writeText).toHaveBeenCalledWith(
    "读取失败：[Errno 13] Permission denied（属主 claude-svc，权限 0600）",
  );
  expect(btn.textContent).toContain("已复制");
  expect(h.toast).not.toHaveBeenCalled();
});

it("剪贴板不可用：给 toast 提示，不静默失败", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  await render({ error: "Permission denied" });
  const btn = host.querySelector<HTMLButtonElement>('[role="alert"] button')!;
  await act(async () => btn.click());
  expect(h.toast).toHaveBeenCalled();
  expect(btn.textContent).toContain("复制诊断信息");
});

it("冲突优先于截断提示（两个条件同时成立时只显示冲突）", async () => {
  await render({ conflict: true, truncated: true, size: 1024 });
  expect(host.textContent).toContain("被改过");
  expect(host.textContent).not.toContain("内联编辑上限");
});
