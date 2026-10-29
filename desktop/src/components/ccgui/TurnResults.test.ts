import { expect, it } from "vitest";
import type { CcMessage } from "../../lib/ccGuiTypes";
import { turnResults } from "./TurnResults";

it("只汇总当前轮已完成的修改和命令，不把失败或读取算成结果", () => {
  const tool = (id: string, name: string, status: "ok" | "error" | "running"): CcMessage => ({ kind: "tool", id, at: "", tool: { id, name, status, input: {} } });
  const user = (id: string): CcMessage => ({ kind: "user", id, text: "test", at: "" });
  const messages = [user("old"), tool("old-write", "Write", "ok"), user("new"), tool("read", "Read", "ok"), tool("edit", "Edit", "ok"), tool("failed", "Bash", "error"), tool("running", "Bash", "running"), tool("cmd", "Bash", "ok")];
  expect(turnResults(messages, messages.length - 1).map(m => m.id)).toEqual(["edit", "cmd"]);
  expect(turnResults(messages, 1).map(m => m.id)).toEqual(["old-write"]);
});
