// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalStatusBar } from "./TerminalStatusBar";
import type { SshConnection } from "../../lib/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conn = {
  id: "c1",
  name: "示例服务器",
  host: "192.0.2.10",
  port: 22,
  username: "u",
  authType: "password",
} as SshConnection;

let root: Root, host: HTMLDivElement;

function render(over: { closed?: boolean; state?: "pending" | "skipped" | "ready" | "unsupported" } = {}) {
  act(() =>
    root.render(
      <TerminalStatusBar
        sessionId="s1"
        conn={conn}
        preset="indigo"
        mode="dark"
        status={{ cwd: "/home/u/work", branch: "main", exitCode: 2, lastCmdMs: 4200 }}
        state={over.state ?? "ready"}
        closed={over.closed ?? false}
      />,
    ),
  );
  return host.textContent ?? "";
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("TerminalStatusBar 的断线态", () => {
  it("连着的时候照常显示 cwd / 分支 / 退出码 / 上条耗时", () => {
    const text = render();
    expect(text).toContain("main");
    expect(text).toContain("2"); // exit code
  });

  it("🔴 断开后不再展示上个会话的残留值（只留「已断开」与会话时长）", () => {
    const text = render({ closed: true });
    expect(text).toContain("已断开");
    // 这四个都是冻结的旧值，继续显示等于谎报远端状态
    expect(text).not.toContain("main");
    expect(text).not.toContain("work");
  });
});

describe("TerminalStatusBar 的准备期提示", () => {
  it("pending 明确说「正在准备远端环境」（此时远端 ECHO 是关的，不回显）", () => {
    expect(render({ state: "pending" })).toContain("正在准备远端环境");
  });

  it("🔴 「用户开始输入而跳过探测」与「远端不支持」必须是两句话", () => {
    const skipped = render({ state: "skipped" });
    expect(skipped).toContain("已跳过远端探测");
    expect(skipped).not.toContain("路径/git 不可用");
    expect(render({ state: "unsupported" })).toContain("路径/git 不可用");
  });
});
