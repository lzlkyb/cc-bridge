import { describe, expect, it } from "vitest";
import { ccReducer, initialCcView, pendingApprovals, type CcView } from "./ccReducer";
import type { CcEvent } from "./ccEventTypes";

const run = (events: CcEvent[], from: CcView = initialCcView): CcView =>
  events.reduce((v, e) => ccReducer(v, { type: "event", event: e }), from);

describe("ccReducer", () => {
  it("initial 是空白且不在运行", () => {
    expect(initialCcView.messages).toEqual([]);
    expect(initialCcView.running).toBe(false);
    expect(initialCcView.costUsd).toBe(0);
  });

  /// 流式碎片增量追加，最终全文覆盖 —— 两者共用 blockId，所以不会重复两遍。
  it("流式增量追加，最终消息覆盖", () => {
    const v = run([
      { kind: "text", blockId: "m:0", text: "你", streaming: true },
      { kind: "text", blockId: "m:0", text: "好", streaming: true },
      { kind: "text", blockId: "m:0", text: "你好世界", streaming: false },
    ]);
    const texts = v.messages.filter((m) => m.kind === "assistant");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "你好世界" });
  });

  /// 用户消息 id 必须由「已有几条」推导：取时间戳的话，重放会生成另一串 id，
  /// React 会把所有气泡当成新节点重建（滚动位置与动画全丢）。
  it("用户消息 id 稳定且可重放", () => {
    const once = run([{ kind: "userMessage", text: "a" }, { kind: "userMessage", text: "b" }]);
    const twice = ccReducer(initialCcView, {
      type: "replay",
      events: [{ kind: "userMessage", text: "a" }, { kind: "userMessage", text: "b" }],
      dropped: 0,
      running: false,
    });
    expect(once.messages.map((m) => m.id)).toEqual(["user:0", "user:1"]);
    expect(twice.messages.map((m) => m.id)).toEqual(once.messages.map((m) => m.id));
  });

  it("工具调用与结果合成一条卡", () => {
    const v = run([
      { kind: "toolUse", toolUseId: "t1", name: "Read", input: { file_path: "/a.ts" } },
      { kind: "toolResult", toolUseId: "t1", content: "1 行", isError: false },
    ]);
    const tool = v.messages.find((m) => m.kind === "tool");
    expect(tool).toMatchObject({ tool: { name: "Read", status: "ok", result: "1 行" } });
    expect(v.messages).toHaveLength(1);
  });

  it("工具失败标红（is_error 而不是靠文本猜）", () => {
    const v = run([
      { kind: "toolUse", toolUseId: "t1", name: "Bash", input: {} },
      { kind: "toolResult", toolUseId: "t1", content: "boom", isError: true },
    ]);
    expect(v.messages.find((m) => m.kind === "tool")).toMatchObject({ tool: { status: "error" } });
  });

  it("审批卡去重：重放同一事件不会长出第二张", () => {
    const ask: CcEvent = {
      kind: "permissionAsk",
      requestId: "r1",
      toolName: "Bash",
      input: { command: "rm x" },
      toolUseId: "t1",
      reason: "要删文件",
    };
    const v = run([ask, ask]);
    expect(v.messages.filter((m) => m.kind === "approval")).toHaveLength(1);
    expect(pendingApprovals(v)).toEqual(["r1"]);
  });

  it("裁决后不再算待批", () => {
    const v = run([
      { kind: "permissionAsk", requestId: "r1", toolName: "Bash", input: {}, toolUseId: null, reason: null },
      { kind: "permissionResolved", requestId: "r1", decision: "allow" },
    ]);
    expect(v.resolved.r1).toBe("allow");
    expect(pendingApprovals(v)).toEqual([]);
  });

  /// CLI 超时撤回时卡片必须消失：留着转圈的卡会让用户反复点一个死按钮。
  it("撤回后卡片移除", () => {
    const v = run([
      { kind: "permissionAsk", requestId: "r1", toolName: "Bash", input: {}, toolUseId: null, reason: null },
      { kind: "permissionCancel", requestId: "r1" },
    ]);
    expect(v.messages).toHaveLength(0);
  });

  it("turnEnd 累加 token 与花费并落定 running", () => {
    const v = run([
      { kind: "init", sessionId: "s1", cwd: "/p", model: "sonnet" },
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: false,
        text: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
        costUsd: 0.03,
        numTurns: 1,
        durationMs: 1000,
      },
    ]);
    expect(v.running).toBe(false);
    expect(v.inputTokens).toBe(105);
    expect(v.outputTokens).toBe(20);
    expect(v.costUsd).toBeCloseTo(0.03);
  });

  /// 🔴 每条路径都会 bring Exit。只等 turnEnd 的话，崩溃/被 kill 的轮次
  /// 会让界面永远停在「进行中」，composer 一直禁用。
  it("没有 result 的崩溃也靠 exit 落定", () => {
    const v = run([{ kind: "init", sessionId: "s1", cwd: null, model: null }, { kind: "exit", code: 1 }]);
    expect(v.running).toBe(false);
    expect(v.exitCode).toBe(1);
  });

  /// 重放必须从空状态拼，不能往现有状态上叠：否则 token / cost 会翻倍。
  it("重放不会把账目算两遍", () => {
    const events: CcEvent[] = [
      {
        kind: "turnEnd",
        sessionId: "s",
        isError: false,
        text: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        costUsd: 0.01,
        numTurns: null,
        durationMs: null,
      },
    ];
    const first = run(events);
    const replayed = ccReducer(first, { type: "replay", events, dropped: 0, running: false });
    expect(replayed.costUsd).toBeCloseTo(0.01);
    expect(replayed.inputTokens).toBe(10);
    expect(replayed.messages).toEqual(first.messages);
  });

  it("retry 是进度不是错误", () => {
    const v = run([{ kind: "retry", attempt: 2, max: 10, message: "overloaded" }]);
    expect(v.retry).toMatchObject({ attempt: 2, max: 10 });
    expect(v.error).toBeNull();
    expect(v.stderr).toEqual([]);
  });

  it("stderr 去重，同一行不重复出现", () => {
    const v = run([
      { kind: "stderr", lines: ["boom"] },
      { kind: "stderr", lines: ["boom", "second"] },
    ]);
    expect(v.stderr).toEqual(["boom", "second"]);
  });

  it("sending 立刻标为运行中并清掉上轮错误", () => {
    const v = ccReducer({ ...initialCcView, error: "旧错", exitCode: 1 }, { type: "sending" });
    expect(v.running).toBe(true);
    expect(v.error).toBeNull();
    expect(v.exitCode).toBeNull();
  });

  it("reset 回到初始态", () => {
    const dirty = run([{ kind: "userMessage", text: "x" }, { kind: "exit", code: 0 }]);
    expect(ccReducer(dirty, { type: "reset" })).toEqual(initialCcView);
  });

  it("未知事件被忽略，不炸也不改状态", () => {
    const v = run([{ kind: "nope" } as unknown as CcEvent]);
    expect(v).toEqual(initialCcView);
  });
});
