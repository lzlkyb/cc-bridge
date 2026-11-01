import type { CcView } from "./ccReducer";
import { isAgentTask, taskActive } from "./ccAgentTasks";
import { inputPending } from "./ccInput";

export type ClawdPose = "idle" | "waiting" | "thinking" | "reading" | "searching" | "editing" | "executing" | "approval" | "question" | "retrying" | "complete" | "error" | "stopped";
export type ClawdActivity = { pose: ClawdPose; label: string; note: string; targetId?: string; busy: boolean };
export type ClawdOptions = { sending?: boolean; stopState?: "stopping" | "unconfirmed" | null };

export function toolPose(name: string): ClawdPose {
  const tool = name.split("__").pop() ?? name;
  if (["Read", "NotebookRead"].includes(tool)) return "reading";
  if (["Grep", "Glob", "WebSearch", "WebFetch"].includes(tool)) return "searching";
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)) return "editing";
  if (["Bash", "BashOutput"].includes(tool)) return "executing";
  return "thinking";
}

export function clawdActivity(view: CcView, options: ClawdOptions = {}): ClawdActivity {
  const activity = (pose: ClawdPose, label: string, note = "", targetId?: string, busy = false) => ({ pose, label, note, targetId, busy });
  if (options.stopState === "stopping") return activity("waiting", "正在停止本轮", "已发送停止请求，等待确认", undefined, true);
  if (options.stopState === "unconfirmed") return activity("error", "停止尚未确认", "请检查执行记录，当前不能判断进程是否结束");
  const lastUser = view.messages.map(m => m.kind).lastIndexOf("user");
  const turn = view.messages.slice(view.activityStartIndex ?? Math.max(0, lastUser));
  const approval = [...view.messages].reverse().find(m => m.kind === "approval" && !view.resolved[m.id]);
  if (approval?.kind === "approval") return activity(approval.toolName === "AskUserQuestion" ? "question" : "approval", approval.toolName === "AskUserQuestion" ? "有一个问题需要你决定" : "需要你批准下一步", approval.toolName, approval.id, true);
  if (view.retry && view.running) return activity("retrying", `正在重试 ${view.retry.attempt}/${view.retry.max}`, view.retry.message, undefined, true);
  const agents = Object.values(view.tasks ?? {}).filter(isAgentTask).filter(taskActive);
  if (agents.length && !view.running) return activity("thinking", "小队正在协作", `${agents.length} 个 Agent 运行中 · 本轮回复已结束`, undefined, true);
  if (!view.running && !options.sending) {
    if (view.backgroundTasks > 0) return activity("waiting", "后台任务仍在运行", `${view.backgroundTasks} 个后台任务 · 等待真实任务进展`, undefined, true);
    if (view.lastOutcome === "stopped") return activity("stopped", "本轮已停止", "已完成的文件修改仍然保留");
    if (view.lastOutcome === "error" || view.processExited) return activity("error", "本轮未能完成", view.stderr[view.stderr.length - 1] ?? view.errors[view.errors.length - 1] ?? "查看执行记录了解原因");
    if (view.lastOutcome === "complete") return activity("complete", "本轮已完成", "可以继续提问或查看本轮记录");
    return activity("idle", "准备好了", "告诉 Clawd 你想解决什么");
  }
  if (options.sending && !turn.some(m => m.kind === "user")) return activity("waiting", "正在发送消息", "收到新进展后会更新状态", undefined, true);
  const inputs = Object.values(view.inputs ?? {}).filter(input => inputPending(input.status));
  const input = inputs[inputs.length - 1];
  if (input?.mode === "now" && input.status === "preparing") return activity("waiting", "正在调整执行方向", "等待 CLI 确认，不会重启会话", undefined, true);
  const tool = [...turn].reverse().find(m => m.kind === "tool" && m.tool.status === "running");
  if (tool?.kind === "tool") {
    const pose = toolPose(tool.tool.name);
    const labels: Partial<Record<ClawdPose, string>> = { reading: "正在读取文件", searching: "正在搜索", editing: "正在编辑文件", executing: "正在执行命令" };
    const input = tool.tool.input;
    const target = [input.file_path, input.path, input.command, input.pattern, input.description].find(v => typeof v === "string") as string | undefined;
    return activity(pose, labels[pose] ?? `正在使用 ${tool.tool.name}`, `${target ?? tool.tool.name}${inputs.length ? ` · ${inputs.length} 条补充等待处理` : ""}`, tool.id, true);
  }
  if (agents.length) return activity("thinking", "小队正在协作", `${agents.length} 个 Agent 运行中 · 主搭档负责协调`, undefined, true);
  if (input) return activity(input.status === "processing" ? "thinking" : "waiting", input.status === "processing" ? "正在处理你的补充" : input.status === "received" ? "CLI 已接收补充" : "补充已发送，等待读取", "以接收与本轮结果回执为准", undefined, true);
  const last = turn[turn.length - 1];
  if (last?.kind === "thinking") return activity("thinking", "正在分析", "正在梳理当前任务", last.id, true);
  if (last?.kind === "assistant") return activity("thinking", "正在回复", "根据当前进展整理回复", last.id, true);
  return activity("waiting", "等待响应", "尚未收到新的执行进展", undefined, true);
}
