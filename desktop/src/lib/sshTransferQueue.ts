import { useSyncExternalStore } from "react";
import { cleanErr } from "./utils";
import { invoke, listen } from "./tauri";
import { isCancelled, isTargetExists } from "./sshErrors";
import { remoteParentPath } from "./sshFilePaths";

type Status = "queued" | "running" | "done" | "partial" | "failed" | "cancelled";
export type TransferIssue = { path: string; reason: string; rename?: string };
type TaskReport = { detail?: string; issues?: TransferIssue[]; percent?: number; target?: string };
export type SshTransferJob = Omit<TaskReport, "percent" | "target"> & {
  id: string; connectionId: string; label: string; target: string; direction: "up" | "down";
  targetKind?: "directory" | "folder" | "item"; resumable?: boolean; status: Status; percent: number | null;
  error?: string; cancelling?: boolean; retryable?: boolean;
};
type Task = { job: SshTransferJob; run: (signal: AbortSignal, report: (update: TaskReport) => void) => Promise<unknown>;
  transferId?: () => string | undefined;
  scaleProgress?: (percent: number) => number;
  hasRun?: boolean;
  repair?: (path: string, name: string) => void; resolve: (result: unknown) => void;
  reject: (error: unknown) => void; cancel: AbortController; confirmConflict?: boolean };
let jobs: SshTransferJob[] = [];
const subscribers = new Set<() => void>();
const uploadCompleted = new Set<(connectionId: string, path: string) => void>();
const completed = new Set<(job: SshTransferJob) => void>();
const tasks = new Map<string, Task>();
let running = false;
let activeTask: Task | undefined;
let unlisten: (() => void) | undefined;

function put(job: SshTransferJob) {
  const current = jobs.some(item => item.id === job.id);
  jobs = current ? jobs.map(item => item.id === job.id ? job : item) : [job, ...jobs];
  // Retain active jobs and the latest completed results, even while the drawer is closed.
  const recent = new Set(jobs.filter(item => item.status === "done" || item.status === "cancelled" || (item.status === "failed" && !item.resumable)).slice(0, 80));
  jobs = jobs.filter(item => item.status === "queued" || item.status === "running" || item.status === "partial" || (item.status === "failed" && item.resumable) || recent.has(item));
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
      const task = activeTask;
      const id = task?.transferId ? task.transferId() : task?.job.id;
      if (task && id === transferId && Number.isFinite(percent)) {
        put(task.job = { ...task.job, percent: task.scaleProgress?.(percent) ?? percent });
      }
    })).catch(() => undefined);
    for (const task of tasks.values()) {
      if (task.job.status !== "queued") continue;
      activeTask = task;
      task.hasRun = true;
      put(task.job = { ...task.job, status: "running" });
      try {
        const result = await task.run(task.cancel.signal, update => put(task.job = { ...task.job, ...update }));
        const partial = !!task.job.issues?.length;
        put(task.job = { ...task.job, status: partial ? "partial" : "done", percent: partial ? task.job.percent : 100, cancelling: false });
        task.resolve(result);
        if (task.job.direction === "up") uploadCompleted.forEach(fn => fn(task.job.connectionId, task.job.target));
        completed.forEach(fn => fn(task.job));
      } catch (error) {
        const message = cleanErr(error);
        if (task.confirmConflict && isTargetExists(error)) remove(task.job.id);
        else {
          const cancelled = isCancelled(error) || message === "传输已取消";
          const retryable = !isTargetExists(error) && !/重新发起传输|重新比较/.test(message);
          put(task.job = { ...task.job, status: cancelled ? "cancelled" : "failed", error: message, cancelling: false, retryable });
        }
        task.reject(error);
      } finally { activeTask = undefined; }
    }
  } finally { running = false; }
}

export function queueSshTransfer<T>(
  details: Pick<SshTransferJob, "id" | "connectionId" | "label" | "target" | "direction" | "resumable" | "targetKind"> &
    { confirmConflict?: boolean; repair?: Task["repair"]; transferId?: Task["transferId"]; scaleProgress?: Task["scaleProgress"] },
  run: (signal: AbortSignal, report: (update: TaskReport) => void) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const previous = tasks.get(details.id)?.job;
    if (previous?.status === "running" || previous?.status === "queued" || previous?.cancelling) { reject(Error("该任务正在传输或取消")); return; }
    const { confirmConflict, repair, transferId, scaleProgress, ...fields } = details;
    const job: SshTransferJob = { ...fields, percent: details.resumable ? previous?.percent ?? null : null, status: "queued" };
    tasks.delete(job.id);
    tasks.set(job.id, { job, run, resolve: result => resolve(result as T), reject, cancel: new AbortController(), confirmConflict, repair, transferId, scaleProgress });
    put(job);
    void pump();
  });
}

export async function cancelQueuedSshTransfer(id: string) {
  const task = tasks.get(id);
  if (!task || task.job.cancelling) return;
  const transferId = task.transferId ? task.transferId() : id;
  if (task.job.status === "queued") {
    const cleanup = task.hasRun && transferId;
    put(task.job = { ...task.job, status: "cancelled", cancelling: !!cleanup });
    task.reject(Error("CCB_CANCELLED"));
    // A queued retry can still own a partial file from its previous attempt.
    if (cleanup) {
      try { await invoke("ssh_sftp_cancel", { transferId }); }
      catch (error) {
        put(task.job = { ...task.job, status: "failed", cancelling: false, error: cleanErr(error) });
        throw error;
      }
      put(task.job = { ...task.job, cancelling: false });
    }
  } else if (task.job.status === "running" || task.job.status === "failed" || task.job.status === "partial") {
    const wasRunning = task.job.status === "running";
    put(task.job = { ...task.job, cancelling: true });
    task.cancel.abort(Error("CCB_CANCELLED"));
    try {
      if (transferId) await invoke("ssh_sftp_cancel", { transferId });
      if (!wasRunning) put(task.job = { ...task.job, status: "cancelled", error: undefined, issues: undefined, cancelling: false });
    } catch (error) {
      put(task.job = { ...task.job, cancelling: false });
      throw error;
    }
  }
}

export function retrySshTransfer(id: string) {
  const task = tasks.get(id);
  if (task && !task.job.cancelling && (task.job.status === "partial" || (task.job.status === "failed" && task.job.retryable))) {
    // A retry reuses the approved target. The transfer command still validates the actual path.
    task.resolve = () => {};
    task.reject = () => {};
    // A background retry has no original caller to present a new overwrite prompt.
    task.confirmConflict = false;
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

export function repairSshTransfer(id: string, path: string, name: string) {
  const task = tasks.get(id);
  if (task?.job.status !== "partial" || !task.repair) return;
  task.repair(path, name);
  retrySshTransfer(id);
}

export function onSshUploadCompleted(connectionId: string, path: string, refresh: () => void) {
  const handle = (id: string, target: string) => { if (id === connectionId && (path === target || path === remoteParentPath(target))) refresh(); };
  uploadCompleted.add(handle);
  return () => { uploadCompleted.delete(handle); };
}

export function onSshTransferCompleted(fn: (job: SshTransferJob) => void) {
  completed.add(fn);
  return () => { completed.delete(fn); };
}

function subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; }
export function useSshTransferQueue() { return useSyncExternalStore(subscribe, () => jobs); }
export function useSshTransferJob(id?: string) { return useSyncExternalStore(subscribe, () => jobs.find(job => job.id === id)); }
