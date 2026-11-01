import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isAgentTask, taskActive, type CcAgentTask, type CcTasks } from "../../lib/ccAgentTasks";
import { toolPose, type ClawdPose } from "../../lib/ccClawd";
import { clawdIdentity } from "../../lib/ccClawdIdentity";
import { ClawdCharacter } from "./ClawdCharacter";
import type { TaskStopFeedback } from "../../hooks/useClawdTaskStop";

const statusLabel = (task: CcAgentTask) => ({ pending: "等待中", running: "运行中", completed: "已完成", failed: "执行失败", stopped: "已停止", killed: "已停止" }[task.status] ?? "状态未知");
function pose(task: CcAgentTask): ClawdPose {
  if (taskActive(task)) return task.lastToolName ? toolPose(task.lastToolName) : "thinking";
  return task.status === "completed" ? "complete" : task.status === "failed" ? "error" : ["stopped", "killed"].includes(task.status) ? "stopped" : "idle";
}

function MemberAvatar({ agent, stopping, identity }: { agent: CcAgentTask; stopping: boolean; identity: ReturnType<typeof clawdIdentity> }) {
  const completed = agent.status === "completed";
  const previous = useRef(completed);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    setCelebrate(completed && !previous.current);
    previous.current = completed;
    const timer = setTimeout(() => setCelebrate(false), 700);
    return () => clearTimeout(timer);
  }, [completed]);
  return <ClawdCharacter pose={stopping ? "waiting" : pose(agent)} role={identity.role} palette={identity.palette} mark={identity.mark} staticPose={!taskActive(agent) && !celebrate} />;
}

export function ClawdTeam({ tasks, onLocate, onStop, feedback = {} }: { tasks: CcTasks; onLocate: (id?: string) => void; onStop?: (task: CcAgentTask) => void; feedback?: Record<string, TaskStopFeedback> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!selected) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || selectedButton.current?.closest("[data-cc-panel]")?.classList.contains("hidden")) return;
      event.preventDefault(); setSelected(null); selectedButton.current?.focus();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected]);
  const agents = Object.values(tasks).filter(isAgentTask);
  const task = selected ? tasks[selected] : undefined;
  const animated = agents.filter(taskActive).slice(0, 2).map(agent => agent.taskId);
  return <div className="cc-clawd-team" aria-label="Agent 小队">
    <div className="cc-clawd-members">
      {agents.map((agent, index) => {
        const identity = clawdIdentity(agent);
        const stopping = !!(agent.stopToken && feedback[agent.stopToken]?.pending);
        const progress = agent.summary ?? (agent.lastToolName ? `最近工具：${agent.lastToolName}` : taskActive(agent) ? "等待新的任务进展" : statusLabel(agent));
        const hasChildren = agents.some(child => child.parentTaskId === agent.taskId && taskActive(child));
        return <section className="cc-clawd-member" key={agent.taskId} data-state={agent.status} data-motion={animated.includes(agent.taskId) ? "full" : "quiet"} style={{ "--clawd-phase": `${identity.delay}s` } as CSSProperties}>
          <button type="button" className="cc-clawd-agent" aria-expanded={selected === agent.taskId} onClick={event => { selectedButton.current = event.currentTarget; setSelected(selected === agent.taskId ? null : agent.taskId); }}>
            <MemberAvatar agent={agent} stopping={stopping} identity={identity} />
            <span className="cc-clawd-agent-copy"><strong>{agent.name ?? `成员 ${index + 1}`}<span className="cc-clawd-member-number">{String(index + 1).padStart(2, "0")}</span></strong><small>{identity.label}</small></span>
            <span className="cc-clawd-agent-status">{stopping && taskActive(agent) ? "正在停止" : statusLabel(agent)}</span>
          </button>
          {agent.description && <p className="cc-clawd-member-task" title={agent.description}>{agent.description}</p>}
          <p className="cc-clawd-member-progress" title={progress}><span aria-hidden="true" />{progress}</p>
          <div className="cc-clawd-member-actions">
            <button type="button" className="cc-clawd-toggle" aria-expanded={selected === agent.taskId} onClick={event => { selectedButton.current = event.currentTarget; setSelected(selected === agent.taskId ? null : agent.taskId); }}>进展</button>
            {taskActive(agent) && onStop && agent.stopToken && agent.background === true && agent.taskType === "local_agent" && !hasChildren && <button type="button" className="cc-clawd-stop" disabled={stopping} aria-label={`停止成员：${agent.description ?? agent.name ?? agent.taskId}`} onClick={() => onStop(agent)}>{stopping ? "停止中…" : "停止"}</button>}
          </div>
          {agent.stopToken && feedback[agent.stopToken] && <p className="cc-clawd-stop-note" role="status">{feedback[agent.stopToken].message}</p>}
        </section>;
      })}
    </div>
    {task && <div className="cc-clawd-task-detail" role="region" aria-label="Agent 任务详情">
      <div className="cc-clawd-task-heading"><strong>{task.description ?? task.name ?? "Agent 任务"}</strong><button type="button" className="cc-clawd-toggle" aria-label="关闭成员详情" onClick={() => { setSelected(null); selectedButton.current?.focus(); }}>关闭</button></div>
      {statusLabel(task)} · {task.taskId}<br />
      {task.parentTaskId && <>父任务：{tasks[task.parentTaskId]?.description ?? task.parentTaskId}<br /></>}
      {task.summary && <>{task.summary}<br /></>}
      {task.lastToolName && <>最近工具：{task.lastToolName}<br /></>}
      {taskActive(task) && (!task.stopToken || task.background !== true || task.taskType !== "local_agent") && <>当前成员类型或连接尚不支持单独停止。<br /></>}
      {taskActive(task) && agents.some(child => child.parentTaskId === task.taskId && taskActive(child)) && <>仍有子任务运行，请先处理子任务。<br /></>}
      {task.toolUseId && <button className="cc-clawd-toggle" type="button" onClick={() => onLocate(task.toolUseId ?? undefined)}>定位原始调用</button>}
    </div>}
  </div>;
}
