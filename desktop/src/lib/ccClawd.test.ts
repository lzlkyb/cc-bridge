import { describe, expect, it } from "vitest";
import { clawdActivity } from "./ccClawd";
import { ccReducer, initialCcView } from "./ccReducer";
import { snapshotTasks, updateTask } from "./ccAgentTasks";
import type { CcEvent } from "./ccEventTypes";

const run = (...events: CcEvent[]) => events.reduce((v, event) => ccReducer(v, { type: "event", event }), initialCcView);
describe("Clawd真实事件", () => {
  it("插话等待、调整方向和进入回复由真实回执驱动", () => {
    let view = ccReducer(initialCcView, { type: "sending" });
    view = ccReducer(view, { type: "event", event: { kind: "inputMessage", messageId: "a", text: "调整", mode: "now" } });
    expect(clawdActivity(view).label).toBe("正在调整执行方向");
    view = ccReducer(view, { type: "event", event: { kind: "inputStatus", messageId: "a", status: "written", detail: null } });
    expect(clawdActivity(view).label).toBe("补充已发送，等待读取");
    view = ccReducer(view, { type: "event", event: { kind: "inputStatus", messageId: "a", status: "processing", detail: null } });
    expect(clawdActivity(view).label).toBe("正在处理你的补充");
    view = ccReducer(view, { type: "event", event: { kind: "toolUse", toolUseId: "read", name: "Read", input: { file_path: "src/a.ts" } } });
    expect(clawdActivity(view)).toMatchObject({ pose: "reading", note: "src/a.ts · 1 条补充等待处理" });
  });
  it("新轮次不把旧回复当进展，工具只按真实运行状态判断", () => {
    const previous = run({ kind: "text", blockId: "old", text: "旧回复", streaming: false });
    expect(clawdActivity(ccReducer(previous, { type: "sending" }), { sending: true }).label).toBe("正在发送消息");
    for (const [name, pose] of [["Read", "reading"], ["Edit", "editing"], ["Bash", "executing"], ["Grep", "searching"]]) {
      const v = run({ kind: "toolUse", toolUseId: "t", name, input: { file_path: "a.ts" } });
      expect(clawdActivity({ ...v, running: true })).toMatchObject({ pose, targetId: "t" });
      const ended = ccReducer(v, { type: "event", event: { kind: "toolResult", toolUseId: "t", content: "ok", isError: false } });
      expect(clawdActivity({ ...ended, running: true }).pose).toBe("waiting");
    }
  });
  it("审批和停止优先，拒绝与停止不伪装成功", () => {
    const v = run({ kind: "permissionAsk", requestId: "a", toolName: "Edit", input: {}, toolUseId: "t", reason: null });
    expect(clawdActivity(v)).toMatchObject({ pose: "approval", targetId: "a" });
    expect(clawdActivity(v, { stopState: "unconfirmed" }).label).toBe("停止尚未确认");
    expect(clawdActivity(ccReducer({ ...v, running: true }, { type: "interrupted" })).pose).toBe("stopped");
  });
  it("普通后台命令不是Agent，有身份的子任务才形成小队", () => {
    const v = run({ kind: "taskUpdate", task: { taskId: "bash", taskType: "local_bash", status: "running" } }, { kind: "backgroundTasks", pending: 1 });
    expect(clawdActivity(v).label).toBe("后台任务仍在运行");
    const agent = ccReducer(v, { type: "event", event: { kind: "taskUpdate", task: { taskId: "agent", taskType: "local_agent", status: "running" } } });
    expect(clawdActivity(agent).label).toBe("小队正在协作");
  });
  it("轮结束不结束后台Agent，进程退出则标记未知", () => {
    const v = run({ kind: "taskUpdate", task: { taskId: "a", taskType: "local_agent", status: "running" } });
    const exit = ccReducer(v, { type: "event", event: { kind: "exit", code: null } });
    expect(exit.tasks?.a.status).toBe("unknown");
  });
  it("快照丢失只标未知、不宣称完成，前台Agent不受后台快照影响", () => {
    let tasks = updateTask({}, { taskId: "a", taskType: "local_agent", status: "running", background: true });
    tasks = updateTask(tasks, { taskId: "front", status: "running", background: false });
    const snapshot = snapshotTasks(tasks, []);
    expect(snapshot.a.status).toBe("unknown"); expect(snapshot.front.status).toBe("running");
  });
  it("迟到的旧run不覆盖新run，局部更新不清除身份或恢复已结束任务", () => {
    let tasks = updateTask({}, { taskId: "a", runId: "r2", status: "running", taskType: "local_agent", parentTaskId: "parent" });
    tasks = updateTask(tasks, { taskId: "a", runId: "r1", status: "completed" });
    expect(tasks.a.status).toBe("running");
    tasks = updateTask(tasks, { taskId: "a", runId: "r2", summary: "读取中", lastToolName: "Read" });
    expect(tasks.a).toMatchObject({ taskType: "local_agent", parentTaskId: "parent", status: "running" });
    tasks = updateTask(tasks, { taskId: "a", runId: "r2", status: "completed" });
    expect(updateTask(tasks, { taskId: "a", runId: "r2", status: "running" }).a.status).toBe("completed");
    expect(updateTask(tasks, { taskId: "a", runId: "r2", status: "running", started: true }).a.status).toBe("completed");
    expect(updateTask(tasks, { taskId: "a", runId: "r3", started: true, status: "running" }).a.summary).toBeUndefined();
  });
  it("重放与实时得到相同的成员，跨会话不串状态", () => {
    const events: CcEvent[] = [{ kind: "taskUpdate", task: { taskId: "a", taskType: "remote_agent", status: "running" } }, { kind: "taskUpdate", task: { taskId: "a", status: "completed" } }];
    const live = run(...events), replay = ccReducer(initialCcView, { type: "replay", events, dropped: 0, running: false });
    expect(replay.tasks).toEqual(live.tasks); expect(initialCcView.tasks).toEqual({});
  });
  it("历史存档不是实时存活证据，实时快照仍保留后台任务", () => {
    const events: CcEvent[] = [{ kind: "taskUpdate", task: { taskId: "a", taskType: "local_agent", status: "running" } }, { kind: "backgroundTasks", pending: 1 }];
    const live = ccReducer(initialCcView, { type: "replay", events, dropped: 0, running: false });
    const historical = ccReducer(initialCcView, { type: "replay", events, dropped: 0, running: false, historical: true });
    expect(live.tasks?.a.status).toBe("running"); expect(historical.tasks?.a.status).toBe("unknown");
    expect(historical.backgroundTasks).toBe(0); expect(clawdActivity(historical).busy).toBe(false);
  });
});

it("前台工具进展不被并行小队覆盖，纯文本完成不报告零项操作", () => {
  const v = run({ kind: "taskUpdate", task: { taskId: "a", taskType: "local_agent", status: "running" } }, { kind: "toolUse", toolUseId: "t", name: "Edit", input: {} });
  expect(clawdActivity({ ...v, running: true }).pose).toBe("editing");
  expect(clawdActivity({ ...initialCcView, lastOutcome: "complete" }).note).not.toContain("0");
});
