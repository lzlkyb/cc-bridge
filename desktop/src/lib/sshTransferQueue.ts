import { useSyncExternalStore } from "react";
import { cleanErr } from "./utils";
import { invoke, listen } from "./tauri";
import { isCancelled, isTargetExists } from "./sshErrors";
import { remoteParentPath } from "./sshFilePaths";

type Status = "queued" | "running" | "done" | "failed" | "cancelled";
type Job = { id: string; connectionId: string; label: string; target: string; direction: "up" | "down"; resumable?: boolean; status: Status; percent: number | null; error?: string; cancelling?: boolean; retryable?: boolean };
type Task = { job: Job; run: (signal: AbortSignal) => Promise<unknown>; resolve: (result: unknown) => void; reject: (error: unknown) => void; cancel: AbortController; confirmConflict?: boolean };
let jobs: Job[] = [];
const subscribers = new Set<() => void>();
const uploadCompleted = new Set<(connectionId: string, path: string) => void>();
const tasks = new Map<string, Task>();
let running = false;
let unlisten: (() => void) | undefined;

function put(job: Job) {
  const current = jobs.some(item => item.id === job.id);
  jobs = current ? jobs.map(item => item.id === job.id ? job : item) : [job, ...jobs];
  // Retain active jobs and the latest completed results, even while the drawer is closed.
  const recent = new Set(jobs.filter(item => item.status === "done" || item.status === "cancelled" || (item.status === "failed" && !item.resumable)).slice(0, 80));
  jobs = jobs.filter(item => item.status === "queued" || item.status === "running" || (item.status === "failed" && item.resumable) || recent.has(item));
  const visible = new Set(jobs.map(item => item.id));
  for (const id of tasks.keys()) if (!visible.has(id)) tasks.delete(id);
  subscribers.forEach(fn => fn());
}

function remove(id: string) {
  tasks.delete(id);
  jobs = jobs.filter(job => job.id !== id);
  subscribers.forEach(fn => fn());
}

async function pump() {
  if (running) return;
  running = true;
  try {
    unlisten ??= await Promise.resolve().then(() => listen<{ transferId: string; percent: number }>("ssh_transfer_progress", ({ transferId, percent }) => {
      const task = tasks.get(transferId);
      if (task?.job.status === "running") put(task.job = { ...task.job, percent });
    })).catch(() => undefined);
    for (const task of tasks.values()) {
      if (task.job.status !== "queued") continue;
      put(task.job = { ...task.job, status: "running" });
      try {
        const result = await task.run(task.cancel.signal);
        put(task.job = { ...task.job, status: "done", percent: 100, cancelling: false });
        task.resolve(result);
        if (task.job.direction === "up") uploadCompleted.forEach(fn => fn(task.job.connectionId, task.job.target));
      } catch (error) {
        const message = cleanErr(error);
        if (task.confirmConflict && isTargetExists(error)) remove(task.job.id);
        else {
          const cancelled = isCancelled(error) || message === "传输已取消";
          const retryable = !isTargetExists(error) && !/重新发起传输|重新比较/.test(message);
          put(task.job = { ...task.job, status: cancelled ? "cancelled" : "failed", error: message, cancelling: false, retryable });
        }
        task.reject(error);
      }
    }
  } finally { running = false; }
}

export function queueSshTransfer<T>(details: Pick<Job, "id" | "connectionId" | "label" | "target" | "direction" | "resumable"> & { confirmConflict?: boolean }, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const previous = tasks.get(details.id)?.job;
    if (previous?.status === "running" || previous?.status === "queued" || previous?.cancelling) { reject(Error("该任务正在传输或取消")); return; }
    const { confirmConflict, ...fields } = details;
    const job: Job = { ...fields, percent: details.resumable ? previous?.percent ?? null : null, status: "queued" };
    tasks.delete(job.id);
    tasks.set(job.id, { job, run, resolve: result => resolve(result as T), reject, cancel: new AbortController(), confirmConflict });
    put(job);
    void pump();
  });
}

export async function cancelQueuedSshTransfer(id: string) {
  const task = tasks.get(id);
  if (!task || task.job.cancelling) return;
  if (task.job.status === "queued") {
    put(task.job = { ...task.job, status: "cancelled" });
    task.reject(Error("CCB_CANCELLED"));
  } else if (task.job.status === "running" || task.job.status === "failed") {
    const wasRunning = task.job.status === "running";
    put(task.job = { ...task.job, cancelling: true });
    task.cancel.abort(Error("CCB_CANCELLED"));
    try {
      await invoke("ssh_sftp_cancel", { transferId: id });
      if (!wasRunning && task.job.status === "failed") put(task.job = { ...task.job, status: "cancelled", error: undefined, cancelling: false });
    } catch (error) {
      put(task.job = { ...task.job, cancelling: false });
      throw error;
    }
  }
}

export function retrySshTransfer(id: string) {
  const task = tasks.get(id);
  if (task?.job.status === "failed" && !task.job.cancelling && task.job.retryable) {
    // A retry reuses the approved target. The transfer command still validates the actual path.
    task.resolve = () => {};
    task.reject = () => {};
    task.cancel = new AbortController();
    put(task.job = { ...task.job, percent: task.job.resumable ? task.job.percent : null, status: "queued", error: undefined });
    if (running) {
      // If its original position was already passed, put it at the tail of the active queue.
      tasks.delete(id);
      tasks.set(id, task);
    }
    void pump();
  }
}

export function onSshUploadCompleted(connectionId: string, path: string, refresh: () => void) {
  const handle = (id: string, target: string) => { if (id === connectionId && (path === target || path === remoteParentPath(target))) refresh(); };
  uploadCompleted.add(handle);
  return () => { uploadCompleted.delete(handle); };
}

function subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; }
export function useSshTransferQueue() { return useSyncExternalStore(subscribe, () => jobs); }
export function useSshTransferJob(id?: string) { return useSyncExternalStore(subscribe, () => jobs.find(job => job.id === id)); }
