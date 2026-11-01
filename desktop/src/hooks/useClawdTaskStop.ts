import { useRef, useState, useEffect } from "react";
import type { CcAgentTask } from "../lib/ccAgentTasks";
export type StopTask = (taskId: string, stopToken: string) => Promise<string>;
export type TaskStopFeedback = { pending: boolean; message: string };
export function useClawdTaskStop(stopTask?: StopTask) {
  const [feedback, setFeedback] = useState<Record<string, TaskStopFeedback>>({});
  const inflight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const stop = async (task: CcAgentTask) => {
    const token = task.stopToken;
    if (!token || !stopTask || inflight.current.has(token)) return;
    inflight.current.add(token);
    setFeedback(previous => ({ ...previous, [token]: { pending: true, message: "正在停止，等待确认…" } }));
    try {
      const result = await stopTask(task.taskId, token);
      if (mounted.current) setFeedback(previous => ({ ...previous, [token]: { pending: false, message: result === "completed" ? "任务已完成，无需停止" : result === "failed" ? "任务已失败，请查看详情" : "停止已确认" } }));
    } catch (error) {
      if (mounted.current) setFeedback(previous => ({ ...previous, [token]: { pending: false, message: String(error) } }));
    } finally { inflight.current.delete(token); }
  };
  return { feedback, stop };
}
