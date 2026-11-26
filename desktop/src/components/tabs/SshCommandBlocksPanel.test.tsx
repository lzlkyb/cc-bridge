// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { SshCommandBlocksPanel } from "./SshCommandBlocksPanel";

const h = vi.hoisted(() => ({ write: vi.fn(), toast: vi.fn(), scroll: vi.fn(), focus: vi.fn() }));
vi.mock("../ui/toast", () => ({ toast: h.toast }));
vi.mock("../../lib/terminalCommandNav", () => ({
  formatCmdDuration: () => "1.2s",
  navBlockCount: () => 1,
  navBlockAt: () => ({ line: 5, exitCode: 0, durMs: 1200, cmd: "ls -la" }),
  navBlockOutput: () => "total 0\ndrwxr-xr-x",
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, term: Terminal;

beforeEach(() => {
  vi.clearAllMocks();
  h.write.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: h.write } });
  term = {
    buffer: { active: { viewportY: 0 } },
    onScroll: () => ({ dispose: () => undefined }),
    scrollToLine: h.scroll,
    focus: h.focus,
  } as unknown as Terminal;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<SshCommandBlocksPanel termRef={{ current: term }} name="dev" closed={false} onClose={() => undefined} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
const copyBtn = () => buttons().find((b) => b.textContent === "复制")!;
const jumpBtn = () => buttons().find((b) => b.title?.startsWith("跳到这一条"))!;

describe("命令历史面板：行的可达性", () => {
  it("🔴 行不是 role=button：跳转与复制是两个独立按钮（嵌套交互控件违反 ARIA 内容模型）", () => {
    expect(host.querySelector('[role="button"]')).toBeNull();
    expect(jumpBtn()).toBeTruthy();
    expect(copyBtn()).toBeTruthy();
    // 复制按钮常显：此前 hidden + group-hover:block ⇒ display:none，键盘与触摸永远够不到
    expect(copyBtn().className).not.toMatch(/\bhidden\b/);
    expect(copyBtn().tabIndex).toBe(0);
  });

  it("点复制只复制，不跳转", async () => {
    await act(async () => copyBtn().click());
    expect(h.write).toHaveBeenCalledWith("total 0\ndrwxr-xr-x");
    expect(h.scroll).not.toHaveBeenCalled();
  });

  it("点跳转滚到该块并聚焦终端", async () => {
    await act(async () => jumpBtn().click());
    expect(h.scroll).toHaveBeenCalledWith(5);
    expect(h.focus).toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
});