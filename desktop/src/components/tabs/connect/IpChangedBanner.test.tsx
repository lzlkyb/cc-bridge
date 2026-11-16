// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IpChangedBanner } from "./IpChangedBanner";
import { ToastProvider } from "../../ui/toast";

/**
 * 2026-11-16 用户反馈回归：横幅上的「复制命令」置灰点不动。
 *
 * 根因是通用 MCP 工具（generic）没有约定的配置文件 → buildIpSedCommand 返回空串 →
 * canCopy=false。此前表现为一个永远禁用、也没有任何解释的灰按钮，看起来就是坏了。
 * 现在的要求：无命令时连按钮都不渲染，改为「需手动更新」+ 手动更新说明。
 */
let host: HTMLDivElement;
let root: Root;
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

const base = {
  lanIps: ["10.0.7.185"],
  selectedIp: "10.0.7.185",
  previousIp: "10.203.5.22",
  port: 7823,
  scope: "project" as const,
  projectPath: "/home/ubuntu/projects/orders",
};

const copyButtons = () =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
    (b.textContent ?? "").includes("复制命令"),
  );

async function render(ui: React.ReactElement) {
  await act(async () => root.render(<ToastProvider>{ui}</ToastProvider>));
}

it("通用 MCP 工具没有约定配置文件时不渲染复制按钮，改为提示手动更新", async () => {
  await render(
    <IpChangedBanner {...base} client="generic" onResolved={vi.fn()} onSedResolved={vi.fn()} />,
  );
  expect(copyButtons()).toHaveLength(0);
  expect(host.textContent).toContain("需手动更新");
  expect(host.textContent).toContain("请手动改地址");
  // 展开详情里给出手动修改的具体地址（而不是「复制以下命令」的错误指引）。
  expect(host.textContent).toContain("手动把该工具配置里的地址改成");
  expect(host.textContent).not.toContain("复制以下命令到原接入位置执行");
});

it("Claude Code 有约定配置文件时复制按钮可用", async () => {
  await render(
    <IpChangedBanner {...base} client="claude-code" onResolved={vi.fn()} onSedResolved={vi.fn()} />,
  );
  const [btn] = copyButtons();
  expect(btn).toBeDefined();
  expect(btn.disabled).toBe(false);
});

it("commandOverride 为空串（隧道路径）时回退到本地拼命令，不把按钮判成永久禁用", async () => {
  // 回归：`commandOverride ?? buildSed(...)` 把空串当有效命令 → canCopy=false 永不恢复。
  const onCopy = vi.fn(() => true);
  await render(
    <IpChangedBanner
      {...base}
      client="claude-code"
      commandOverride=""
      onCopyCommand={onCopy}
      onResolved={vi.fn()}
      onSedResolved={vi.fn()}
    />,
  );
  const [btn] = copyButtons();
  expect(btn).toBeDefined();
  expect(btn.disabled).toBe(false);
  await act(async () => btn.click());
  expect(onCopy).toHaveBeenCalledTimes(1);
});

it("有外部命令时直接用它，点击走 onCopyCommand 并收口横幅", async () => {
  const onCopy = vi.fn(() => true);
  const onResolved = vi.fn();
  const onSedResolved = vi.fn();
  await render(
    <IpChangedBanner
      {...base}
      client="claude-code"
      commandOverride="sed -i 's/10.203.5.22/10.0.7.185/g' ~/.claude.json"
      onCopyCommand={onCopy}
      onResolved={onResolved}
      onSedResolved={onSedResolved}
    />,
  );
  const [btn] = copyButtons();
  await act(async () => btn.click());
  expect(onCopy).toHaveBeenCalledTimes(1);
  expect(onResolved).toHaveBeenCalledWith("10.0.7.185");
  expect(onSedResolved).toHaveBeenCalled();
});
