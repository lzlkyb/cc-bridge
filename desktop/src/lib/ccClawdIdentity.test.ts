import { expect, it } from "vitest";
import { clawdIdentity } from "./ccClawdIdentity";

it("成员身份只依赖真实身份，工具进展不改变配色", () => {
  const task = { taskId: "agent-42", name: "Explore" };
  expect(clawdIdentity(task)).toEqual(clawdIdentity({ ...task }));
  expect(clawdIdentity(task).role).toBe("explore");
  expect(clawdIdentity({ ...task, name: "Review" }).palette).toBe(clawdIdentity(task).palette);
  expect(clawdIdentity({ taskId: "unknown", name: "自定义助手" }).role).toBe("member");
});
it("同类成员拥有稳定的差异，未明确角色不从任务描述猜身份", () => {
  const identities = Array.from({ length: 8 }, (_, index) => clawdIdentity({ taskId: `agent-${index}`, name: "Explore" }));
  expect(new Set(identities.map(identity => identity.palette)).size).toBeGreaterThan(2);
  expect(new Set(identities.map(identity => identity.delay)).size).toBeGreaterThan(2);
});
