import { Icon } from "../ui/icon";
import type { SshFileEntry } from "../../lib/types";

/** 字节数 → 人类可读（B/KB/MB/GB/TB）。 */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

/** Unix 秒 → 本地化时间；0/无效返回「—」。 */
export function formatDate(s: number): string {
  if (!s) return "—";
  try {
    return new Date(s * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

interface SshFileRowProps {
  entry: SshFileEntry;
  busy: boolean;
  onOpenDir: (name: string) => void;
  onDownload: (name: string) => void;
  onRemove: (entry: SshFileEntry) => void;
}

/**
 * 远程文件表格行：名称（目录/软链整行可点进入）+ 大小 + 修改时间 + 下载/删除。
 */
export function SshFileRow({
  entry,
  busy,
  onOpenDir,
  onDownload,
  onRemove,
}: SshFileRowProps) {
  const clickable = entry.isDir || entry.isSymlink;
  return (
    <tr
      className={`border-b border-border/60 ${
        clickable ? "cursor-pointer hover:bg-muted/30" : "hover:bg-muted/20"
      }`}
      onClick={() => clickable && onOpenDir(entry.name)}
    >
      <td className="py-1.5 pl-3">
        <span className="flex items-center gap-2 text-left">
          <Icon
            name={entry.isDir ? "folder" : "file"}
            size={15}
            className={entry.isDir ? "text-blue-500" : "text-muted-foreground"}
          />
          <span className={entry.isDir ? "font-medium text-foreground" : ""}>
            {entry.name}
          </span>
          {entry.isSymlink && (
            <span className="text-[10px] text-muted-foreground">链接</span>
          )}
        </span>
      </td>
      <td className="w-28 py-1.5 text-right text-xs text-muted-foreground">
        {entry.isDir ? <span className="text-muted-foreground/50">—</span> : formatSize(entry.size)}
      </td>
      <td className="w-40 py-1.5 pr-3 text-right text-xs text-muted-foreground">
        {formatDate(entry.mtime) === "—" ? (
          <span className="text-muted-foreground/50">—</span>
        ) : (
          formatDate(entry.mtime)
        )}
      </td>
      <td className="w-44 py-1.5 pr-3">
        <div className="flex items-center justify-end gap-1">
          {!entry.isDir && (
            <button
              type="button"
              disabled={busy}
              onClick={(ev) => {
                ev.stopPropagation();
                onDownload(entry.name);
              }}
              className="rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              下载
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={(ev) => {
              ev.stopPropagation();
              onRemove(entry);
            }}
            className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            删除
          </button>
        </div>
      </td>
    </tr>
  );
}

interface FileTableProps {
  entries: SshFileEntry[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  onOpenDir: (name: string) => void;
  onDownload: (name: string) => void;
  onRemove: (entry: SshFileEntry) => void;
}

/**
 * 文件列表表格：错误条 + 空态 + 表头 + 行。
 */
export function FileTable({
  entries,
  loading,
  error,
  busy,
  onOpenDir,
  onDownload,
  onRemove,
}: FileTableProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {error && (
        <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {!error && !loading && entries.length === 0 && (
        <p className="p-4 text-center text-sm text-muted-foreground">空目录</p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
            <th className="py-1.5 pl-3 text-left font-medium">名称</th>
            <th className="w-28 py-1.5 text-right font-medium">大小</th>
            <th className="w-40 py-1.5 pr-3 text-right font-medium">修改时间</th>
            <th className="w-44 py-1.5 pr-3 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <SshFileRow
              key={e.name}
              entry={e}
              busy={busy}
              onOpenDir={onOpenDir}
              onDownload={onDownload}
              onRemove={onRemove}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
