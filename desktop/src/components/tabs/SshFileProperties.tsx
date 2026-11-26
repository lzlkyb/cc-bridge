import { useContext, useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/icon";
import type { SshFileEntry } from "../../lib/types";
import { formatFileBytes } from "../../lib/fileWorkspaceActions";
import { joinRemotePath } from "../../lib/sshFilePaths";
import { TerminalFileWorkspace } from "./useTerminalFileWorkspace";

export function SshFileProperties({ entry, disabled }: { entry: SshFileEntry; disabled?: boolean }) {
  const location = useContext(TerminalFileWorkspace)?.location;
  const [open, setOpen] = useState(false);
  if (!location) return null;
  const rows = [
    ["路径", joinRemotePath(location.path, entry.name)],
    ["类型", entry.isSymlink ? "符号链接" : entry.isDir ? "目录" : "文件"],
    ["大小", entry.isDir ? "—" : `${formatFileBytes(entry.size)}（${entry.size.toLocaleString()} 字节）`],
    ["修改时间", entry.mtime ? new Date(entry.mtime * 1000).toLocaleString() : "—"],
    ["属主 / 属组", `${entry.uid ?? "—"} / ${entry.gid ?? "—"}`],
    ["权限", entry.mode == null ? "—" : entry.mode.toString(8).padStart(4, "0")],
    ...(entry.linkTarget ? [["链接目标", entry.linkTarget]] : []),
  ];
  return <>
    <button type="button" className="rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted" aria-label={`${entry.name} 的文件属性`} title="文件属性" disabled={disabled} onClick={event => { event.stopPropagation(); setOpen(true); }}><Icon name="info" size={14}/></button>
    {open && <Dialog open ariaLabel="文件属性" onClose={() => setOpen(false)}><div onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <DialogHeader><DialogTitle>文件属性</DialogTitle></DialogHeader>
      <dl className="text-sm">{rows.map(([label, value]) => <div key={label} className="flex gap-3 border-b border-border py-2"><dt className="w-24 shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-all">{value}</dd></div>)}</dl>
      <div className="mt-4 flex justify-end"><Button onClick={() => setOpen(false)}>关闭</Button></div>
    </div></Dialog>}
  </>;
}
