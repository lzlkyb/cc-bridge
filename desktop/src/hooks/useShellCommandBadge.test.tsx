// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useShellCommandBadge } from "./useShellCommandBadge";
import type { TerminalStatus } from "./useTerminalOsc";
import type { TermTabMetaPatch } from "./useTerminalTabMeta";
import type { ProgramStatus } from "../lib/terminalProgramStatus";

const EMPTY: TerminalStatus = { cwd: null, branch: null, exitCode: null, lastCmdMs: null, cmdSeq: 0 };
const done = (over: Partial<TerminalStatus>): TerminalStatus => ({
  ...EMPTY,
  cmdSeq: 1,
  exitCode: 0,
  lastCmdMs: 6000,
  ...over,
});
const agentOf = (state: ProgramStatus["state"]): ProgramStatus => ({
  state,
  kind: null,
  app: "claude-code",
  title: null,
  msg: null,
  progress: null,
});

let root: Root;
let host: HTMLDivElement;
let patches: TermTabMetaPatch[] = [];

function Probe({
  status,
  visible,
  agent,
}: {
  status: TerminalStatus;
  visible: boolean;
  agent: ProgramStatus | null;
}) {
  useShellCommandBadge({ status, visible, agent, onMeta: (p) => patches.push(p) });
  return null;
}

async function render(status: TerminalStatus, visible: boolean, agent: ProgramStatus | null = null) {
  await act(async () => root.render(<Probe status={status} visible={visible} agent={agent} />));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  patches = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // 首次渲染只建立基线（seqRef 取当前 cmdSeq），不该上报
  await render(EMPTY, false);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("挂载时不补报历史：只认挂载之后到达的新命令", () => {
  expect(patches).toHaveLength(0);
});

it("🔴 后台标签跑完长命令点亮徽标：这正是普通构建在标签上原本看不见的那件事", async () => {
  await render(done({}), false);
  expect(patches).toHaveLength(1);
  expect(patches[0].agent?.state).toBe("done");
  expect(patches[0].agent?.app).toBe("shell");
});

it("退出码非 0 记为 error，且把退出码写进说明", async () => {
  await render(done({ exitCode: 7 }), false);
  expect(patches[0].agent?.state).toBe("error");
  expect(patches[0].agent?.msg).toContain("7");
});

it("标签可见时不提示：用户已经盯着它跑完了，再点亮就是噪声", async () => {
  await render(done({}), true);
  expect(patches).toHaveLength(0);
});

it("🔴 短命令不打扰：耗时不足阈值（ls / cd 之类）", async () => {
  await render(done({ lastCmdMs: 400 }), false);
  expect(patches).toHaveLength(0);
});

it("🔴 CC 正在干活 / 等确认时以 CC 为准：shell 的子进程结束不能顶掉它的状态", async () => {
  await render(done({}), false, agentOf("working"));
  expect(patches).toHaveLength(0);
  await render(done({ cmdSeq: 2 }), false, agentOf("blocked"));
  expect(patches).toHaveLength(0);
});

it("CC 处于 idle / done 时允许覆盖：退回 shell 跑的命令，它的结束才是最新事实", async () => {
  await render(done({}), false, agentOf("idle"));
  expect(patches).toHaveLength(1);
  expect(patches[0].agent?.app).toBe("shell");
});

it("🔴 只有 cmdSeq 变化才算新命令：cwd / 分支变化会换掉整个 status 对象，不能靠引用比", async () => {
  await render({ ...EMPTY, cwd: "/tmp", branch: "main", cmdSeq: 0 }, false);
  expect(patches).toHaveLength(0);
  await render({ ...EMPTY, cwd: "/var", branch: "dev", cmdSeq: 0 }, false);
  expect(patches).toHaveLength(0);
});
