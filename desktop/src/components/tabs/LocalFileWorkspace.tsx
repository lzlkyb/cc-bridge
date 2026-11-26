import { useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { listLocalWorkspace } from "../../lib/fileWorkspaceTree";
import { TerminalFileWorkspace } from "./useTerminalFileWorkspace";
import { FileWorkspaceCompare } from "./FileWorkspaceCompare";
import { formatFileBytes } from "../../lib/fileWorkspaceActions";

export function LocalFileWorkspace({ disconnected }: { disconnected?: boolean }) {
  const workspace = useContext(TerminalFileWorkspace);
  const [path, setPath] = useState("");
  const list = useQuery({ queryKey: ["file-workspace-local", path], queryFn: () => listLocalWorkspace(path), retry: false });
  const current = list.data?.path;
  const pick = async () => {
    try {
      const directory = await open({ directory: true, title: "选择本机目录", defaultPath: current ?? undefined });
      if (typeof directory === "string") setPath(directory);
    } catch (error) { toast(`无法选择目录：${error}`, "error"); }
  };
  return <section className="file-workspace-local flex min-h-0 min-w-0 flex-col bg-card" aria-label="本机文件">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"><Icon name="folder" size={13}/>本机文件</span>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => void pick()}>选择目录</Button>
        {workspace?.location && <FileWorkspaceCompare local={current ?? ""} remote={workspace.location} disabled={disconnected || !current || !workspace.location.ready}/>}</div>
    </header>
    <div className="file-path-bar"><button type="button" className="file-nav-up" disabled={!path || list.isPending} onClick={() => setPath(list.data?.parent ?? "")}>上一级</button>
      <span className="min-w-0 truncate text-xs" title={current ?? undefined}>{current ?? "本机位置"}</span></div>
    <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={list.isPending}>
      {list.isError && <p role="alert" className="p-3 text-sm text-destructive-ink">{String(list.error)} <button className="underline" onClick={() => void list.refetch()}>重试</button></p>}
      {list.isPending && <p role="status" className="p-3 text-xs text-muted-foreground">正在读取本机目录…</p>}
      {list.data?.entries.length === 0 && <p role="status" className="p-3 text-sm text-muted-foreground">{current ? "本机目录为空" : "没有可用的本机位置，请选择目录。"}</p>}
      {!!list.data?.entries.length && <Table className="table-fixed" aria-label="本机文件列表"><TableHeader><TableRow><TableHead className="text-xs">名称</TableHead><TableHead className="w-24 text-right text-xs">大小</TableHead></TableRow></TableHeader>
        <TableBody>{list.data.entries.map(entry => <TableRow key={entry.path}>
          <TableCell>{entry.isDir ? <button className="inline-flex max-w-full items-center gap-2 text-primary" onClick={() => setPath(entry.path)}><Icon name="folder" size={14}/><span className="truncate">{entry.name}</span></button> : <span className="flex items-center gap-2"><Icon name="file" size={14}/><span className="truncate" title={entry.name}>{entry.name}</span></span>}</TableCell>
          <TableCell className="text-right text-xs text-muted-foreground">{entry.size != null ? formatFileBytes(entry.size) : "—"}</TableCell>
        </TableRow>)}</TableBody></Table>}
    </div>
  </section>;
}
