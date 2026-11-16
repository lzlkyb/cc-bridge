// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolGuide } from "./ToolGuide";
import { ToastProvider } from "../../ui/toast";
import type { McpClientTool } from "../../../lib/mcpClients";

vi.mock("../../../lib/tauri", () => ({ invoke: vi.fn().mockResolvedValue(""), invokeOrToast: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

/**
 * 🔴 回归守卫（2026-11-09）：地址卡片曾经放在 children 里，而 children 只在 Claude Code
 * 时渲染 —— 选其它工具的用户从 v2.8.0 起一直看不到它。common 插槽必须四种工具都在。
 */
it.each<McpClientTool>(["claude-code", "workbuddy", "codex", "generic"])("%s 下公共块始终渲染，专属内容只给 Claude Code", async (tool) => {
  await act(async () => root.render(
    <ToastProvider>
      <ToolGuide host="10.0.7.191" port={7823} token="t" transport="http" defaultTool={tool}
        common={<div data-testid="common">地址卡片</div>}>
        <div data-testid="claude-only">Claude Code 步骤</div>
      </ToolGuide>
    </ToastProvider>,
  ));
  expect(host.querySelector('[data-testid="common"]')).not.toBeNull();
  expect(!!host.querySelector('[data-testid="claude-only"]')).toBe(tool === "claude-code");
});

it("稳定连接可隐藏卡头多设备开关，其他接入流程保留原操作", async () => {
  const toggle = vi.fn();
  const render = (hide: boolean) => act(async () => root.render(<ToastProvider><ToolGuide host="10.0.7.191" port={7823} token="t" transport="http" hideMultiDeviceToggle={hide} onToggleMultiDevice={toggle}><div>接入内容</div></ToolGuide></ToastProvider>));
  await render(false);
  const control = host.querySelector<HTMLButtonElement>('[aria-label="多设备接入模式"]')!;
  expect(control).not.toBeNull();
  await act(async () => control.click()); expect(toggle).toHaveBeenCalledWith(true);
  await render(true);
  expect(host.querySelector('[aria-label="多设备接入模式"]')).toBeNull();
  expect(host.textContent).toContain("接入内容");
});

/**
 * 🔴 回归守卫（2026-11-16）：接入工具选择器必须由外部 `selectedTool` 受控。
 *
 * v3.1.5 只传 `defaultTool`，而它只吃首帧：连接页 keepMounted 首帧 status 还没到，
 * 兜底成 claude-code；重启后配置是「通用 MCP 工具」的用户，卡片标题却显示 Claude Code，
 * 而横幅/托盘读的是后端真实值 → 「复制命令」置灰、「复制地址更新命令」点了没反应，
 * UI 还在误导他去查 Claude Code 的配置。
 */
it("外部 selectedTool 变化时高亮跟随，不锁死在首帧值", async () => {
  const render = (tool: McpClientTool) =>
    act(async () =>
      root.render(
        <ToastProvider>
          <ToolGuide
            host="10.0.7.191"
            port={7823}
            token="t"
            transport="http"
            defaultTool="claude-code"
            selectedTool={tool}
          >
            <div>接入内容</div>
          </ToolGuide>
        </ToastProvider>,
      ),
    );
  const pressed = () =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="选择接入工具"] button')]
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);

  await render("claude-code");
  expect(pressed()).toEqual(["Claude Code"]);
  await render("generic");
  expect(pressed()).toEqual(["通用 MCP 工具"]);
  await render("codex");
  expect(pressed()).toEqual(["Codex"]);
});
