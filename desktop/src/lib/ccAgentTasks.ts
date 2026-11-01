/** Mirrors cc_session::tasks::TaskUpdate; missing fields are partial updates, not resets. */
export type CcTaskUpdate = {
  taskId: string; runId?: string | null; stopToken?: string | null; parentTaskId?: string | null; toolUseId?: string | null;
  taskType?: string | null; name?: string | null; description?: string | null; status?: string | null;
  lastToolName?: string | null; summary?: string | null; background?: boolean | null; started?: boolean;
};
export type CcAgentTask = CcTaskUpdate & { status: string };
export type CcTasks = Record<string, CcAgentTask>;
export const taskActive = (task: CcAgentTask) => task.status === "running" || task.status === "pending";
export const isAgentTask = (task: CcAgentTask) => task.taskType === "local_agent" || task.taskType === "remote_agent" || (!task.taskType && !!task.name);

export function updateTask(tasks: CcTasks, update: CcTaskUpdate): CcTasks {
  const previous = tasks[update.taskId];
  // The SDK specifies chronological lexical ordering for run_id (v0.3.292+).
  // https://code.claude.com/docs/en/agent-sdk/typescript#sdktaskstartedmessage
  if (previous?.runId && update.runId && update.runId < previous.runId) return tasks;
  const fresh = !!(update.runId && update.runId !== previous?.runId);
  const fields = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null));
  const task = { ...(fresh ? { taskId: update.taskId, status: "unknown" } : previous), ...fields } as CcAgentTask;
  task.status ??= "unknown";
  // Progress or an older membership snapshot cannot resurrect a confirmed terminal run.
  if (!fresh && previous && !taskActive(previous) && previous.status !== "unknown" && taskActive(task)) task.status = previous.status;
  const next = { ...tasks, [update.taskId]: task };
  const terminal = Object.values(next).filter(t => !taskActive(t));
  for (const old of terminal.slice(0, Math.max(0, terminal.length - 100))) delete next[old.taskId];
  return next;
}

export function snapshotTasks(tasks: CcTasks, snapshot: CcTaskUpdate[]): CcTasks {
  let next = tasks;
  const live = new Set(snapshot.map(task => task.taskId));
  for (const task of Object.values(tasks)) {
    // Removal proves absence from the live set, not success. Foreground tasks are not in this set.
    if (task.background && taskActive(task) && !live.has(task.taskId)) next = updateTask(next, { taskId: task.taskId, status: "unknown" });
  }
  for (const task of snapshot) next = updateTask(next, task);
  return next;
}

export function endTasks(tasks: CcTasks, status: "stopped" | "unknown"): CcTasks {
  return Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, taskActive(task) ? { ...task, status } : task]));
}
