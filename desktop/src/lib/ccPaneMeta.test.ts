// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { conflictWith, derivePaneMeta, paneSummary, type CcPaneMeta } from "./ccPaneMeta";
import { initialCcView, type CcView } from "./ccReducer";
import type { CcMessage } from "./ccGuiTypes";

/** 造一个只关心「有哪些消息、跑没跑」的 view。 */
function view(patch: Partial<CcView> = {}): CcView {
  return { ...initialCcView, ...patch };
}

const user = (text: string): CcMessage => ({ kind: "user", id: `u${text}`, at: "", text });

const approval = (id: string, toolName: string, withQuestions = false): CcMessage => ({
  kind: "approval",
  id,
  toolName,
  input: {},
  reason: "问一句",
  expiresInSec: 60,
  ...(withQuestions
    ? { questions: [{ question: "选哪个？", multiSelect: false, options: [{ label: "A" }] }] }
    : {}),
});

const base = {
  pending: [] as string[],
  connectionId: null,
  targetLabel: "本机",
  targetAlive: true,
  cwd: null as string | null,
  restoring: false,
};

describe("derivePaneMeta 标题", () => {
  it("没有用户消息时是「新对话」", () => {
    expect(derivePaneMeta({ ...base, view: view() }).title).toBe("新对话");
  });

  it("取首条用户消息的**第一行**：贴长日志时标题才有辨识度", () => {
    const v = view({ messages: [user("先看这段日志\n然后修掉它")] });
    expect(derivePaneMeta({ ...base, view: v }).title).toBe("先看这段日志");
  });

  it("首行是空行时往下找第一行有字的", () => {
    const v = view({ messages: [user("\n\n  真正的标题  \n尾巴")] });
    expect(derivePaneMeta({ ...base, view: v }).title).toBe("真正的标题");
  });

  it("超长标题截断并加省略号（侧栏一行放不下）", () => {
    const long = "很".repeat(60);
    const v = view({ messages: [user(long)] });
    const title = derivePaneMeta({ ...base, view: v }).title;
    expect(title.length).toBe(41);
    expect(title.endsWith("…")).toBe(true);
  });

  it("手写标题压过首条消息（3-1d 改名要立刻看起来生效）", () => {
    const v = view({ messages: [user("原来的自动标题")] });
    expect(derivePaneMeta({ ...base, view: v, titleHint: "客户 A · 发票导出" }).title).toBe(
      "客户 A · 发票导出",
    );
  });

  it("手写标题是空白时不生效，仍按消息现算（避免出现一行空白标题）", () => {
    const v = view({ messages: [user("自动标题")] });
    expect(derivePaneMeta({ ...base, view: v, titleHint: "   " }).title).toBe("自动标题");
    expect(derivePaneMeta({ ...base, view: v, titleHint: null }).title).toBe("自动标题");
  });
});

describe("derivePaneMeta 五态", () => {
  it("有活跃轮次 = run，副标题带轮数", () => {
    const v = view({ messages: [user("跑起来")], running: true });
    const m = derivePaneMeta({ ...base, view: v });
    expect(m.state).toBe("run");
    expect(m.detail).toBe("1 轮 · 生成中");
    expect(m.turns).toBe(1);
  });

  it("未决的工具审批 = ask，且优先于 run（它才是卡住的原因）", () => {
    const v = view({ messages: [user("改文件"), approval("r1", "Bash")], running: true });
    const m = derivePaneMeta({ ...base, view: v, pending: ["r1"] });
    expect(m.state).toBe("ask");
    expect(m.detail).toBe("待批准 · Bash");
  });

  it("未决的提问卡 = wait（要用户选，不是批）", () => {
    const v = view({ messages: [approval("q1", "AskUserQuestion", true)] });
    const m = derivePaneMeta({ ...base, view: v, pending: ["q1"] });
    expect(m.state).toBe("wait");
    expect(m.detail).toBe("等你选 · AskUserQuestion");
  });

  it("已裁决的审批不算未决（按 pending 判，不按消息还在不在）", () => {
    const v = view({ messages: [approval("r1", "Bash")], resolved: { r1: { decision: "allow" } } });
    expect(derivePaneMeta({ ...base, view: v }).state).toBe("idle");
  });

  it("跑完且没有待批 = idle", () => {
    const v = view({ messages: [user("聊完"), approval("r1", "Bash")], resolved: { r1: { decision: "deny" } } });
    const m = derivePaneMeta({ ...base, view: v });
    expect(m.state).toBe("idle");
    expect(m.detail).toBe("1 轮 · 空闲");
  });

  it("目标连接已经不在 = dead，行要标灰", () => {
    const v = view({ messages: [user("问一句")] });
    const m = derivePaneMeta({
      view: v,
      pending: [],
      connectionId: "c1",
      targetLabel: "已删除的连接",
      restoring: false,
      targetAlive: false,
      cwd: null,
    });
    expect(m.state).toBe("dead");
    expect(m.detail).toBe("1 轮 · 连接已断");
  });

  it("还没开始的新会话也带一句副标题（不留空白行）", () => {
    const m = derivePaneMeta({ ...base, view: view() });
    expect(m.state).toBe("idle");
    expect(m.detail).toBe("新会话");
  });

  /// 进程中途挂了也是 dead，但要和「连接已断」区分开：一个是有救的（发下一句就重开），
  /// 一个要重连。文案与 hover 都必须指向正确的下一步。
  it("进程中途退出 = dead，且提示发下一句会重开", () => {
    const m = derivePaneMeta({
      ...base,
      view: view({ messages: [user("跑测试")], processExited: true }),
    });
    expect(m.state).toBe("dead");
    expect(m.detail).toBe("1 轮 · 进程已退出");
    expect(m.stateHint).toContain("--resume");
  });

  /// 连接被删时连进程都管不着了，不能让「进程已退出」抢走提示。
  it("连接已断优先于进程已退出", () => {
    const m = derivePaneMeta({
      ...base,
      view: view({ messages: [user("跑测试")], processExited: true }),
      connectionId: "c1",
      targetAlive: false,
    });
    expect(m.detail).toBe("1 轮 · 连接已断");
    expect(m.stateHint).toBeUndefined();
  });

  /// 进程没了也不该把上一轮的待批单算成「等你批准」—— 新进程里那单永远满足不了。
  it("进程已退出时不显示待批准", () => {
    const m = derivePaneMeta({
      ...base,
      view: view({ messages: [approval("a1", "Edit")], processExited: true }),
      pending: ["a1"],
    });
    expect(m.state).toBe("dead");
  });

  it("targetLabel / connectionId 原样传出（侧栏分组靠它）", () => {
    const m = derivePaneMeta({
      ...base,
      view: view(),
      connectionId: "c9",
      targetLabel: "公司机",
    });
    expect(m.connectionId).toBe("c9");
    expect(m.targetLabel).toBe("公司机");
  });

  it("sessionId 由调用方回填，纯函数一律给 null", () => {
    expect(derivePaneMeta({ ...base, view: view() }).sessionId).toBeNull();
  });

  it("cliSessionId 取 CC 的 session id（侧栏历史区靠它对账去重）", () => {
    const m = derivePaneMeta({ ...base, view: view({ sessionId: "cli-1" }) });
    expect(m.cliSessionId).toBe("cli-1");
  });

  it("cwd 取传入值并去掉首尾空白（同目录并发判定用）", () => {
    expect(derivePaneMeta({ ...base, view: view(), cwd: "  D:/proj  " }).cwd).toBe("D:/proj");
    expect(derivePaneMeta({ ...base, view: view(), cwd: null }).cwd).toBe("");
  });
});

describe("conflictWith 同目录并发", () => {
  /** 造一条侧栏元信息：给谁在跑、在哪跑。 */
  const meta = (patch: Partial<CcPaneMeta>): CcPaneMeta => ({
    sessionId: null,
    cliSessionId: null,
    rowId: null,
    title: "某条",
    turns: 1,
    state: "idle",
    detail: "",
    connectionId: "",
    targetLabel: "本机",
    cwd: "",
    restoring: false,
    ...patch,
  });

  const self = meta({ title: "我", cwd: "D:/proj", state: "idle" });

  it("同目标 + 同目录 + 对方在跑 ⇒ 报出对方标题", () => {
    expect(conflictWith(self, [meta({ title: "对面", cwd: "D:/proj", state: "run" })])).toBe("对面");
  });

  it("对方只是空闲 ⇒ 不算冲突（避免天天误报）", () => {
    expect(conflictWith(self, [meta({ title: "对面", cwd: "D:/proj", state: "idle" })])).toBeNull();
  });

  it("目录不同 ⇒ 不算冲突", () => {
    expect(conflictWith(self, [meta({ title: "对面", cwd: "D:/other", state: "run" })])).toBeNull();
  });

  it("目标不同（本机 vs 远端）⇒ 不算冲突，哪怕目录字符串一样", () => {
    expect(
      conflictWith(self, [meta({ title: "对面", cwd: "D:/proj", state: "run", connectionId: "c1" })]),
    ).toBeNull();
  });

  it("两条都没填目录 ⇒ 都落到 CLI 默认目录，同样算冲突", () => {
    const empty = meta({ title: "我", cwd: "" });
    expect(conflictWith(empty, [meta({ title: "对面", cwd: "", state: "ask" })])).toBe("对面");
  });

  it("等审批 / 等你选 也算在跑（进程卡在等人，文件仍被它占着）", () => {
    expect(conflictWith(self, [meta({ title: "A", cwd: "D:/proj", state: "wait" })])).toBe("A");
  });

  it("没有别的 pane ⇒ null", () => {
    expect(conflictWith(self, [])).toBeNull();
    expect(conflictWith(null, [meta({ state: "run" })])).toBeNull();
  });
});

describe("paneSummary", () => {
  it("只把 run / ask / wait 算作「在跑」", () => {
    const mk = (state: "run" | "ask" | "wait" | "idle" | "dead") =>
      ({ ...derivePaneMeta({ ...base, view: view() }), state }) as ReturnType<typeof derivePaneMeta>;
    expect(paneSummary([mk("run"), mk("ask"), mk("idle"), mk("dead"), mk("wait")])).toBe(
      "3 个在跑 · 共 5 个",
    );
  });
});
