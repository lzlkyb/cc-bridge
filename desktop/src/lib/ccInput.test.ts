import { describe, expect, it } from "vitest";
import { ccReducer, initialCcView } from "./ccReducer";
import { endInputs, hasPendingInput, updateInput } from "./ccInput";
import type { CcEvent } from "./ccEventTypes";

describe("插话回执", () => {
  it("快回执不被晚到的本地写入回执覆盖，正文晚到也能合并", () => {
    let inputs = updateInput({}, { messageId: "a", status: "processing" });
    inputs = updateInput(inputs, { messageId: "a", text: "补充要求", mode: "steer" });
    inputs = updateInput(inputs, { messageId: "a", status: "written" });
    expect(inputs.a.status).toBe("processing");
    expect(inputs.a.text).toBe("补充要求");
    inputs = updateInput(inputs, { messageId: "a", status: "complete" });
    expect(endInputs(inputs).a.status).toBe("complete");
    expect(hasPendingInput(inputs)).toBe(false);
  });
  it("旧任务结束不会把尚未处理的新补充误判为空闲", () => {
    let view = ccReducer(initialCcView, { type: "sending" });
    view = ccReducer(view, { type: "event", event: { kind: "inputMessage", messageId: "a", text: "调整", mode: "now" } });
    const end: CcEvent = { kind: "turnEnd", sessionId: "s", isError: false, text: null, usage: null, costUsd: null, numTurns: null, durationMs: null };
    view = ccReducer(view, { type: "event", event: end });
    expect(view.running).toBe(true);
    view = ccReducer(view, { type: "event", event: { kind: "sessionState", running: false } });
    expect(view.running).toBe(true);
    view = ccReducer(view, { type: "event", event: { kind: "inputStatus", messageId: "a", status: "failed", detail: "控制请求失败" } });
    expect(view.running).toBe(false);
  });
  it("接收不等于完成；完整结果落定后才允许下一轮", () => {
    let view = ccReducer(initialCcView, { type: "sending" });
    for (const status of ["written", "received", "processing", "complete"] as const) {
      view = ccReducer(view, { type: "event", event: { kind: "inputStatus", messageId: "a", status, detail: null } });
      expect(view.running).toBe(true);
    }
    view = ccReducer(view, { type: "event", event: { kind: "turnEnd", sessionId: "s", isError: false, text: null, usage: null, costUsd: null, numTurns: null, durationMs: null } });
    expect(view.running).toBe(false);
  });
  it("退出和历史恢复把待确认回执变为未确认，实时快照仍保留等待状态", () => {
    const events: CcEvent[] = [{ kind: "inputMessage", messageId: "a", text: "别丢", mode: "steer" }, { kind: "inputStatus", messageId: "a", status: "written", detail: null }];
    const live = ccReducer(initialCcView, { type: "replay", events, running: true, dropped: 0 });
    expect(live.inputs?.a.status).toBe("written");
    const old = ccReducer(initialCcView, { type: "replay", events, running: false, historical: true, dropped: 0 });
    expect(old.inputs?.a.status).toBe("unconfirmed");
    expect(old.inputs?.a.text).toBe("别丢");
    expect(ccReducer(live, { type: "event", event: { kind: "exit", code: null } }).inputs?.a.status).toBe("unconfirmed");
  });
  it("停止与本地回执交错时不会在退出后重新进入运行中", () => {
    let view = ccReducer(initialCcView, { type: "sending" });
    view = ccReducer(view, { type: "event", event: { kind: "inputMessage", messageId: "a", text: "调整", mode: "now" } });
    view = ccReducer(view, { type: "event", event: { kind: "exit", code: null } });
    view = ccReducer(view, { type: "event", event: { kind: "inputStatus", messageId: "a", status: "written", detail: null } });
    expect(view.running).toBe(false); expect(view.inputs?.a.status).toBe("unconfirmed");
  });
  it("旧 result 先结束后，补充的完成回执仍等待自己的 TurnEnd", () => {
    let view = ccReducer(initialCcView, { type: "sending" });
    view = ccReducer(view, { type: "event", event: { kind: "inputMessage", messageId: "a", text: "调整", mode: "now" } });
    const event: CcEvent = { kind: "turnEnd", sessionId: "s", isError: false, text: null, usage: null, costUsd: null, numTurns: null, durationMs: null };
    view = ccReducer(view, { type: "event", event });
    view = ccReducer(view, { type: "event", event: { kind: "inputStatus", messageId: "a", status: "complete", detail: null } });
    expect(view.running).toBe(true);
    view = ccReducer(view, { type: "event", event });
    expect(view.running).toBe(false);
    view = ccReducer(view, { type: "event", event: { kind: "inputStatus", messageId: "a", status: "complete", detail: null } });
    expect(view.running).toBe(false);
  });
});
