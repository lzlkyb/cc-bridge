import { useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { cancelQueuedSshTransfer, retrySshTransfer, useSshTransferQueue } from "../../lib/sshTransferQueue";

const statusLabel = { queued: "排队中", running: "传输中", done: "已完成", failed: "失败", cancelled: "已取消" };

export function SshTransferQueueButton() {
  const jobs = useSshTransferQueue();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "failed">("all");
  const active = jobs.filter(job => job.status === "queued" || job.status === "running").length;
  if (!jobs.length && !open) return null;
  const visible = jobs.filter(job => filter === "all" || (filter === "failed" ? job.status === "failed" : job.status === "queued" || job.status === "running"));
  const label = active ? `传输任务，${active} 项待完成` : "传输任务";
  return <>
    <Button variant="outline" size="sm" className="max-sm:gap-1 max-sm:px-2" onClick={() => setOpen(true)} aria-label={label} title={label}>
      <Icon name="download" size={14}/><span className="hidden sm:inline">传输任务</span>{active > 0 && <span>{active}</span>}
    </Button>
    <Dialog open={open} ariaLabel="传输任务" onClose={() => setOpen(false)}>
      <DialogHeader><DialogTitle>传输任务</DialogTitle><Button size="icon" variant="ghost" aria-label="关闭传输任务" onClick={() => setOpen(false)}><Icon name="close" size={16}/></Button></DialogHeader>
      <div className="flex gap-1 border-b border-border pb-2">{([ ["all", "全部"], ["active", "进行中"], ["failed", "失败"] ] as const).map(([key, label]) =>
        <Button key={key} size="sm" variant={filter === key ? "secondary" : "ghost"} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</Button>)}</div>
      <ul className="max-h-[55vh] overflow-y-auto">
        {!visible.length && <li className="py-6 text-center text-sm text-muted-foreground">没有符合条件的任务</li>}
        {visible.map(job => <li key={job.id} className="flex items-start gap-3 border-b border-border py-3 text-sm">
          <Icon name={job.direction === "up" ? "upload" : "download"} size={15} className="mt-1 text-primary"/>
          <div className="min-w-0 flex-1"><p className="truncate font-medium" title={job.label}>{job.label}</p>
            <p className="break-all text-xs text-muted-foreground">{job.target}</p>
            <p className={job.status === "failed" ? "text-xs text-destructive-ink" : "text-xs text-muted-foreground"}>{job.cancelling ? "正在取消…" : statusLabel[job.status]}{job.percent !== null && job.status === "running" && !job.cancelling ? ` · ${job.percent}%` : ""}{job.error && job.status === "failed" ? ` · ${job.error}` : ""}</p>
            {job.status === "running" && <progress className="h-1.5 w-full accent-primary" max={100} value={job.percent ?? undefined} aria-label={`${job.label} 传输进度`}/>}
          </div>
          {job.status === "failed" && <div className="flex flex-col gap-1">{job.retryable && <Button size="sm" variant="outline" disabled={job.cancelling} onClick={() => retrySshTransfer(job.id)}>{job.resumable && job.percent ? `续传（${job.percent}%）` : "重试"}</Button>}
            <Button size="sm" variant="ghost" disabled={job.cancelling} onClick={() => void cancelQueuedSshTransfer(job.id).catch(error => toast(`无法放弃任务：${error}`, "error"))}>放弃</Button></div>}
          {(job.status === "running" || job.status === "queued") && <Button size="sm" variant="ghost" disabled={job.cancelling} onClick={() => void cancelQueuedSshTransfer(job.id).catch(error => toast(`取消失败：${error}`, "error"))}>取消</Button>}
        </li>)}
      </ul>
    </Dialog>
  </>;
}
