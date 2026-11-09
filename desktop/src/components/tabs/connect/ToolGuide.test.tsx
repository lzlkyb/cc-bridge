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
