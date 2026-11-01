// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClawdWorkspace } from "./ClawdWorkspace";
import { CcConversationLayout } from "./CcConversationLayout";
import { clawdActivity } from "../../lib/ccClawd";
import { initialCcView, type CcView } from "../../lib/ccReducer";

let root: Root, host: HTMLDivElement;
const stop = vi.fn(), expand = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); stop.mockClear(); expand.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function Harness({ view, onStopTask }: { view: CcView; onStopTask?: (id: string, token: string) => Promise<string> }) {
  const rootRef = useRef<HTMLDivElement>(null), scrollRef = useRef<HTMLDivElement>(null);
  return <div data-cc-panel><CcConversationLayout><div ref={rootRef} className="cc-clawd-stream"><div ref={scrollRef}><details><summary>执行过程</summary><div data-cc-tool="t"><button aria-expanded="false" onClick={expand}>展开原始工具</button></div></details></div><ClawdWorkspace view={view} activity={clawdActivity(view)} rootRef={rootRef} scrollRef={scrollRef} startedAt={null} onStopTask={onStopTask} /></div><textarea /></CcConversationLayout></div>;
}
const render = (view: CcView) => act(() => root.render(<Harness view={view} />));
function click(text: string) { const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text); expect(button).toBeTruthy(); act(() => button!.click()); }

it("单个主角色按真实状态切换，点击工具能展开已分组记录", () => {
  const view: CcView = { ...initialCcView, running: true, messages: [{ kind: "tool", id: "t", at: "", tool: { id: "t", name: "Edit", input: { file_path: "a.ts" }, status: "running" } }] };
  render(view);
  expect(host.querySelectorAll(".cc-clawd-companion")).toHaveLength(1);
  expect(host.querySelector("svg")?.getAttribute("data-act")).toBe("editing");
  click("查看修改"); expect(expand).toHaveBeenCalledTimes(1); expect(host.querySelector("details")?.open).toBe(true);
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "停止本轮")).toBe(false);
});
it("小队展示真实身份、父任务和不同状态，普通后台命令不显示成成员", () => {
  render({ ...initialCcView, tasks: {
    a: { taskId: "a", taskType: "local_agent", name: "Explore", description: "检查登录", status: "running", lastToolName: "Read" },
    b: { taskId: "b", parentTaskId: "a", taskType: "local_agent", name: "Verify", status: "completed", summary: "6 项通过" },
    cmd: { taskId: "cmd", taskType: "local_bash", status: "running" },
  } });
  expect(host.querySelector(".cc-clawd-roster")).toBeTruthy();
  expect(host.querySelectorAll(".cc-clawd-agent")).toHaveLength(2);
  act(() => host.querySelectorAll<HTMLButtonElement>(".cc-clawd-agent")[1].click());
  expect(host.querySelector('[aria-label="Agent 任务详情"]')?.textContent).toContain("父任务：检查登录");
  expect(host.querySelector('[data-act="reading"]')).toBeTruthy();
});
it("减少动态效果保留入口并保存设置，输入时安静停靠", () => {
  render(initialCcView); click("减少动态");
  expect(localStorage.getItem("cc-bridge.clawd.reduce-motion")).toBe("true");
  expect(host.querySelector('[data-clawd-reduced="true"]')).toBeTruthy();
  act(() => host.querySelector("textarea")!.focus());
  expect(host.querySelector('[data-clawd-typing="true"]')).toBeTruthy();
  expect(host.querySelector(".cc-clawd-companion")?.getAttribute("aria-label")).toContain("准备好了");
});
it("空闲点击只挥手，卸载清理动作计时器", () => {
  render(initialCcView); act(() => host.querySelector<HTMLButtonElement>(".cc-clawd-companion")!.click());
  expect(host.querySelector(".cc-clawd-companion")?.getAttribute("data-wave")).toBe("true");
  expect(stop).not.toHaveBeenCalled(); act(() => vi.advanceTimersByTime(1400));
  expect(host.querySelector(".cc-clawd-companion")?.getAttribute("data-wave")).toBe("false");
});

it("执行记录只展示本轮，关闭后回到角色", () => {
  render({ ...initialCcView, messages: [
    { kind: "user", id: "u1", at: "", text: "old" },
    { kind: "tool", id: "old", at: "", tool: { id: "old", name: "Read", input: {}, status: "ok" } },
    { kind: "user", id: "u2", at: "", text: "new" },
    { kind: "tool", id: "new", at: "", tool: { id: "new", name: "Bash", input: {}, status: "ok" } },
  ] });
  click("执行记录");
  expect(host.querySelector(".cc-clawd-records")?.textContent).toContain("Bash");
  expect(host.querySelector(".cc-clawd-records")?.textContent).not.toContain("Read");
  click("关闭"); expect(host.querySelector(".cc-clawd-inspector")).toBeNull();
  expect(document.activeElement).toBe(host.querySelector(".cc-clawd-companion"));
});
it("历史完成静态，实时完成只播放一次", () => {
  render({ ...initialCcView, lastOutcome: "complete" });
  expect(host.querySelector(".cc-clawd-companion .is-static")).toBeTruthy();
  render({ ...initialCcView, running: true });
  render({ ...initialCcView, lastOutcome: "complete" });
  expect(host.querySelector(".cc-clawd-companion .is-static")).toBeNull();
  act(() => vi.advanceTimersByTime(750));
  expect(host.querySelector(".cc-clawd-companion .is-static")).toBeTruthy();
});
it("动态偏好同步所有已挂载会话，Esc关闭小队并返回角色", () => {
  const view: CcView = { ...initialCcView, tasks: { a: { taskId: "a", taskType: "local_agent", status: "running" } } };
  act(() => root.render(<><Harness view={view} /><Harness view={view} /></>));
  const controls = host.querySelectorAll<HTMLButtonElement>('[aria-label="减少 Clawd 动态效果"]');
  act(() => controls[0].click());
  expect(host.querySelectorAll('.cc-clawd-stream[data-clawd-reduced="true"]')).toHaveLength(2);
  act(() => controls[1].click());
  expect(host.querySelectorAll('.cc-clawd-stream[data-clawd-reduced="false"]')).toHaveLength(2);
  expect(host.querySelector(".cc-clawd-roster")).toBeTruthy();
  act(() => host.querySelector<HTMLButtonElement>(".cc-clawd-agent")!.click());
  host.querySelector("[data-cc-panel]")!.classList.add("hidden");
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector(".cc-clawd-task-detail")).not.toBeNull();
  host.querySelector("[data-cc-panel]")!.classList.remove("hidden");
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector(".cc-clawd-task-detail")).toBeNull();
  expect(document.activeElement).toBe(host.querySelector(".cc-clawd-agent"));
});

it("单成员停止等待真实确认，收起小队后仍保留状态，失败可重试", async () => {
  let rejectStop!: (error: string) => void;
  const onStopTask = vi.fn(() => new Promise<string>((_, reject) => { rejectStop = reject; }));
  const view: CcView = { ...initialCcView, tasks: {
    a: { taskId: "a", stopToken: "token-a", background: true, taskType: "local_agent", description: "检查 A", status: "running" },
    b: { taskId: "b", stopToken: "token-b", background: true, taskType: "local_agent", description: "检查 B", status: "running" },
    remote: { taskId: "r", stopToken: "token-r", background: true, taskType: "remote_agent", status: "running" },
  } };
  act(() => root.render(<Harness view={view} onStopTask={onStopTask} />));
  expect(host.querySelectorAll(".cc-clawd-member")).toHaveLength(3);
  const button = () => host.querySelector<HTMLButtonElement>('[aria-label="停止成员：检查 A"]')!;
  act(() => button().click());
  expect(onStopTask).toHaveBeenCalledWith("a", "token-a");
  expect(button().disabled).toBe(true);
  expect(host.querySelector('[aria-label="停止成员：检查 B"]')).toBeTruthy();
  expect(host.querySelector('[aria-label="停止成员：r"]')).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>(".cc-clawd-agent")!.click());
  click("关闭"); expect(button().disabled).toBe(true);
  await act(async () => { rejectStop("停止尚未确认"); });
  expect(button().disabled).toBe(false);
  expect(host.textContent).toContain("停止尚未确认");
  expect(view.tasks?.a.status).toBe("running");
});

it("小队默认显示全部八名成员并挂载到独立布局区域", () => {
  const tasks = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index), { taskId: String(index), taskType: "local_agent", name: ["Explore", "Implement", "Review", "Verify"][index % 4], status: "running" }]));
  render({ ...initialCcView, tasks });
  expect(host.querySelectorAll(".cc-squad-host .cc-clawd-member")).toHaveLength(8);
  expect(host.querySelector(".cc-clawd-stream .cc-clawd-roster")).toBeNull();
  expect(host.querySelectorAll('[data-motion="full"]')).toHaveLength(2);
  const colors = new Set([...host.querySelectorAll(".cc-clawd-member svg")].map(svg => svg.getAttribute("data-palette")));
  expect(colors.size).toBeGreaterThan(2);
  expect(host.querySelector('.cc-clawd-member [data-role="review"]')).toBeTruthy();
});

it("成员完成只响应实时状态变化，历史完成不重复庆祝", () => {
  const task = { taskId: "member", taskType: "local_agent", status: "completed" };
  render({ ...initialCcView, tasks: { member: task } });
  expect(host.querySelector(".cc-clawd-member .is-static")).toBeTruthy();
  render({ ...initialCcView, tasks: { member: { ...task, status: "running" } } });
  render({ ...initialCcView, tasks: { member: task } });
  expect(host.querySelector(".cc-clawd-member .is-static")).toBeNull();
  act(() => vi.advanceTimersByTime(750));
  expect(host.querySelector(".cc-clawd-member .is-static")).toBeTruthy();
});
