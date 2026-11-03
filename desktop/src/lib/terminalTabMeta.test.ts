import { describe, it, expect } from "vitest";
import {
  EMPTY_TAB_META,
  clearTabMetaUnread,
  mergeTabMeta,
  nextTabInRing,
  tabAttentionSummary,
  sanitizeTitle,
  type TermTabMeta,
} from "./terminalTabMeta";
import type { ProgramStatus } from "./terminalProgramStatus";

describe("sanitizeTitle（OSC 0/2 标题净化）", () => {
  it("正常标题原样保留", () => {
    expect(sanitizeTitle("claude")).toBe("claude");
    expect(sanitizeTitle("user@host: ~/code")).toBe("user@host: ~/code");
  });
  it("剥掉 ANSI 转义序列（OSC 子序列整段删除）", () => {
    // 标题里夹带 OSC 转义试图改写终端其它部分
    expect(sanitizeTitle("vi\x1b]0;evil\x07m")).toBe("vim");
    expect(sanitizeTitle("\x1b]2;fake\x1b\\claude")).toBe("claude");
  });
  it("剥掉 C0/C1 控制字符", () => {
    expect(sanitizeTitle("a\x07b\x1bc\r\nd")).toBe("abcd");
  });
  it("空白/空标题回退 null（标签显示主机名）", () => {
    expect(sanitizeTitle("")).toBe(null);
    expect(sanitizeTitle("   \t ")).toBe(null);
    expect(sanitizeTitle("\x1b]0;\x07")).toBe(null);
  });
  it("超长截断到 24 字符 + 省略号", () => {
    const long = "a".repeat(30);
    expect(sanitizeTitle(long)).toBe(`${"a".repeat(24)}…`);
  });
});

const st = (state: ProgramStatus["state"], extra: Partial<ProgramStatus> = {}): ProgramStatus =>
  ({ state, kind: null, app: "claude-code", title: null, msg: null, progress: null, ...extra });

describe("mergeTabMeta：按值去重（返回原对象 = 没变化）", () => {
  it("标量相同 + 对象同值 ⇒ 返回原引用，不触发重渲染", () => {
    const cur: TermTabMeta = { ...EMPTY_TAB_META, title: "构建", agent: st("working", { progress: 40 }) };
    const next = mergeTabMeta(cur, { title: "构建", agent: { ...st("working", { progress: 40 }) } });
    expect(next).toBe(cur);
  });

  it("progress 按 state/value 比：addon 每次 onChange 都造新对象", () => {
    const cur: TermTabMeta = { ...EMPTY_TAB_META, progress: { state: 1, value: 40 } };
    expect(mergeTabMeta(cur, { progress: { state: 1, value: 40 } })).toBe(cur);
    expect(mergeTabMeta(cur, { progress: { state: 1, value: 41 } })).not.toBe(cur);
  });

  it("msg 变化要更新：它就是 tooltip 里「它在问什么」那句", () => {
    const cur: TermTabMeta = { ...EMPTY_TAB_META, agent: st("blocked", { kind: "permission", msg: "允许 rm 吗？" }) };
    const next = mergeTabMeta(cur, { agent: st("blocked", { kind: "permission", msg: "允许 push 吗？" }) });
    expect(next.agent?.msg).toBe("允许 push 吗？");
  });

  it("🔴 只在 agent 真变化且是新一条 attention 状态时标未读", () => {
    const working: TermTabMeta = { ...EMPTY_TAB_META, agent: st("working") };
    // working 不置未读
    expect(mergeTabMeta(working, { agent: st("working", { progress: 10 }) }).agentUnread).toBe(false);
    // 转成 done ⇒ 置位
    expect(mergeTabMeta(working, { agent: st("done") }).agentUnread).toBe(true);
    // 同一条 done 重发 ⇒ 不动（否则用户刚清掉的未读又被点亮）
    const done: TermTabMeta = { ...EMPTY_TAB_META, agent: st("done"), agentUnread: false };
    expect(mergeTabMeta(done, { agent: { ...st("done") } }).agentUnread).toBe(false);
  });

  it("显式传 agentUnread 时以调用方为准（切标签清零走这条，不能被推导覆盖）", () => {
    const cur: TermTabMeta = { ...EMPTY_TAB_META, agent: st("working") };
    const next = mergeTabMeta(cur, { agent: st("done"), agentUnread: false });
    expect(next.agentUnread).toBe(false);
  });
});

describe("clearTabMetaUnread：切标签清未读", () => {
  const base = (unread: boolean): TermTabMeta => ({ ...EMPTY_TAB_META, agent: st("done"), agentUnread: unread });

  it("把给定会话都清成已读", () => {
    const meta = { a: base(true), b: base(true) };
    const next = clearTabMetaUnread(meta, ["a", "b"]);
    expect(next.a.agentUnread).toBe(false);
    expect(next.b.agentUnread).toBe(false);
    // 状态本体不能被动到：已读只影响画法
    expect(next.a.agent?.state).toBe("done");
  });

  it("没东西可清就返回原对象（不制造新引用）", () => {
    const meta = { a: base(false) };
    expect(clearTabMetaUnread(meta, ["a", "不存在"])).toBe(meta);
  });

  it("不存在的 key 不新增条目", () => {
    const meta = { a: base(true) };
    const next = clearTabMetaUnread(meta, ["a", "ghost"]);
    expect(Object.keys(next)).toEqual(["a"]);
  });
});

describe("tabAttentionSummary / nextTabInRing：汇总两档（G5 + 断线）", () => {
  const tabs = [
    { sessionId: "a", closed: false },
    { sessionId: "b", closed: false },
    { sessionId: "c", closed: true },
    { sessionId: "d", closed: false },
  ];
  const unread = (agent: ProgramStatus | null): TermTabMeta => ({
    ...EMPTY_TAB_META,
    agent,
    agentUnread: true,
  });
  const summary = (meta: Record<string, TermTabMeta>) => tabAttentionSummary(tabs, meta);

  it("待处理只数未读的标签，按标签顺序", () => {
    const meta = {
      a: unread(st("done")),
      b: EMPTY_TAB_META,
      c: unread(st("blocked")),
      d: unread(st("error")),
    };
    expect(summary(meta).attention).toEqual(["a", "d"]);
  });

  it("🔴 断线单独成一档：它不是「没有待办」，是「等你重连或关掉」", () => {
    expect(summary({}).disconnected).toEqual(["c"]);
  });

  it("🔴 断线标签残留未读也不进待处理：同一个标签不能被数两次", () => {
    const s = summary({ c: unread(st("blocked")) });
    expect(s.attention).not.toContain("c");
    expect(s.disconnected).toEqual(["c"]);
  });

  it("🔴 状态回到 idle 就不算：否则药丸数的是一个标签上根本看不见的徽标", () => {
    const meta = { a: unread(st("idle")), b: unread(st("working")), d: unread(st("done")) };
    // working 不置未读（真实流程到不了这），即便到了也不该计入——转圈不是「待处理」
    expect(summary(meta).attention).toEqual(["d"]);
  });

  it("没有未读 / 没有 meta 时两档各自为空", () => {
    const empty = summary({});
    expect(empty.attention).toEqual([]);
    expect(empty.disconnected).toEqual(["c"]);
    expect(tabAttentionSummary([], { a: unread(st("done")) })).toEqual({
      attention: [],
      disconnected: [],
    });
  });

  it("nextTabInRing：从当前之后循环；当前不在列表里就从头开始", () => {
    expect(nextTabInRing(["a", "d"], null)).toBe("a");
    expect(nextTabInRing(["a", "d"], "a")).toBe("d");
    expect(nextTabInRing(["a", "d"], "d")).toBe("a"); // 末尾回到开头
    expect(nextTabInRing(["a", "d"], "zzz")).toBe("a");
    expect(nextTabInRing([], "a")).toBeNull();
  });
});
