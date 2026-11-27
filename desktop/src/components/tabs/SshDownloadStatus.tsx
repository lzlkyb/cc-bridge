import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { useSshDownload } from "../../hooks/useSshDownload";
import { cleanErr } from "../../lib/utils";
import { useSshTransferJob } from "../../lib/sshTransferQueue";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";

/** Persistent result stays close to the file list, without asking users to edit full local paths. */
export function SshDownloadStatus({download, busy}: {download:ReturnType<typeof useSshDownload>;busy:boolean}) {
  const job = useSshTransferJob(download.result?.args.transferId);
  if (download.choosing) return <div role="status" className="shrink-0 border-t px-4 py-3 text-sm text-muted-foreground">正在选择保存位置…</div>;
  const result = download.result;
  if (!result) return null;
  const {args} = result;
  const status = job?.status ?? result.status;
  const error = job ? job.status === "failed" ? job.error : undefined : result.error;
  const running = status === "running" || status === "queued";
  const open = async (folder: boolean) => {
    try { if (folder) await revealItemInDir(args.local); else await openPath(args.local); }
    catch (reason) { toast(`打开失败：${cleanErr(reason)}`, "error"); }
  };
  return <div className="shrink-0 border-t bg-muted/30 px-4 py-3" aria-live="polite">
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate text-sm font-medium" title={args.name}>{({ partial:"部分完成", done:"下载完成", failed:"下载失败", cancelled:"已取消下载", running:"正在下载", queued:"排队下载" })[status]} · {args.name}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground" title={args.local}>{args.local}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {status === "done" && <><Button size="sm" className="h-9 shrink-0 whitespace-nowrap" variant="outline" onClick={() => void open(false)}>打开文件</Button><Button size="sm" className="h-9 shrink-0 whitespace-nowrap" variant="outline" onClick={() => void open(true)}>打开所在文件夹</Button></>}
        {status !== "done" && !running && (job?.retryable === false && status === "failed"
          ? <Button size="sm" className="h-9 shrink-0 whitespace-nowrap" disabled={busy || job.cancelling} onClick={() => void download.start(args.remote)}>重新下载…</Button>
          : <Button size="sm" className="h-9 shrink-0 whitespace-nowrap" disabled={busy || job?.cancelling} onClick={() => void download.retry()}>重试下载</Button>)}
        <Button size="sm" className="h-9 shrink-0 whitespace-nowrap" variant="ghost" onClick={download.clear}>关闭</Button>
      </div>
    </div>
    {error && <p role="alert" className="mt-2 break-all text-xs text-destructive-ink">{error}</p>}
  </div>;
}
