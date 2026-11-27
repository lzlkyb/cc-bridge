import { Icon, type IconName } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import type { SshFileEntry } from "../../lib/types";
import { SshFileProperties } from "./SshFileProperties";

export function SshFileRowActions({ entry, disabled, download, downloadAs, rename, move, remove }: {
  entry: SshFileEntry; disabled: boolean; download: () => void; downloadAs?: () => void;
  rename: () => void; move: () => void; remove: () => void;
}) {
  const canDownload = !entry.linkTargetIsDir && (!entry.isDir || !!downloadAs && !entry.isSymlink);
  const actions: { label: string; icon: IconName; run: () => void }[] = [
    ...(downloadAs && canDownload ? [{ label: entry.isDir ? "下载目录到…" : "另存为…", icon: "download" as const, run: downloadAs }] : []),
    { label: "重命名", icon: "edit", run: rename },
    { label: "移动", icon: "arrowRight", run: move },
    { label: "删除", icon: "trash", run: remove },
  ];
  return <div className="flex items-center justify-end gap-0.5" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    {canDownload && <button type="button" title={entry.isDir ? "下载目录" : "下载"} aria-label={entry.isDir ? "下载目录" : "下载"} disabled={disabled}
      className="grid size-6 shrink-0 place-items-center rounded text-primary hover:bg-primary/10 disabled:opacity-40" onClick={download}><Icon name="download" size={14}/></button>}
    <Menu portal trigger={(open, toggle) => <button type="button" disabled={disabled} onClick={toggle} aria-label={`${entry.name} 的更多操作`}
      aria-haspopup="menu" aria-expanded={open} className="rounded p-1 text-muted-foreground hover:bg-muted"><Icon name="more" size={14}/></button>}>
      {close => actions.map(({ label, icon, run }) => <MenuItem key={label} label={label} icon={icon} onClick={() => { close(); run(); }}/>)}
    </Menu>
    <SshFileProperties entry={entry} disabled={disabled}/>
  </div>;
}
