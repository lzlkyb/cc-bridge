import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { toast } from "../ui/toast";
import { compareWorkspaceTrees, localWorkspaceList, remoteWorkspaceList, scanWorkspaceTree, type WorkspaceChange } from "../../lib/fileWorkspaceTree";
import { ensureRemoteFolder, queueWorkspaceUpload } from "../../lib/fileWorkspaceActions";
import { joinRemotePath, remoteParentPath } from "../../lib/sshFilePaths";
import { invoke } from "../../lib/tauri";
import { cleanErr } from "../../lib/utils";
import { isCancelled } from "../../lib/sshErrors";

type Location = { connectionId: string; path: string; refresh: () => void };
type Plan = { local: string; remote: Location; rows: WorkspaceChange[]; selected: Set<string>; remove: boolean };
const labels = { upload: "仅在本机 · 上传", replace: "元数据不同 · 覆盖", remove: "仅在远端 · 删除" };

export function FileWorkspaceCompare({ local, remote, disabled }: { local: string; remote: Location; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [recursive, setRecursive] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"scan" | "apply" | null>(null);
  const [error, setError] = useState("");
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);

  const close = () => {
    if (busy === "apply") return;
    request.current?.abort(); setBusy(null); setPlan(null); setError(""); setOpen(false);
  };
  const scan = async () => {
    const controller = new AbortController(); request.current = controller;
    setBusy("scan"); setPlan(null); setError("");
    try {
      const [left, right] = await Promise.all([
        scanWorkspaceTree(localWorkspaceList, local, recursive, controller.signal),
        scanWorkspaceTree(remoteWorkspaceList(remote.connectionId), remote.path, recursive, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const rows = compareWorkspaceTrees(left, right);
      setPlan({ local, remote, rows, selected: new Set(rows.filter(row => row.kind === "upload").map(row => row.relative)), remove: false });
    } catch (reason) { if (!controller.signal.aborted) setError(cleanErr(reason)); }
    finally { if (request.current === controller && !controller.signal.aborted) setBusy(null); }
  };
  const apply = async () => {
    if (!plan || busy || disabled || plan.remote.connectionId !== remote.connectionId || plan.remote.path !== remote.path || plan.local !== local) return;
    const picked = plan.rows.filter(row => plan.selected.has(row.relative) && (row.kind !== "remove" || plan.remove));
    if (!picked.length) return;
    const controller = new AbortController(); request.current = controller;
    setBusy("apply"); setError("");
    let done = 0;
    try {
      for (const row of picked) {
        controller.signal.throwIfAborted();
        const target = joinRemotePath(plan.remote.path, row.relative), dir = remoteParentPath(target);
        const connectionId = plan.remote.connectionId;
        if (row.mtime == null || row.size == null || (row.previous && (row.previous.mtime == null || row.previous.size == null))) {
          throw Error(`缺少核对变更所需的文件信息：${row.relative}`);
        }
        if (row.kind === "remove") {
          await invoke("ssh_sftp_remove_compared_file", { connectionId, path: target, size: row.size, mtime: row.mtime });
        } else {
          if (row.kind === "upload" && dir !== plan.remote.path) await ensureRemoteFolder(connectionId, dir);
          await queueWorkspaceUpload(connectionId, row.path, target, row.relative, {
            source: { size: row.size, mtime: row.mtime },
            destination: row.previous?.size != null && row.previous.mtime != null ? { size: row.previous.size, mtime: row.previous.mtime } : null,
          }, controller.signal);
        }
        done++;
      }
      toast(`已应用 ${done} 项变更`, "success");
      setOpen(false);
    } catch (reason) {
      if (isCancelled(reason)) toast(`已停止应用，完成 ${done} / ${picked.length} 项`, "info");
      else setError(`已应用 ${done} / ${picked.length} 项。${cleanErr(reason)}`);
    }
    finally { plan.remote.refresh(); setPlan(null); setBusy(null); }
  };
  const stale = plan && (plan.local !== local || plan.remote.path !== remote.path || plan.remote.connectionId !== remote.connectionId);
  return <>
    <Button size="sm" className="h-7 px-2" variant="outline" disabled={disabled} onClick={() => setOpen(true)}><Icon name="arrowRight" size={13}/>比较目录</Button>
    <Dialog open={open} ariaLabel="目录比较" onClose={close}>
      <DialogHeader><DialogTitle>目录比较</DialogTitle></DialogHeader>
      <p className="break-all text-xs text-muted-foreground">本机 {plan?.local ?? local} → 远程 {plan?.remote.path ?? remote.path}</p>
      <p className="mt-2 text-xs text-muted-foreground">按相对路径、大小和修改时间比较文件，跳过符号链接。请逐项确认覆盖或删除。</p>
      <div className="mt-3 flex items-center gap-3 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={recursive} disabled={!!busy} onChange={event => { setRecursive(event.target.checked); setPlan(null); }}/>包含子目录</label>
        <Button size="sm" variant="outline" disabled={!!busy || disabled} onClick={() => void scan()}>{busy === "scan" ? "正在比较…" : "比较"}</Button></div>
      {error && <p role="alert" className="mt-2 break-all text-sm text-destructive-ink">{error}</p>}
      {stale && <p role="alert" className="mt-2 text-sm text-destructive-ink">当前目录已变化，请重新比较。</p>}
      {plan && <div className="mt-3 max-h-[40vh] overflow-y-auto">
        {!plan.rows.length && <p className="py-3 text-sm text-muted-foreground">未发现文件差异。</p>}
        {plan.rows.map(row => <label className="flex items-center gap-2 border-b border-border py-2 text-sm" key={row.relative}>
          <input type="checkbox" checked={plan.selected.has(row.relative)} disabled={!!busy || (row.kind === "remove" && !plan.remove)} onChange={event => {
            const selected = new Set(plan.selected); if (event.target.checked) selected.add(row.relative); else selected.delete(row.relative);
            setPlan({ ...plan, selected });
          }}/><span className="min-w-0 flex-1 break-all">{row.relative}</span><span className={row.kind === "remove" ? "text-xs text-destructive-ink" : "text-xs text-muted-foreground"}>{labels[row.kind]}</span>
        </label>)}
      </div>}
      {plan?.rows.some(row => row.kind === "remove") && <label className="mt-3 flex items-center gap-2 text-xs text-destructive-ink"><input type="checkbox" checked={plan.remove} disabled={!!busy} onChange={event => {
        const remove = event.target.checked;
        setPlan({ ...plan, remove, selected: remove ? plan.selected : new Set([...plan.selected].filter(path => plan.rows.find(row => row.relative === path)?.kind !== "remove")) });
      }}/>允许选择删除项</label>}
      <div className="mt-4 flex justify-end gap-2">{busy === "apply"
        ? <Button size="sm" variant="outline" onClick={() => request.current?.abort(Error("CCB_CANCELLED"))}>停止应用</Button>
        : <Button size="sm" variant="outline" onClick={close}>关闭</Button>}
        <Button size="sm" isLoading={busy === "apply"} loadingText="正在应用…" disabled={!!busy || !plan?.selected.size || !!stale || disabled} onClick={() => void apply()}>应用{plan?.selected.size ? ` ${plan.selected.size} 项` : "选中变更"}</Button></div>
    </Dialog>
  </>;
}
