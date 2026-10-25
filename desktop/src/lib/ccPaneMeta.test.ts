// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { derivePaneMeta, paneSummary } from "./ccPaneMeta";
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

const base = { pending: [] as string[], connectionId: null, targetLabel: "本机", targetAlive: true };

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
      targetAlive: false,
    });
    expect(m.state).toBe("dead");
    expect(m.detail).toBe("1 轮 · 连接已断");
  });

  it("还没开始的新会话也带一句副标题（不留空白行）", () => {
    const m = derivePaneMeta({ ...base, view: view() });
    expect(m.state).toBe("idle");
    expect(m.detail).toBe("新会话");
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
