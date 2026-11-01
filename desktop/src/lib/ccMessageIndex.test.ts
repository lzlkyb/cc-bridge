import { describe, expect, it } from "vitest";
import { buildMessageIndex } from "./ccMessageIndex";
import type { CcMessage } from "./ccGuiTypes";

const user = (id: string): CcMessage => ({ kind: "user", id, text: id, at: "" });
const assistant = (id: string): CcMessage => ({ kind: "assistant", id, text: id, at: "" });
const tool = (id: string, status: "ok" | "running" | "error" = "ok"): CcMessage => ({
  kind: "tool",
  id,
  at: "",
  tool: { id, name: "Edit", input: { file_path: "a.ts" }, status },
});

const idx = (messages: CcMessage[], start = 0) =>
  buildMessageIndex({ messages, start, turns: [], stops: [] });

describe("buildMessageIndex", () => {
  it("下标是全量的：窗口切掉前面的消息不影响最后一条的定位", () => {
    const messages = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
    const full = idx(messages);
    const windowed = idx(messages, 2);
    expect(full.lastUserIdx).toBe(2);
    expect(windowed.lastUserIdx).toBe(2);
    expect(full.lastAssistantIdx).toBe(3);
    expect(windowed.lastAssistantIdx).toBe(3);
  });

  it("连续的成功工具调用并成一组，组头记全量下标", () => {
    const messages = [user("u1"), tool("t1"), tool("t2"), assistant("a1")];
    const { groups, grouped } = idx(messages, 2);
    // 窗口从下标 2 开始（t2）：t1 在窗口外，t2 自己成一组。
    expect([...groups.keys()]).toEqual([2]);
    expect(groups.get(2)?.map((m) => m.id)).toEqual(["t2"]);
    expect(grouped.size).toBe(0);
  });

  it("分组不会跨过窗口边界把消息吞掉：被收走的下标一定在 groups 的某个组里", () => {
    const messages = [user("u1"), tool("t1"), tool("t2"), tool("t3"), assistant("a1")];
    for (const start of [0, 1, 2, 3, 4]) {
      const { groups, grouped } = idx(messages, start);
      for (const g of grouped) {
        const covered = [...groups.values()].some((members) => members.some((m) => messages.indexOf(m) === g));
        expect(covered).toBe(true);
      }
    }
  });

  it("运行中的工具不并组（它要自己转圈）", () => {
    const messages = [user("u1"), tool("t1", "running")];
    const { groups } = idx(messages);
    expect(groups.size).toBe(0);
  });

  it("停止点进集合，带停止点的工具不并组", () => {
    const messages = [user("u1"), tool("t1")];
    const withStop = buildMessageIndex({ messages, start: 0, turns: [], stops: ["t1"] });
    expect(withStop.stopSet.has("t1")).toBe(true);
    expect(withStop.groups.size).toBe(0);
  });

  it("TodoWrite 不并组：它有自己的进度卡", () => {
    const messages: CcMessage[] = [
      user("u1"),
      { kind: "tool", id: "todo1", at: "", tool: { id: "todo1", name: "TodoWrite", input: {}, status: "ok" } },
    ];
    const { groups, lastTodoIdx } = idx(messages);
    expect(groups.size).toBe(0);
    expect(lastTodoIdx).toBe(1);
  });
});
