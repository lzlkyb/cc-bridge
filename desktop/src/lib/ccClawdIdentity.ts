import type { CcAgentTask } from "./ccAgentTasks";

export type ClawdRole = "lead" | "explore" | "build" | "review" | "verify" | "member";

/** Identity is stable across tool changes and run progress; tool pose remains independent. */
export function clawdIdentity(task: Pick<CcAgentTask, "taskId" | "name">) {
  const name = task.name?.toLowerCase() ?? "";
  const role: ClawdRole = /^(explore|plan|researcher)$/.test(name) ? "explore"
    : /^(implement|implementation|coder|build)$/.test(name) ? "build"
    : /^(review|reviewer|code-reviewer)$/.test(name) ? "review"
    : /^(verify|verifier|test|tester)$/.test(name) ? "verify" : "member";
  let hash = 2166136261;
  for (const character of task.taskId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return { role, palette: hash % 6, delay: -(hash % 5000) / 1000, mark: hash % 3,
    label: { lead: "主搭档", explore: "探索成员", build: "实现成员", review: "审查成员", verify: "验证成员", member: "小队成员" }[role] };
}
