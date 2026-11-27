import { useCallback, useContext, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { dirname } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { listLocalWorkspace } from "../../lib/fileWorkspaceTree";
import { TerminalFileWorkspace } from "./useTerminalFileWorkspace";
import { onSshTransferCompleted } from "../../lib/sshTransferQueue";
import { revealLocalTransfer } from "./SshTransferQueueButton";
import { useSshTransfer } from "./useSshTransfer";
import { useWorkspaceUpload } from "./useWorkspaceUpload";
import { WorkspaceUploadDialog } from "./WorkspaceUploadDialog";
import { OverwriteConfirmDialog } from "./SshTransferBar";
import { FileWorkspaceCompare } from "./FileWorkspaceCompare";
import { formatFileBytes } from "../../lib/fileWorkspaceActions";

export function LocalFileWorkspace({ connectionId, host, disconnected }: { connectionId: string; host: string; disconnected?: boolean }) {
  const workspace = useContext(TerminalFileWorkspace);
  const [path, setPath] = useState(workspace?.localPath ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [located, setLocated] = useState("");
  const queryClient = useQueryClient();
  const xfer = useSshTransfer();
  const upload = useWorkspaceUpload(xfer);
  const setLocalLocation = workspace?.setLocalLocation;
  const navigate = useCallback((dir: string) => {
    if (dir !== path) setLocalLocation?.(null);
    setPath(dir);
    setSelected([]);
    setLocated("");
  }, [path, setLocalLocation]);
  const list = useQuery({ queryKey: ["file-workspace-local", path], queryFn: () => listLocalWorkspace(path), retry: false });
  const current = list.data?.path;
  useEffect(() => {
    setLocalLocation?.(current ? { connectionId, path: current } : null);
  }, [setLocalLocation, current, connectionId]);
  useEffect(() => onSshTransferCompleted(job => {
    if (job.direction === "down") void queryClient.invalidateQueries({ queryKey: ["file-workspace-local"] });
  }), [queryClient]);
  useEffect(() => {
    const locate = (event: Event) => {
      const job = (event as CustomEvent<{ path: string; connectionId: string; directory: boolean }>).detail;
      if (job.connectionId !== connectionId) return;
      void (job.directory ? Promise.resolve(job.path) : dirname(job.path)).then(dir => {
        navigate(dir);
        setLocated(job.path);
      }).catch(error => toast(`无法定位：${error}`, "error"));
    };
    window.addEventListener(revealLocalTransfer, locate);
    return () => window.removeEventListener(revealLocalTransfer, locate);
  }, [connectionId, navigate]);
  const location = workspace?.location;
  const canSend = !!location?.ready && !disconnected && !upload.busy && !upload.plan;
  const rows = list.data?.entries ?? [];
  const eligible = rows.filter(entry => !entry.isSymlink && selected.includes(entry.path));
  function toggle(entryPath: string) {
    setSelected(before => before.includes(entryPath) ? before.filter(p => p !== entryPath) : [...before, entryPath]);
  }
  function send(paths: string[]) {
    if (canSend && location) void upload.uploadPaths({ connectionId, path: location.path }, paths);
  }
  const pick = async () => {
    try {
      const directory = await open({ directory: true, title: "选择本机目录", defaultPath: current ?? undefined });
      if (typeof directory === "string") navigate(directory);
    } catch (error) { toast(`无法选择目录：${error}`, "error"); }
  };
  return <section className="file-workspace-local flex min-h-0 min-w-0 flex-col bg-card" aria-label="本机文件">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"><Icon name="monitor" size={13}/>本机文件</span>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => void pick()}>选择目录</Button>
        {workspace?.location && <FileWorkspaceCompare local={current ?? ""} remote={workspace.location} disabled={disconnected || !current || !workspace.location.ready}/>}</div>
    </header>
    <div className="file-path-bar"><button type="button" className="file-nav-up" disabled={!path || list.isPending} onClick={() => navigate(list.data?.parent ?? "")}>上一级</button>
      <span className="min-w-0 truncate text-xs" title={current ?? undefined}>{current ?? "本机位置"}</span></div>
    <div className="file-workspace-transfer-actions flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/25 px-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{eligible.length ? `已选 ${eligible.length} 项` : `共 ${rows.length} 项`}</span>
      <Button size="sm" className="h-7 shrink-0 px-2" variant={eligible.length ? "default" : "outline"} disabled={!canSend || !eligible.length}
        onClick={() => send(eligible.map(row => row.path))}><Icon name="upload" size={13}/>上传到远端</Button>
      {location?.path && <span className="min-w-0 truncate text-muted-foreground" title={`${host} · ${location.path}`}>至 {location.path}</span>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={list.isPending}>
      {list.isError && <p role="alert" className="p-3 text-sm text-destructive-ink">{String(list.error)} <button className="underline" onClick={() => void list.refetch()}>重试</button></p>}
      {list.isPending && <p role="status" className="p-3 text-xs text-muted-foreground">正在读取本机目录…</p>}
      {list.data?.entries.length === 0 && <p role="status" className="p-3 text-sm text-muted-foreground">{current ? "本机目录为空" : "没有可用的本机位置，请选择目录。"}</p>}
      {!!list.data?.entries.length && <Table className="table-fixed" aria-label="本机文件列表"><TableHeader><TableRow><TableHead className="w-9"><input aria-label="全选本机条目" type="checkbox" className="accent-primary"
          checked={rows.some(row => !row.isSymlink) && rows.every(row => row.isSymlink || selected.includes(row.path))}
          disabled={!current} onChange={event => setSelected(event.target.checked ? rows.filter(row => !row.isSymlink).map(row => row.path) : [])}/></TableHead><TableHead className="text-xs">名称</TableHead><TableHead className="w-24 text-right text-xs">大小</TableHead></TableRow></TableHeader>
        <TableBody>{list.data.entries.map(entry => <tr key={entry.path} aria-selected={selected.includes(entry.path)} className={selected.includes(entry.path) || located === entry.path ? "bg-primary/10" : undefined}
          ref={located === entry.path ? node => node?.scrollIntoView?.({ block: "nearest" }) : undefined}>
          <TableCell><input type="checkbox" className="accent-primary" aria-label={`选择 ${entry.name}`} checked={selected.includes(entry.path)}
            disabled={!!entry.isSymlink || !current} onChange={() => toggle(entry.path)}/></TableCell>
          <TableCell>{entry.isDir ? <button className="inline-flex max-w-full items-center gap-2 text-primary" onClick={() => navigate(entry.path)}><Icon name="folder" size={14}/><span className="truncate">{entry.name}</span></button> : <button className="flex max-w-full items-center gap-2 text-left" onClick={() => toggle(entry.path)} disabled={!!entry.isSymlink}><Icon name="file" size={14}/><span className="truncate" title={entry.name}>{entry.name}</span></button>}</TableCell>
          <TableCell className="text-right text-xs text-muted-foreground">{entry.size != null ? formatFileBytes(entry.size) : "—"}</TableCell>
        </tr>)}</TableBody></Table>}
    </div>
    <OverwriteConfirmDialog prompt={xfer.prompt} onCancel={xfer.dismissPrompt}/>
    <WorkspaceUploadDialog upload={upload}/>
  </section>;
}
