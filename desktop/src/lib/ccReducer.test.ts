import { describe, expect, it } from "vitest";
import {
  buildAnswers,
  ccReducer,
  initialCcView,
  pendingApprovals,
  type CcView,
} from "./ccReducer";
import type { CcEvent } from "./ccEventTypes";
import { turnSpeed } from "./ccTurnStat";

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
    expect(v.resolved.r1).toEqual({ decision: "allow" });
    expect(pendingApprovals(v)).toEqual([]);
  });

  /// 规则自动放行必须带 `auto` 落进 resolved：渲染层靠它把「谁放的行」标出来，
  /// 审计回看时人工放行与规则放行不能混成一种。
  it("规则自动放行带 auto 标记，老流水按人工算", () => {
    const base = { kind: "permissionAsk", requestId: "r1", toolName: "Bash", input: {}, toolUseId: null, reason: null } as const;
    const auto = run([
      base,
      { kind: "permissionResolved", requestId: "r1", decision: "allow", auto: true },
    ]);
    expect(auto.resolved.r1).toEqual({ decision: "allow", auto: true });
    const legacy = run([base, { kind: "permissionResolved", requestId: "r1", decision: "allow" }]);
    expect(legacy.resolved.r1?.auto).toBeUndefined();
    expect(legacy.resolved.r1?.decision).toBe("allow");
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

  /// 每轮用量落进 `turns`，四类**分开记**。合并 cache read 是本轮改动前的老
  /// 做法：它每轮重报（实测一轮 89K），几轮之后总量会虚高到没法读。
  it("turnEnd 产出带四类分项与速度的轮次统计", () => {
    const v = run([
      { kind: "init", sessionId: "s1", cwd: null, model: null },
      { kind: "userMessage", text: "hi" },
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: false,
        text: null,
        usage: {
          input_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 8000,
          output_tokens: 400,
        },
        costUsd: 0.12,
        numTurns: 1,
        durationMs: 30_000,
        genMs: 10_000,
        ttftMs: 1200,
        apiMs: 9000,
      },
    ]);
    expect(v.turns).toHaveLength(1);
    const t = v.turns[0];
    expect(t).toMatchObject({
      input: 1000,
      cacheWrite: 200,
      cacheRead: 8000,
      output: 400,
      genMs: 10_000,
      durationMs: 30_000,
      ttftMs: 1200,
      apiMs: 9000,
      costUsd: 0.12,
      isError: false,
    });
    // 脚注挂在「这一轮最后一条消息」之后。
    expect(t.afterId).toBe(v.messages[v.messages.length - 1].id);
    // 速度只按生成时长算：400 tok / 10s。用墙钟（30s）会算成 13 tok/s。
    expect(turnSpeed(t.output, t.genMs)).toBe(40);
  });

  /// 零消息就结束的轮次（认证失败、只报错）也要留下账：`afterId` 是空串，
  /// `MessageList` 会把它们统一挂到流末尾。如果这里返回 `undefined` 或者干脆
  /// 不记账，这一轮的 token 与成本就彻底看不见了 —— 而那正是最该看的时候。
  it("没有任何消息的轮次也记一笔，afterId 是空串", () => {
    const v = run([
      { kind: "init", sessionId: "s1", cwd: null, model: null },
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: true,
        text: "Invalid API key",
        usage: { input_tokens: 10, output_tokens: 5 },
        costUsd: 0,
        numTurns: 1,
        durationMs: 800,
      },
    ]);
    expect(v.messages).toHaveLength(0);
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0].afterId).toBe("");
    expect(v.turns[0].output).toBe(5);
    expect(v.turns[0].isError).toBe(true);
  });

  /// CLI 给的成本是**会话累计**，所以本轮成本只能靠两次累计相减。
  it("本轮成本是累计值之差", () => {
    const end = (costUsd: number): CcEvent => ({
      kind: "turnEnd",
      sessionId: "s1",
      isError: false,
      text: null,
      usage: { output_tokens: 10 },
      costUsd,
      numTurns: 1,
      durationMs: 1000,
    });
    const v = run([end(0.1), end(0.25)]);
    expect(v.turns[0].costUsd).toBeCloseTo(0.1);
    expect(v.turns[1].costUsd).toBeCloseTo(0.15);
  });

  it("CLI 没报成本时本轮成本是 null（不显示 $0.00 误导）", () => {
    const v = run([
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: false,
        text: null,
        usage: { output_tokens: 10 },
        costUsd: null,
        numTurns: 1,
        durationMs: null,
      },
    ]);
    expect(v.turns[0].costUsd).toBeNull();
  });

  /// 老流水（2026-10-26 之前落盘的）没有 `genMs`：token 账照记，速度显示 `—`。
  it("没有 genMs 的老流水：token 照记，速度不可算", () => {
    const v = run([
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: false,
        text: null,
        usage: { output_tokens: 400 },
        costUsd: 0.1,
        numTurns: 1,
        durationMs: 20_000,
      },
    ]);
    expect(v.turns[0].output).toBe(400);
    expect(v.turns[0].genMs).toBeNull();
    expect(turnSpeed(v.turns[0].output, v.turns[0].genMs)).toBeNull();
  });

  // 🔴 这里刻意没有「progress 实时进度」的测试：那条链路已整条删除（理由见
  // `proto.rs` 里 `message_stop` 分支的注释），只保留轮次结束后的统计。

  /// 重放要能重建 `turns`：历史会话打开后同样看得到每一轮的用量。
  it("replay 从事件流重建 turns", () => {
    const events: CcEvent[] = [
      { kind: "init", sessionId: "s1", cwd: null, model: null },
      { kind: "userMessage", text: "一" },
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: false,
        text: null,
        usage: { output_tokens: 100 },
        costUsd: 0.05,
        numTurns: 1,
        durationMs: 5000,
        genMs: 4000,
      },
      { kind: "userMessage", text: "二" },
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: false,
        text: null,
        usage: { output_tokens: 200 },
        costUsd: 0.09,
        numTurns: 2,
        durationMs: 6000,
        genMs: 5000,
      },
    ];
    const v = ccReducer(initialCcView, {
      type: "replay",
      events,
      dropped: 0,
      running: false,
    });
    expect(v.turns).toHaveLength(2);
    expect(v.turns.map((t) => t.output)).toEqual([100, 200]);
    expect(v.outputTokens).toBe(300);
  });

  /// modelUsage 是上下文余量条的唯一数据源：CLI 每轮都给**累计值** ⇒ 替换式
  /// 更新（累加会翻倍，而账目错了没人一眼看得出来）。老流水落盘时没这个字段，
  /// 读回来必须保留上一次——清空会让余量条在轮次之间闪烁消失。
  it("modelUsage 替换式更新，老流水不清空", () => {
    const first = run([
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: false,
        text: null,
        usage: null,
        modelUsage: {
          "claude-opus-5": { inputTokens: 40779, outputTokens: 384, contextWindow: 1000000 },
        },
        costUsd: 0.01,
        numTurns: 1,
        durationMs: 1000,
      },
    ]);
    expect(first.modelUsage).toEqual({
      "claude-opus-5": { input: 40779, output: 384, window: 1000000 },
    });

    const legacy = run(
      [
        {
          kind: "turnEnd",
          sessionId: "s1",
          isError: false,
          text: null,
          usage: null,
          costUsd: 0.02,
          numTurns: 2,
          durationMs: 1000,
        },
      ],
      first,
    );
    expect(legacy.modelUsage).toEqual(first.modelUsage);

    const second = run(
      [
        {
          kind: "turnEnd",
          sessionId: "s1",
          isError: false,
          text: null,
          usage: null,
          modelUsage: {
            "claude-opus-5": { inputTokens: 82000, outputTokens: 900, contextWindow: 1000000 },
          },
          costUsd: 0.03,
          numTurns: 3,
          durationMs: 1000,
        },
      ],
      legacy,
    );
    expect(second.modelUsage).toEqual({
      "claude-opus-5": { input: 82000, output: 900, window: 1000000 },
    });
  });

  /// 🔴 每条路径都会 bring Exit。只等 turnEnd 的话，崩溃/被 kill 的轮次
  /// 会让界面永远停在「进行中」，composer 一直禁用。
  it("没有 result 的崩溃也靠 exit 落定", () => {
    const v = run([{ kind: "init", sessionId: "s1", cwd: null, model: null }, { kind: "exit", code: 1 }]);
    expect(v.running).toBe(false);
    expect(v.exitCode).toBe(1);
  });

  /// 进程在生成中途没了 ⇒ 置 `processExited`，界面据此说明「刚才那句为什么没反应」。
  /// 后端拿不到真实退出码（读线程只看 EOF），所以判据只能是「exit 到达时还在跑」。
  it("生成中途进程退出留标记", () => {
    const v = run([{ kind: "init", sessionId: "s1", cwd: null, model: null }, { kind: "exit", code: null }]);
    expect(v.processExited).toBe(true);
  });

  /// 一轮正常落定后进程被顺手收掉 ⇒ **不算**异常退出。
  /// 少了这条约束，每个恢复出来的历史会话都会挂一条「进程已退出」的横幅。
  it("正常落定后收进程不算异常退出", () => {
    const v = run([
      { kind: "init", sessionId: "s1", cwd: null, model: null },
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: false,
        text: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        costUsd: 0.01,
        numTurns: null,
        durationMs: null,
      },
      { kind: "exit", code: null },
    ]);
    expect(v.processExited).toBe(false);
  });

  /// 重开成功就把提示撤掉，否则横幅会一直挂着，变成「狼来了」。
  it("重开成功后清掉退出标记", () => {
    const v = run([
      { kind: "init", sessionId: "s1", cwd: null, model: null },
      { kind: "exit", code: null },
      { kind: "init", sessionId: "s1", cwd: null, model: null },
    ]);
    expect(v.processExited).toBe(false);
    expect(v.running).toBe(true);
  });

  /// 打开一条上次崩溃结束的历史会话 ≠ 刚才崩了。
  /// 重放末尾那条 Exit 若不归零，每条这种历史一打开就先挂一条「进程已退出」。
  it("重放历史不会复活退出标记", () => {
    const events: CcEvent[] = [
      { kind: "init", sessionId: "s1", cwd: null, model: null },
      { kind: "exit", code: null },
    ];
    const v = ccReducer(initialCcView, { type: "replay", events, dropped: 0, running: false });
    expect(v.processExited).toBe(false);
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

  /// CLI 退出时同一段 stderr 可能既作为事件来一次、又随 Exit 再来一次 ——
  /// 只对「相邻且完全相同」的批次去重；不同时刻合法重复的行要保留（构建工具
  /// 的重复警告很常见），全局去重会把它们吞掉。
  it("stderr 只对相邻重复批次去重", () => {
    const v = run([
      { kind: "stderr", lines: ["boom"] },
      { kind: "stderr", lines: ["boom"] },
      { kind: "stderr", lines: ["boom", "second"] },
    ]);
    expect(v.stderr).toEqual(["boom", "boom", "second"]);
  });

  /// 实测过的真缺陷：启动失败的 stderr 会跨轮永久留在顶部，红条的 × 也关不掉它
  /// （那个 × 只清前端 `error`）。修法是**两端都堵** —— 新进程起来时清空，
  /// 外加一个真正清 stderr 的 dismiss。
  it("init（新进程）清掉上一轮的 stderr", () => {
    const v = run([
      { kind: "stderr", lines: ["Failed to connect to api"] },
      { kind: "init", sessionId: "s1", cwd: null, model: "opus" },
    ]);
    expect(v.stderr).toEqual([]);
  });

  it("stderrClear 只清 stderr，不碰前端 error", () => {
    const dirty: CcView = {
      ...initialCcView,
      stderr: ["boom"],
      error: "润色失败",
    };
    const v = ccReducer(dirty, { type: "stderrClear" });
    expect(v.stderr).toEqual([]);
    expect(v.error).toBe("润色失败");
  });

  /// 不设上限的话，同一个进程跑一整天、每轮吐一行 warning，state 里会躺着几百行，
  /// 而每来一条都要重建整个视图。留 40 行够看一个完整堆栈。
  it("stderr 只保留最近 40 行", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `warn ${i}`);
    const v = run([{ kind: "stderr", lines }]);
    expect(v.stderr).toHaveLength(40);
    // 保留的是**最新**的（报错要看最近这次发生了什么）
    expect(v.stderr[v.stderr.length - 1]).toBe("warn 59");
    expect(v.stderr[0]).toBe("warn 20");
  });

  it("sending 立刻标为运行中并清掉上轮错误", () => {
    const v = ccReducer({ ...initialCcView, error: "旧错", exitCode: 1 }, { type: "sending" });
    expect(v.running).toBe(true);
    expect(v.error).toBeNull();
    expect(v.exitCode).toBeNull();
  });

  /// 错误横幅与轮次正交：运行中润色失败 / 点掉横幅都不许把 running 拍成 false
  /// —— 那会开出一个假空闲窗口，队列在窗口里发消息被后端拒收、消息即失。
  /// 乐观发送失败撤 running 走专门的 sendAborted。
  it("error 不动 running；sendAborted 才撤", () => {
    const running = ccReducer(initialCcView, { type: "sending" });
    const withErr = ccReducer(running, { type: "error", message: "润色失败" });
    expect(withErr.running).toBe(true);
    expect(withErr.error).toBe("润色失败");
    const dismissed = ccReducer(withErr, { type: "error", message: null });
    expect(dismissed.running).toBe(true);
    expect(dismissed.error).toBeNull();
    const aborted = ccReducer(withErr, { type: "sendAborted" });
    expect(aborted.running).toBe(false);
    expect(aborted.error).toBe("润色失败");
  });

  /// costUsd 与 modelUsage 同判据：CLI 的 `total_cost_usd` 是会话累计值 ⇒ 替换式。
  /// 累加会把第 2 轮显示成「第 1 轮 + 两条累计」的虚高值。
  it("costUsd 替换式更新（CLI 给的是会话累计值）", () => {
    const v = run([
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: false,
        text: null,
        usage: null,
        costUsd: 0.1,
        numTurns: 1,
        durationMs: 1000,
      },
      {
        kind: "turnEnd",
        sessionId: "s1",
        isError: false,
        text: null,
        usage: null,
        costUsd: 0.25,
        numTurns: 2,
        durationMs: 1000,
      },
    ]);
    expect(v.costUsd).toBeCloseTo(0.25);
  });

  /// 退避重试中被打断：Exit 要把「重试中」横幅一起收掉，
  /// 否则「已退出」和「正在重试」并排出现，自相矛盾。
  it("exit 清掉退避重试状态", () => {
    const v = run([
      { kind: "retry", attempt: 2, max: 10, message: "overloaded" },
      { kind: "exit", code: 1 },
    ]);
    expect(v.retry).toBeNull();
    expect(v.exitCode).toBe(1);
  });

  it("未知事件被忽略，不炸也不改状态", () => {
    const v = run([{ kind: "nope" } as unknown as CcEvent]);
    expect(v).toEqual(initialCcView);
  });

  describe("一轮落定 / 进程退出时收掉残留", () => {
    const ask = (id: string): CcEvent => ({
      kind: "permissionAsk",
      requestId: id,
      toolName: "Bash",
      input: {},
      toolUseId: null,
      reason: null,
    });
    const turnEnd: CcEvent = {
      kind: "turnEnd",
      sessionId: "s1",
      isError: false,
      text: null,
      usage: null,
      costUsd: 0.01,
      numTurns: 1,
      durationMs: 1000,
    };

    /// 点「停止」时后端只清 pending、不发 PermissionCancel：卡片不收会永远停在「待批准」。
    it("turnEnd 收掉没有裁决的审批卡，已裁决的保留", () => {
      const v = run([
        ask("r1"),
        ask("r2"),
        { kind: "permissionResolved", requestId: "r1", decision: "allow" },
        turnEnd,
      ]);
      expect(v.messages.filter((m) => m.kind === "approval").map((m) => m.id)).toEqual(["r1"]);
      expect(pendingApprovals(v)).toEqual([]);
    });

    it("exit 收掉审批卡，并把执行中的工具标成已中断", () => {
      const v = run([
        { kind: "toolUse", toolUseId: "t1", name: "Bash", input: {} },
        ask("r1"),
        { kind: "exit", code: null },
      ]);
      expect(pendingApprovals(v)).toEqual([]);
      const tool = v.messages.find((m) => m.kind === "tool");
      expect(tool).toMatchObject({ tool: { status: "error", isError: true } });
      expect(tool && tool.kind === "tool" ? tool.tool.result : "").toContain("已中断");
    });

    it("已有结果的工具卡不被改动", () => {
      const v = run([
        { kind: "toolUse", toolUseId: "t1", name: "Read", input: {} },
        { kind: "toolResult", toolUseId: "t1", content: "ok", isError: false },
        turnEnd,
      ]);
      expect(v.messages.find((m) => m.kind === "tool")).toMatchObject({
        tool: { status: "ok", result: "ok" },
      });
    });

    /// 脚注靠 `afterId` 找锚点：锚点不能是刚被收掉的审批卡。
    it("turnEnd 的脚注锚点不指向被收掉的卡", () => {
      const v = run([{ kind: "userMessage", text: "hi" }, ask("r1"), turnEnd]);
      const anchor = v.turns[v.turns.length - 1].afterId;
      expect(v.messages.some((m) => m.id === anchor)).toBe(true);
    });

    it("没有残留时 messages 引用不变", () => {
      const before = run([{ kind: "userMessage", text: "hi" }]);
      const after = ccReducer(before, { type: "event", event: turnEnd });
      expect(after.messages).toBe(before.messages);
    });
  });
});

/** 真机抓到的 `AskUserQuestion` 入参（2026-10-24 探针），字段顺序也照抄。 */
const askInput = {
  questions: [
    {
      question: "今天午饭吃什么？",
      header: "午饭",
      multiSelect: false,
      options: [
        { label: "面", description: "热汤面" },
        { label: "饭", description: "米饭" },
      ],
    },
  ],
};

describe("提问卡", () => {
  it("question 事件带出题目，工具名标记为 AskUserQuestion", () => {
    const v = run([
      { kind: "question", requestId: "q-1", toolUseId: "t-1", input: askInput },
    ]);
    expect(v.messages).toHaveLength(1);
    const card = v.messages[0];
    expect(card).toMatchObject({ kind: "approval", id: "q-1", toolName: "AskUserQuestion" });
    if (card.kind !== "approval") throw new Error("应为审批卡");
    expect(card.questions).toEqual([
      {
        question: "今天午饭吃什么？",
        header: "午饭",
        multiSelect: false,
        options: [
          { label: "面", description: "热汤面" },
          { label: "饭", description: "米饭" },
        ],
      },
    ]);
  });

  /// 重放幂等：切页回来同一张提问不能长出第二张。
  it("同一 requestId 的提问只成一张卡", () => {
    const v = run([
      { kind: "question", requestId: "q-1", toolUseId: null, input: askInput },
      { kind: "question", requestId: "q-1", toolUseId: null, input: askInput },
    ]);
    expect(v.messages).toHaveLength(1);
  });

  /// 入参来自 CLI，字段不可假设。读不出题目时卡片仍在（用户还能跳过），
  /// 但 questions 为空 —— 渲染层据此退回「只能跳过」的形态。
  it("脏入参不炸，questions 为空", () => {
    for (const bad of [{}, { questions: "nope" }, { questions: [{ question: "  " }] }]) {
      const v = run([{ kind: "question", requestId: "q-2", toolUseId: null, input: bad }]);
      const card = v.messages[0];
      if (card.kind !== "approval") throw new Error("应为审批卡");
      expect(card.questions).toEqual([]);
    }
  });

  /// 没有 options 的题保留（问题文本仍然可读），只是渲染成「没给选项」。
  it("题没有 options 时保留题目本身", () => {
    const v = run([
      { kind: "question", requestId: "q-3", toolUseId: null, input: { questions: [{ question: "继续吗" }] } },
    ]);
    const card = v.messages[0];
    if (card.kind !== "approval") throw new Error("应为审批卡");
    expect(card.questions?.[0]).toMatchObject({ question: "继续吗", options: [], multiSelect: false });
  });
});

describe("buildAnswers", () => {
  const questions = [
    { question: "今天午饭吃什么？", options: [], multiSelect: false },
    { question: "能接受哪些主食？", options: [], multiSelect: true },
  ];

  it("只保留有答案的题，多选保留多个", () => {
    expect(buildAnswers(questions, { "能接受哪些主食？": ["面", "饭"] })).toEqual({
      "能接受哪些主食？": ["面", "饭"],
    });
  });

  /// 点了又取消会留下空数组 —— 回 `[]` 会被 Rust 当成「既没答也没跳过」。
  it("空数组与空白 label 都被剔除", () => {
    expect(buildAnswers(questions, { "今天午饭吃什么？": [], "能接受哪些主食？": ["  "] })).toEqual({});
  });

  it("没有勾选时返回空对象", () => {
    expect(buildAnswers(questions, {})).toEqual({});
  });
});
