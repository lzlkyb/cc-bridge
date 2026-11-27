import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import {
  cancelQueuedSshTransfer, repairSshTransfer, retrySshTransfer, useSshTransferQueue, type SshTransferJob,
} from "../../lib/sshTransferQueue";
import { remoteFileName, remoteParentPath } from "../../lib/sshFilePaths";
import { cleanErr } from "../../lib/utils";
import { ERR_CANCELLED } from "../../lib/sshErrors";
import { invoke } from "../../lib/tauri";
import type { SshConnectionList } from "../../lib/types";

const statusLabel = { queued: "排队中", running: "传输中", done: "已完成", partial: "部分完成", failed: "已中断", cancelled: "已取消" };
const isActive = (job: SshTransferJob) => job.status === "queued" || job.status === "running";
const needsAction = (job: SshTransferJob) => job.status === "failed" || job.status === "partial";
type RemoteTarget = { directory: string; name?: string };
type LocateRemote = (target: RemoteTarget) => void;
export const revealLocalTransfer = "cc-bridge:reveal-local-transfer";

function locate(job: SshTransferJob, onLocateRemote?: LocateRemote) {
  if (job.direction === "up") {
    onLocateRemote?.(job.targetKind === "directory" ? { directory: job.target }
      : { directory: remoteParentPath(job.target), name: remoteFileName(job.target) });
    return;
  }
  window.dispatchEvent(new CustomEvent(revealLocalTransfer, { detail: { connectionId: job.connectionId, path: job.target, directory: job.targetKind === "directory" } }));
  const result = job.targetKind === "directory" ? openPath(job.target) : revealItemInDir(job.target);
  void result.catch(error => toast(`无法打开保存位置：${cleanErr(error)}`, "error"));
}

export function SshTransferQueueButton() {
  const jobs = useSshTransferQueue();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ["sshConnections"], enabled: open, queryFn: () => invoke<SshConnectionList>("ssh_list_connections") });
  const active = jobs.filter(isActive).length;
  if (!jobs.length && !open) return null;
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-label={active ? `传输任务，${active} 项待完成` : "传输任务"}>
      <Icon name="list" size={14}/><span className="hidden sm:inline">传输任务</span>{active > 0 && active}
    </Button>
    <Dialog open={open} ariaLabel="传输任务" onClose={() => setOpen(false)}>
      <DialogHeader><DialogTitle>传输任务</DialogTitle>
        <Button size="icon" variant="ghost" aria-label="关闭传输任务" onClick={() => setOpen(false)}><Icon name="close" size={16}/></Button>
      </DialogHeader>
      <TransferList jobs={jobs} hostLabels={new Map(data?.connections?.map(conn => [conn.id, conn.name || conn.host]))}/>
    </Dialog>
  </>;
}

export function SshTransferPanel({ connectionId, onLocateRemote }: { connectionId: string; onLocateRemote: LocateRemote }) {
  const all = useSshTransferQueue();
  const jobs = all.filter(job => job.connectionId === connectionId);
  const [open, setOpen] = useState(false);
  const active = jobs.filter(isActive);
  const errors = jobs.filter(needsAction).length;
  const latest = jobs[0];
  const running = active.find(job => job.status === "running");
  const summary = active.length ? `${active.length} 项待完成 · ${running?.label ?? active[0].label}${running?.percent != null ? ` · ${running.percent}%` : ""}`
    : errors ? `${errors} 项需要处理` : latest ? `${statusLabel[latest.status]} · ${latest.label}` : "暂无传输任务";
  return <section className="file-transfer-panel flex min-h-0 shrink-0 flex-col border-t border-border bg-card" aria-label="文件传输任务">
    {open && <TransferList jobs={jobs} onLocateRemote={target => { onLocateRemote(target); setOpen(false); }}/>}
    <div className="flex min-w-0 items-center gap-2 border-t border-border/50 bg-muted/30 px-3 py-1.5 text-xs">
      <Icon name={active.length ? "activity" : errors ? "alertTriangle" : "list"} size={14} className="shrink-0 text-primary"/>
      <span role="status" title={summary} className="min-w-0 flex-1 truncate">{summary}</span>
      <Button size="sm" variant="ghost" className="h-6 shrink-0 px-1.5 text-primary" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "收起任务" : "查看任务"}<Icon name={open ? "chevronDown" : "chevronUp"} size={12}/>
      </Button>
    </div>
  </section>;
}

function TransferList({ jobs, onLocateRemote, hostLabels }: { jobs: SshTransferJob[]; onLocateRemote?: LocateRemote; hostLabels?: Map<string, string> }) {
  const [filter, setFilter] = useState<"all" | "active" | "failed">("all");
  const [repairId, setRepairId] = useState<string | null>(null);
  const visible = jobs.filter(job => filter === "all" || (filter === "failed" ? needsAction(job) : isActive(job)));
  const repair = jobs.find(job => job.id === repairId && job.status === "partial");
  const cancel = (id: string) => void cancelQueuedSshTransfer(id).catch(error => toast(`取消失败：${cleanErr(error)}`, "error"));
  return <>
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      <span className="mr-1 px-1 text-xs font-medium">传输任务</span>
      {([["all", "全部"], ["active", "进行中"], ["failed", "需处理"]] as const).map(([key, label]) =>
        <Button key={key} size="sm" className="h-7 px-2" variant={filter === key ? "secondary" : "ghost"}
          aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}{key === "failed" && jobs.some(needsAction) ? ` ${jobs.filter(needsAction).length}` : ""}</Button>)}
    </div>
    <ul className="min-h-0 max-h-[52vh] overflow-y-auto">
      {!visible.length && <li className="py-5 text-center text-xs text-muted-foreground">没有符合条件的任务</li>}
      {visible.map(job => <li key={job.id} className="flex items-start gap-2 border-b border-border px-3 py-2 text-xs">
        <Icon name={job.direction === "up" ? "upload" : "download"} size={15} className="mt-1 shrink-0 text-primary"/>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={job.label}>{job.label}</p>
          <p className="truncate text-muted-foreground" title={job.target}>{job.direction === "up" ? "远端" : "本机"} · {job.target}</p>
          {hostLabels && <p className="truncate text-muted-foreground">SSH · {hostLabels.get(job.connectionId) ?? "连接不可用"}</p>}
          {job.detail && <p className="text-muted-foreground">{job.detail}</p>}
          {job.error && needsAction(job) && <p className="break-words text-destructive-ink">{job.error}</p>}
          {job.status === "cancelled" && job.error?.includes(`${ERR_CANCELLED}:`) &&
            <p className="text-muted-foreground">{job.error.split(`${ERR_CANCELLED}:`).pop()?.trim()}</p>}
          {job.status === "running" && <progress className="h-1 w-full accent-primary" max={100} value={job.percent ?? undefined} aria-label={`${job.label} 传输进度`}/>}
        </div>
        <div className="file-transfer-job-actions flex flex-wrap items-center justify-end gap-1">
          <span className={needsAction(job) ? "text-warning-ink" : "text-muted-foreground"}>{job.cancelling ? "正在取消…" : statusLabel[job.status]}
            {job.percent != null && job.status === "running" && !job.cancelling ? ` ${job.percent}%` : ""}</span>
          {isActive(job) && <Button size="sm" variant="ghost" disabled={job.cancelling} onClick={() => cancel(job.id)}>取消</Button>}
          {job.status === "done" && (job.direction === "down" || onLocateRemote) &&
            <Button size="sm" variant="ghost" onClick={() => locate(job, onLocateRemote)}>
              {job.targetKind === "folder" || job.targetKind === "directory" ? "定位目录" : "定位文件"}</Button>}
          {job.status === "failed" && job.retryable &&
            <Button size="sm" variant="outline" disabled={job.cancelling} onClick={() => retrySshTransfer(job.id)}>
              {job.resumable && job.percent && job.percent < 100 ? `从 ${job.percent}% 续传` : "重新传输"}</Button>}
          {job.status === "failed" && <Button size="sm" variant="ghost" disabled={job.cancelling} onClick={() => cancel(job.id)}>放弃</Button>}
          {job.status === "partial" && <>
            <Button size="sm" variant="outline" disabled={job.cancelling} onClick={() => setRepairId(job.id)}>处理 {job.issues?.length} 项</Button>
            <Button size="sm" variant="ghost" disabled={job.cancelling} onClick={() => cancel(job.id)}>放弃剩余项</Button>
          </>}
        </div>
      </li>)}
    </ul>
    {repair && <TransferRepair key={repair.id} job={repair} close={() => setRepairId(null)}/>}
  </>;
}

function TransferRepair({ job, close }: { job: SshTransferJob; close: () => void }) {
  const [names, setNames] = useState<Record<string, string>>({});
  return <Dialog open ariaLabel="处理未下载的文件" onClose={close}>
    <DialogHeader><DialogTitle>处理未下载的文件</DialogTitle></DialogHeader>
    <ul className="max-h-[48vh] overflow-y-auto divide-y divide-border">
      {job.issues?.map(issue => <li className="space-y-1 py-2" key={issue.path}>
        <p className="break-all text-sm font-medium">{issue.path || job.label}</p>
        <p className="break-words text-xs text-warning-ink">{issue.reason}</p>
        {issue.rename !== undefined && <div className="flex gap-2">
          <Input aria-label={`${issue.path || job.label} 的本机名称`} value={names[issue.path] ?? issue.rename}
            onChange={event => setNames(old => ({ ...old, [issue.path]: event.target.value }))}/>
          <Button size="sm" className="shrink-0" disabled={!names[issue.path] || names[issue.path] === issue.rename} onClick={() => {
            try { repairSshTransfer(job.id, issue.path, names[issue.path]); close(); }
            catch (error) { toast(cleanErr(error), "error"); }
          }}>应用名称</Button>
        </div>}
      </li>)}
    </ul>
    <div className="mt-3 flex justify-end gap-2"><Button size="sm" variant="outline" onClick={close}>关闭</Button>
      {job.issues?.some(issue => issue.rename === undefined) && <Button size="sm" onClick={() => { retrySshTransfer(job.id); close(); }}>重试未下载项</Button>}
    </div>
  </Dialog>;
}
