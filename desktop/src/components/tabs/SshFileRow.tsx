import { Icon } from "../ui/icon";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import type { SshFileEntry } from "../../lib/types";

/** 字节数 → 人类可读（B/KB/MB/GB/TB）。 */
function formatSize(n: number): string {
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
function formatDate(s: number): string {
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
      {/* max-w 约束列宽：超长文件名截断（title 看全文），不把右侧列挤出面板 */}
      <td className="max-w-[340px] py-1.5 pl-3">
        <span className="flex min-w-0 items-center gap-2 text-left">
          <Icon
            name={entry.isDir ? "folder" : "file"}
            size={15}
            className={`shrink-0 ${entry.isDir ? "text-blue-500" : "text-muted-foreground"}`}
          />
          <span
            className={`min-w-0 truncate ${entry.isDir ? "font-medium text-foreground" : ""}`}
            title={entry.name}
          >
            {entry.name}
          </span>
          {entry.isSymlink && (
            <span className="shrink-0 text-[11px] text-muted-foreground">链接</span>
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
            className="rounded-md px-2 py-1 text-xs text-destructive-ink hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
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
 *
 * 动画（设计稿：design/微动画补全-P0P1-设计稿.html）：
 * - 根容器 `animate-fade-in`：换目录时由父组件 `key={path}` 重挂触发整列淡入；
 * - tbody 接 auto-animate FLIP：新建/删除后 list 刷新时的**增量**行增删平滑过渡。
 *   ⚠ tr 的 transform 度量在个别环境有兼容性差异（已探明风险），若真机失效
 *   退级方案 = 仅保留换目录淡入（去掉 ref 即可）。
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
  const tbodyRef = useAutoAnimateRM<HTMLTableSectionElement>();
  return (
    <div className="min-h-0 flex-1 animate-fade-in overflow-y-auto">
      {error && (
        <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink">
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
        <tbody ref={tbodyRef}>
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
