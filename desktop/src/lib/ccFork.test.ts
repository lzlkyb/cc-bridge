import { describe, expect, it } from "vitest";
import {
  buildForkDigest,
  buildForkPrompt,
  makeForkSeed,
  paneForkSeed,
  orderForks,
  FORK_DIGEST_MAX,
} from "./ccFork";
import type { CcMessage } from "./ccGuiTypes";

const user = (text: string): CcMessage => ({ kind: "user", id: `u${text}`, text, at: "" });
const assistant = (text: string): CcMessage => ({
  kind: "assistant",
  id: `a${text}`,
  text,
  at: "",
});
const tool = (name: string): CcMessage => ({
  kind: "tool",
  id: `t${name}`,
  at: "",
  tool: { id: `t${name}`, name, input: {}, status: "ok" },
});

describe("buildForkDigest", () => {
  it("只要截断点之前的用户/助手正文，工具与思考不进摘要", () => {
    const msgs = [
      user("第一句"),
      assistant("答一"),
      tool("Bash"),
      assistant("答二"),
      user("第二句"),
      assistant("不该出现"),
    ];
    const { digest, omitted } = buildForkDigest(msgs, 4);
    expect(digest).toContain("【用户】第一句");
    expect(digest).toContain("【助手】答二");
    expect(digest).not.toContain("Bash");
    expect(digest).not.toContain("不该出现"); // 截断点之后的一律丢弃
    expect(omitted).toBe(0);
  });

  it("从第一条消息处分叉 ⇒ 没有前缀", () => {
    const { digest, omitted } = buildForkDigest([user("只有这一句")], 0);
    expect(digest).toBe("");
    expect(omitted).toBe(0);
  });

  it("超长时从**头部**丢，并如实报丢了几条", () => {
    const many: CcMessage[] = [];
    for (let i = 0; i < 40; i += 1) {
      many.push(user(`第${i}条`));
      many.push(assistant("x".repeat(700)));
    }
    many.push(user("要重跑的这句"));
    const { digest, omitted } = buildForkDigest(many, many.length - 1);
    expect(digest.length).toBeLessThanOrEqual(FORK_DIGEST_MAX);
    expect(omitted).toBeGreaterThan(0);
    // 留下的是「离这条最近的」，不是开场。
    expect(digest).not.toContain("第0条");
  });

  it("单条巨长的消息被压到 800 字以内（否则一条就能吃掉整个摘要）", () => {
    const { digest } = buildForkDigest([user("字".repeat(5000)), user("这句")], 1);
    // 800 字 + 省略号 + 4 个字的「【用户】」前缀。
    expect(digest.length).toBeLessThanOrEqual(805);
    expect(digest.endsWith("…")).toBe(true);
  });
});

describe("buildForkPrompt", () => {
  it("有前缀时说明「看不到工具调用」，并明确这是新会话", () => {
    const out = buildForkPrompt({ digest: "【用户】旧话", omitted: 0, text: "新说法" });
    expect(out).toContain("新的会话");
    expect(out).toContain("看不到当时的工具调用");
    expect(out).toContain("【用户】旧话");
    expect(out.trimEnd().endsWith("新说法")).toBe(true);
  });

  it("有省略时把条数说清楚", () => {
    const out = buildForkPrompt({ digest: "【用户】旧话", omitted: 7, text: "新说法" });
    expect(out).toContain("更早的 7 条已省略");
  });

  it("没有前缀时原样发，不硬塞「以下是之前的对话」", () => {
    expect(buildForkPrompt({ digest: "", omitted: 0, text: "  你好  " })).toBe("你好");
  });
});

describe("paneForkSeed", () => {
  const msgs = [user("第一句"), assistant("答一"), user("第二句")];

  it("把 pane 的字段摆到种子上：sessionId→来源、title→标题，其余原样带过去", () => {
    const seed = paneForkSeed(
      {
        messages: msgs,
        sessionId: "sess-42",
        title: "改 readme",
        connectionId: "conn-1",
        cwd: "/repo",
        model: "opus",
        permissionMode: "acceptEdits",
      },
      2,
      "换个说法",
    );
    expect(seed).toEqual(
      makeForkSeed({
        messages: msgs,
        index: 2,
        text: "换个说法",
        sourceSessionId: "sess-42",
        sourceTitle: "改 readme",
        connectionId: "conn-1",
        cwd: "/repo",
        model: "opus",
        permissionMode: "acceptEdits",
      }),
    );
    // 摘要只到截断点之前：这条自己不进摘要，也不带后面没有的东西。
    expect(seed.digest).toContain("第一句");
    expect(seed.digest).not.toContain("第二句");
  });

  it("还没起过进程（sessionId 为空）时不编造来源 id", () => {
    const seed = paneForkSeed(
      {
        messages: msgs,
        sessionId: null,
        title: "",
        connectionId: "",
        cwd: "",
        model: "",
        permissionMode: "default",
      },
      0,
      "  ",
    );
    expect(seed.sourceSessionId).toBeNull();
    expect(seed.text).toBe("");
  });
});

describe("orderForks", () => {
  it("分叉紧跟在来源后面，其余保持原序", () => {
    const rows = [
      { key: "a" },
      { key: "b" },
      { key: "a1", forkOf: "a" },
      { key: "c" },
    ];
    expect(orderForks(rows).map((r) => r.key)).toEqual(["a", "a1", "b", "c"]);
  });

  it("多级分叉按树序展开，不丢行", () => {
    const rows = [
      { key: "x1", forkOf: "x" },
      { key: "x" },
      { key: "x2", forkOf: "x1" },
      { key: "y" },
    ];
    const out = orderForks(rows).map((r) => r.key);
    expect(out).toEqual(["x", "x1", "x2", "y"]);
    expect(out).toHaveLength(rows.length);
  });

  it("来源已经不在列表里时保持原位（不让这一行消失）", () => {
    const rows = [{ key: "z", forkOf: "gone" }, { key: "w" }];
    expect(orderForks(rows).map((r) => r.key)).toEqual(["z", "w"]);
  });
});
