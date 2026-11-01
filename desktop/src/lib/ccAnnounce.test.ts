import { describe, expect, it } from "vitest";
import { initialCcView, type CcView } from "./ccReducer";
import {
  PHASE_MIN_GAP_MS,
  initialAnnounceState,
  nextAnnouncement,
  turnToolCount,
} from "./ccAnnounce";
import type { CcMessage, CcToolCall } from "./ccGuiTypes";

const view = (patch: Partial<CcView>): CcView => ({ ...initialCcView, ...patch });

const toolMsg = (
  id: string,
  name: string,
  input: Record<string, unknown> = {},
  extra: Partial<CcToolCall> = {},
): CcMessage => ({
  kind: "tool",
  id,
  at: "",
  tool: { id, name, input, status: "running", ...extra },
});

const userMsg = (text: string): CcMessage => ({ kind: "user", id: `u:${text}`, text, at: "" });

describe("ccAnnounce", () => {
  it("轮次开始只播一次，重复计算不再出声", () => {
    let st = initialAnnounceState(false);
    const running = view({ running: true, messages: [userMsg("改一下")] });

    const first = nextAnnouncement(st, running, 0, 1000);
    expect(first.say).toMatchObject({ text: "Claude 开始回复", level: "polite" });
    st = first.state;

    const again = nextAnnouncement(st, running, 0, 1000);
    expect(again.say).toBeNull();
  });

  it("挂载时已经在跑的会话不补「开始回复」", () => {
    const st = initialAnnounceState(true);
    const { say } = nextAnnouncement(st, view({ running: true, messages: [] }), 0, 0);
    expect(say).toBeNull();
  });

  it("轮次结束带上本轮的调用数", () => {
    let st = initialAnnounceState(true);
    const running = view({
      running: true,
      messages: [userMsg("跑测试"), toolMsg("t1", "Bash", { command: "npm test" })],
    });
    st = nextAnnouncement(st, running, 0, 0).state;

    const done = nextAnnouncement(st, { ...running, running: false }, 0, 5000);
    expect(done.say).toMatchObject({ text: "回复完成，本轮 1 个工具调用" });
  });

  it("阶段播报用「动作 + 目标」，不念工具英文名", () => {
    const st = { ...initialAnnounceState(true), at: 0 };
    const v = view({
      running: true,
      messages: [userMsg("改"), toolMsg("t1", "Edit", { file_path: "src/a.ts" })],
    });
    const { say } = nextAnnouncement(st, v, 0, 5000);
    expect(say).toMatchObject({ text: "正在修改 src/a.ts", level: "polite" });
  });

  it("阶段播报有最小间隔：连着两个工具只念第一个", () => {
    let st = { ...initialAnnounceState(true), at: 0 };
    const v1 = view({ running: true, messages: [toolMsg("t1", "Edit", { file_path: "a.ts" })] });
    const first = nextAnnouncement(st, v1, 0, 5000);
    st = first.state;
    expect(first.say?.text).toBe("正在修改 a.ts");

    const v2 = view({
      running: true,
      messages: [toolMsg("t1", "Edit", { file_path: "a.ts" }), toolMsg("t2", "Write", { file_path: "b.ts" })],
    });
    const second = nextAnnouncement(st, v2, 0, 5000 + PHASE_MIN_GAP_MS - 1);
    expect(second.say).toBeNull();
  });

  it("工具失败用 assertive，且同一工具只念一次", () => {
    const v = view({
      running: true,
      messages: [toolMsg("t1", "Bash", { command: "npm test" }, { status: "error", isError: true })],
    });
    const first = nextAnnouncement(initialAnnounceState(true), v, 0, 100);
    expect(first.say).toMatchObject({ text: "Bash 执行失败", level: "assertive" });

    const again = nextAnnouncement(first.state, v, 0, 200);
    expect(again.say).toBeNull();
  });

  it("用户按停（canceled）不播成失败", () => {
    const v = view({
      running: true,
      messages: [toolMsg("t1", "Bash", {}, { status: "error", isError: true, canceled: true })],
    });
    const { say } = nextAnnouncement(initialAnnounceState(true), v, 0, 100);
    expect(say).toBeNull();
  });

  it("待批准只在数量增加时播，且说清要确认什么", () => {
    const ask: CcMessage = {
      kind: "approval",
      id: "r1",
      toolName: "Bash",
      input: { command: "rm -rf dist" },
      reason: "",
      expiresInSec: 60,
    };
    const v = view({ running: true, messages: [ask] });
    const first = nextAnnouncement(initialAnnounceState(true), v, 1, 100);
    expect(first.say).toMatchObject({ text: "需要你确认：Bash rm -rf dist", level: "polite" });

    // 数量没变（同一张卡还在）⇒ 不重复播。
    const again = nextAnnouncement(first.state, v, 1, 200);
    expect(again.say).toBeNull();
  });

  it("空闲时回看历史不出声", () => {
    const v = view({
      messages: [toolMsg("t1", "Edit", { file_path: "a.ts" }, { status: "ok" })],
    });
    const { say } = nextAnnouncement(initialAnnounceState(false), v, 0, 100);
    expect(say).toBeNull();
  });

  it("turnToolCount 只数最后一条用户消息之后的调用", () => {
    const v = view({
      messages: [
        userMsg("第一轮"),
        toolMsg("t1", "Edit", {}, { status: "ok" }),
        userMsg("第二轮"),
        toolMsg("t2", "Edit", {}, { status: "ok" }),
        toolMsg("t3", "Bash", {}, { status: "ok" }),
      ],
    });
    expect(turnToolCount(v)).toBe(2);
  });
});
