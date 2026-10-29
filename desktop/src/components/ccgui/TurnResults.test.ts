import { expect, it } from "vitest";
import type { CcMessage } from "../../lib/ccGuiTypes";
import { turnResults } from "./TurnResults";

it("只汇总当前轮已完成的修改和命令，保留失败记录，排除读取和执行中项目", () => {
  const tool = (id: string, name: string, status: "ok" | "error" | "running"): CcMessage => ({ kind: "tool", id, at: "", tool: { id, name, status, input: {} } });
  const user = (id: string): CcMessage => ({ kind: "user", id, text: "test", at: "" });
  const messages = [user("old"), tool("old-write", "Write", "ok"), user("new"), tool("read", "Read", "ok"), tool("edit", "Edit", "ok"), tool("failed", "Bash", "error"), tool("running", "Bash", "running"), tool("cmd", "Bash", "ok")];
  expect(turnResults(messages, messages.length - 1).map(m => m.id)).toEqual(["edit", "failed", "cmd"]);
  expect(turnResults(messages, 1).map(m => m.id)).toEqual(["old-write"]);
});
