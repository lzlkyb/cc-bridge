import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { toast } from "../ui/toast";
import { cleanErr } from "../../lib/utils";
import { remoteWorkspaceList, scanWorkspaceTree, type WorkspaceEntry } from "../../lib/fileWorkspaceTree";
import { scanLocalFolder, uploadWorkspaceFolder } from "../../lib/fileWorkspaceActions";
import { copyUploadName, joinRemotePath, remoteParentPath } from "../../lib/sshFilePaths";

function loadFavorites(key: string): string[] {
  try { const paths: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string"): []; }
  catch { return []; }
}

export function SshFileWorkspaceTools({ connectionId, path, disabled, navigate, preview, refresh }: {
  connectionId: string; path: string; disabled?: boolean; navigate: (path: string) => void; preview: (path: string) => void; refresh: () => void;
}) {
  const key = `cc-bridge.file-favorites.${connectionId}`;
  const [favorites, setFavorites] = useState(() => loadFavorites(key));
  const [search, setSearch] = useState(false);
  const [folder, setFolder] = useState<{ local: string; target: string; remoteName: string } | null>(null);
  const [sending, setSending] = useState(false);
  const invalidName = !!folder && (!folder.remoteName.trim() || /^\.{1,2}$/.test(folder.remoteName.trim()) || /[\\/\0\r\n]/.test(folder.remoteName));
  const marked = favorites.includes(path);
  const toggle = () => {
    const next = marked ? favorites.filter(item => item !== path) : [path, ...favorites].slice(0, 30);
    try { localStorage.setItem(key, JSON.stringify(next)); setFavorites(next); }
    catch { toast("无法保存目录收藏", "error"); }
  };
  const pick = async () => {
    try {
      const local = await open({ directory: true, title: "选择要上传的文件夹" });
      if (typeof local === "string") {
        const name = local.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
        if (!name || name.endsWith(":")) { toast("请选择一个文件夹", "error"); return; }
        const current = await remoteWorkspaceList(connectionId)(path);
        setFolder({ local, target: path, remoteName: current.some(row => row.name === name) ? copyUploadName(name) : name });
      }
    } catch (error) { toast(`无法选择文件夹：${cleanErr(error)}`, "error"); }
  };
  const upload = async () => {
    if (!folder || sending) return;
    const name = folder.remoteName.trim();
    if (!name || name === "." || name === ".." || /[\\/\0\r\n]/.test(name)) return;
    setSending(true);
    try {
      const entries = await scanLocalFolder(folder.local);
      const task = uploadWorkspaceFolder(connectionId, joinRemotePath(folder.target, name), name, entries);
      setFolder(null);
      await task;
      toast(`已上传文件夹 ${name}`, "success");
    } catch (error) {
      const message = cleanErr(error);
      if (message.includes("临时目录未能清理") || !message.includes("CCB_CANCELLED")) toast(`文件夹上传未完成：${message}`, "error");
    }
    finally { setSending(false); refresh(); }
  };
  return <>
    <Menu portal trigger={(expanded, toggleMenu) => <Button size="sm" variant="outline" className="h-7 px-2" onClick={toggleMenu} aria-label="更多文件操作" aria-expanded={expanded} aria-haspopup="menu"><Icon name="more" size={15}/></Button>}>
      {close => <><MenuItem label="搜索子目录" icon="search" disabled={disabled} onClick={() => { close(); setSearch(true); }}/>
        <MenuItem label={marked ? "取消收藏此目录" : "收藏此目录"} icon="folder" onClick={() => { toggle(); close(); }}/>
        <MenuItem label="上传文件夹…" icon="upload" disabled={disabled || sending} onClick={() => { close(); void pick(); }}/>
        {favorites.map(item => <MenuItem key={item} label={item} icon="folder" disabled={disabled} onClick={() => { navigate(item); close(); }}/>)}</>}
    </Menu>
    {search && <WorkspaceSearch connectionId={connectionId} path={path} onClose={() => setSearch(false)} openResult={(row) => {
      setSearch(false);
      if (row.isDir) navigate(row.path);
      else { navigate(remoteParentPath(row.path)); preview(row.path); }
    }}/>}
    <Dialog open={!!folder} ariaLabel="上传文件夹" onClose={() => { if (!sending) setFolder(null); }}>
      <DialogHeader><DialogTitle>上传文件夹</DialogTitle></DialogHeader>
      <p className="break-all text-sm text-muted-foreground">{folder?.local} → {folder?.target}</p>
      <label className="mt-3 block text-sm">远程文件夹名称<Input className="mt-1" value={folder?.remoteName ?? ""} disabled={sending} aria-invalid={invalidName} aria-describedby={invalidName ? "file-workspace-folder-error" : undefined} onChange={event => folder && setFolder({ ...folder, remoteName: event.target.value })}/></label>
      {invalidName && <p id="file-workspace-folder-error" className="mt-1 text-xs text-destructive-ink">请输入有效的文件夹名称。</p>}
      <p className="mt-2 text-xs text-muted-foreground">保留子目录结构和空目录，跳过符号链接。</p>
      <div className="mt-4 flex justify-end gap-2"><Button variant="outline" disabled={sending} onClick={() => setFolder(null)}>取消</Button><Button isLoading={sending} loadingText="正在整理文件…" disabled={invalidName || disabled} onClick={() => void upload()}>加入传输</Button></div>
    </Dialog>
  </>;
}

function WorkspaceSearch({ connectionId, path, openResult, onClose }: { connectionId: string; path: string; openResult: (row: WorkspaceEntry) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ rows: WorkspaceEntry[]; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  const search = async () => {
    const value = query.trim().toLocaleLowerCase();
    if (!value || busy) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setResult(null);
    try {
      const entries = await scanWorkspaceTree(remoteWorkspaceList(connectionId), path, true, controller.signal);
      if (!controller.signal.aborted) setResult({ rows: entries.filter(row => !row.isSymlink && row.relative.toLocaleLowerCase().includes(value)), error: "" });
    } catch (error) { if (!controller.signal.aborted) setResult({ rows: [], error: cleanErr(error) }); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <Dialog open ariaLabel="搜索子目录" onClose={onClose}>
    <DialogHeader><DialogTitle>搜索子目录</DialogTitle><Button variant="ghost" size="icon" aria-label="关闭搜索" onClick={onClose}><Icon name="close" size={16}/></Button></DialogHeader>
    <p className="mb-2 break-all text-xs text-muted-foreground">搜索范围 {path}</p>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void search(); }}><Input aria-label="搜索文件名或路径" autoFocus disabled={busy} value={query} onChange={event => { setQuery(event.target.value); setResult(null); }}/><Button disabled={!query.trim()} isLoading={busy}>搜索</Button></form>
    {result?.error && <p role="alert" className="mt-3 text-sm text-destructive-ink">{result.error}</p>}
    {result && !result.error && <div className="mt-3 max-h-[45vh] overflow-y-auto">{result.rows.length ? result.rows.map(row => <button key={row.path} type="button" className="flex w-full items-center gap-2 border-b border-border px-1 py-2 text-left text-sm hover:bg-muted" onClick={() => openResult(row)}><Icon name={row.isDir ? "folder" : "file"} size={14}/><span className="break-all">{row.relative}</span></button>) : <p className="px-1 py-2 text-sm text-muted-foreground">没有匹配的文件或目录</p>}</div>}
    <div className="mt-4 flex justify-end"><Button variant="outline" onClick={onClose}>{busy ? "停止搜索" : "关闭"}</Button></div>
  </Dialog>;
}
