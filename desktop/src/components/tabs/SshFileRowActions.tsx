import { Icon, type IconName } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import type { SshFileEntry } from "../../lib/types";
import { SshFileProperties } from "./SshFileProperties";

export function SshFileRowActions({ entry, disabled, download, rename, move, remove }: {
  entry: SshFileEntry; disabled: boolean; download: () => void; rename: () => void; move: () => void; remove: () => void;
}) {
  const actions: { label: string; icon: IconName; run: () => void }[] = [
    ...(!entry.isDir ? [{ label: "下载", icon: "download" as const, run: download }] : []),
    { label: "重命名", icon: "edit", run: rename },
    { label: "移动", icon: "arrowRight", run: move },
    { label: "删除", icon: "trash", run: remove },
  ];
  return <div className="flex items-center justify-end gap-1" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <div className="file-row-actions-wide flex items-center gap-1">
      {actions.map(({ label, icon, run }) => <button key={label} type="button" disabled={disabled} onClick={run}
        className={`whitespace-nowrap rounded-md px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${icon === "trash" ? "text-destructive-ink hover:bg-destructive/10" : "text-primary hover:bg-primary/10"}`}>{label}</button>)}
    </div>
    <div className="file-row-actions-compact hidden">
      <Menu portal trigger={(open, toggle) => <button type="button" disabled={disabled} onClick={toggle} aria-label={`${entry.name} 的更多操作`} aria-haspopup="menu" aria-expanded={open} className="rounded-md p-1 text-muted-foreground hover:bg-muted"><Icon name="more" size={16}/></button>}>
        {close => actions.map(({ label, icon, run }) => <MenuItem key={label} label={label} icon={icon} onClick={() => { close(); run(); }}/>) }
      </Menu>
    </div>
    <SshFileProperties entry={entry} disabled={disabled}/>
  </div>;
}
