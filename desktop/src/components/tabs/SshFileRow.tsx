import { useEffect, useRef } from "react";
import { Icon } from "../ui/icon";
import { EmptyState } from "../ui/EmptyState";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import type { SshFileEntry } from "../../lib/types";
import type { SortKey, SortState } from "../../lib/sshFileSort";
import { SortableTh } from "./SortableTh";

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
  highlighted?: boolean;
  /** 多选选中态（行底色 + aria-selected）。 */
  selected?: boolean;
  entry: SshFileEntry;
  busy: boolean;
  onOpenDir: (name: string) => void;
  onDownload: (name: string) => void;
  onRemove: (entry: SshFileEntry) => void;
  /** 重命名（只改名称，后端保证不换目录）。 */
  onRename: (entry: SshFileEntry) => void;
  /** 移动到别的目录（单条；批量走 FileBatchBar）。 */
  onMove: (entry: SshFileEntry) => void;
  /** 带修饰键的点击：多选/区间选择。返回 true = 已按选择处理。 */
  onSelect?: (name: string, e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => boolean;
  /** 双击普通文件：打开内联编辑器（读不出来时前端给「用本机编辑器打开」的出路）。 */
  onActivateFile?: (name: string) => void;
}

/**
 * 远程文件表格行：名称（目录/软链到目录整行可点进入）+ 大小 + 修改时间 + 下载/重命名/移动/删除。
 */
export function SshFileRow({
  highlighted,
  selected,
  entry,
  busy,
  onOpenDir,
  onDownload,
  onRemove,
  onRename,
  onMove,
  onSelect,
  onActivateFile,
}: SshFileRowProps) {
  // 软链到目录也算「可进入」：readdir 本身跟随软链，点进去就是目标目录的内容。
  // 软链到文件则按普通文件走（单击选中、双击进编辑器）——保存时后端已解析到
  // 真实路径再 rename，编辑软链文件改的是它的目标，不会再悄悄替换掉链接本身。
  const effectiveIsDir = entry.isDir || (entry.isSymlink && !!entry.linkTargetIsDir);
  const clickable = effectiveIsDir;
  const row = useRef<HTMLTableRowElement>(null);
  useEffect(() => { if (highlighted) row.current?.scrollIntoView({block:"nearest"}); }, [highlighted]);
  // 单键点击保持原语义（可进入的进、文件不做事），修饰键点击才进多选——
  // 否则「点一下文件想选中」和「点一下目录想进入」会互相打架。
  const onRowClick = (e: React.MouseEvent) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      onSelect?.(entry.name, e);
      return;
    }
    if (clickable) {
      if (!busy) onOpenDir(entry.name);
      return;
    }
    onSelect?.(entry.name, e);
  };
  return (
    <tr
      ref={row} aria-selected={selected || highlighted || undefined}
      className={`border-b border-border/60 ${
        clickable && !busy ? "cursor-pointer hover:bg-muted/30" : "hover:bg-muted/20"
      } ${selected ? "bg-primary/10" : ""} ${highlighted && !selected ? "bg-accent" : ""}`}
      onClick={onRowClick}
      onDoubleClick={() => {
        if (effectiveIsDir || busy) return;
        onActivateFile?.(entry.name);
      }}
      title={effectiveIsDir ? undefined : "双击编辑"}
    >
      {/* max-w 约束列宽：超长文件名截断（title 看全文），不把右侧列挤出面板 */}
      <td className="max-w-[340px] py-1.5 pl-3">
        <span className="flex min-w-0 items-center gap-2 text-left">
          <Icon
            name={effectiveIsDir ? "folder" : "file"}
            size={15}
            className={`shrink-0 ${effectiveIsDir ? "text-blue-500" : "text-muted-foreground"}`}
          />
          {clickable ? <button type="button" disabled={busy} title={entry.name} aria-label={`打开文件夹 ${entry.name}`}
            className="min-w-0 truncate rounded text-left font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            onClick={event => { event.stopPropagation(); onOpenDir(entry.name); }}>{entry.name}</button>
            : <span className="min-w-0 truncate" title={entry.name}>{entry.name}</span>}
          {entry.isSymlink && (entry.linkTarget ? (
            <span
              className="shrink-0 max-w-[160px] truncate text-[11px] text-muted-foreground"
              title={`${entry.name} → ${entry.linkTarget}`}
            >
              → {entry.linkTarget}
            </span>
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground">链接</span>
          ))}
        </span>
      </td>
      <td className="w-28 py-1.5 text-right text-xs text-muted-foreground">
        {effectiveIsDir ? <span className="text-muted-foreground/50">—</span> : formatSize(entry.size)}
      </td>
      <td className="w-40 py-1.5 pr-3 text-right text-xs text-muted-foreground">
        {formatDate(entry.mtime) === "—" ? (
          <span className="text-muted-foreground/50">—</span>
        ) : (
          formatDate(entry.mtime)
        )}
      </td>
      <td className="w-52 py-1.5 pr-3">
        <div className="flex items-center justify-end gap-1">
          {!entry.isDir && (
            <button
              type="button"
              disabled={busy}
              onClick={(ev) => {
                ev.stopPropagation();
                onDownload(entry.name);
              }}
              className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              下载
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={(ev) => {
              ev.stopPropagation();
              onRename(entry);
            }}
            className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            重命名
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={(ev) => {
              ev.stopPropagation();
              onMove(entry);
            }}
            className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            移动
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={(ev) => {
              ev.stopPropagation();
              onRemove(entry);
            }}
            className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-destructive-ink hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            删除
          </button>
        </div>
      </td>
    </tr>
  );
}

interface FileTableProps {
  highlightName?: string;
  entries: SshFileEntry[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  /** 已多选的文件名集合（行底色 + aria-selected）。 */
  selectedNames?: string[];
  onOpenDir: (name: string) => void;
  onDownload: (name: string) => void;
  onRemove: (entry: SshFileEntry) => void;
  onRename: (entry: SshFileEntry) => void;
  onMove: (entry: SshFileEntry) => void;
  onRetry?: () => void;
  /** 带修饰键的点击 → 多选。 */
  onSelect?: (name: string, e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => boolean;
  /** 双击普通文件 → 打开内联编辑器。 */
  onActivateFile?: (name: string) => void;
  /** 当前排序态（表头高亮激活列 + ▲/▼）。 */
  sort: SortState;
  /** 表头点击 → 轮换排序（见 lib/sshFileSort 的 nextSortState）。 */
  onToggleSort: (key: SortKey) => void;
  /**
   * 过滤无命中（与「目录为空」区分）：同样是 0 行，给的是过滤相关提示，
   * 不是「拖文件进来」的引导——后者在只是没匹配上时会误导用户。
   */
  filterActive?: boolean;
}

/**
 * 文件列表表格：错误条 + 空态 + 表头（可点击排序）+ 行。
 *
 * 动画（设计稿：design/微动画补全-P0P1-设计稿.html）：
 * - 根容器 `animate-fade-in`：换目录时由父组件 `key={path}` 重挂触发整列淡入；
 * - tbody 接 auto-animate FLIP：新建/删除后 list 刷新时的**增量**行增删平滑过渡。
 *   ⚠ tr 的 transform 度量在个别环境有兼容性差异（已探明风险），若真机失效
 *   退级方案 = 仅保留换目录淡入（去掉 ref 即可）。
 */
export function FileTable({
  highlightName,
  entries,
  loading,
  error,
  busy,
  selectedNames,
  onOpenDir,
  onDownload,
  onRemove,
  onRename,
  onMove,
  onRetry,
  onSelect,
  onActivateFile,
  sort,
  onToggleSort,
  filterActive,
}: FileTableProps) {
  const tbodyRef = useAutoAnimateRM<HTMLTableSectionElement>();
  return (
    <div aria-busy={loading || undefined} className="min-h-0 flex-1 animate-fade-in overflow-y-auto">
      {error && (
        <div role="alert" className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink">
          {error}
          {onRetry && <button type="button" onClick={onRetry} disabled={loading} className="ml-3 rounded underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring">重试</button>}
        </div>
      )}
      {!error && !loading && entries.length === 0 && (
        // EmptyState（2026-10-17）：替代「空目录」一行灰字——给得出路的空态才友好，
        // 且和「没加载完」在视觉上一眼可分。过滤无命中是第三种情况：目录不空，
        // 只是当前关键词没匹配上，提示必须指向「改关键词」而不是「上传文件」。
        <EmptyState
          className="py-10"
          icon={filterActive ? "search" : "folder"}
          description={filterActive ? "没有匹配的条目，换个关键词或清空过滤框。" : "目录为空。把文件拖进来，或点上方「上传」。"}
        />
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
            <SortableTh sortKey="name" label="名称" align="left" extra="py-1.5 pl-3" sort={sort} onToggleSort={onToggleSort} />
            <SortableTh sortKey="size" label="大小" align="right" extra="w-28 py-1.5" sort={sort} onToggleSort={onToggleSort} />
            <SortableTh sortKey="mtime" label="修改时间" align="right" extra="w-40 py-1.5 pr-3" sort={sort} onToggleSort={onToggleSort} />
            <th className="w-52 py-1.5 pr-3 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody ref={tbodyRef}>
          {entries.map((e) => (
            <SshFileRow
              key={e.name}
              entry={e}
              highlighted={e.name === highlightName}
              selected={!!selectedNames?.includes(e.name)}
              busy={busy || loading}
              onOpenDir={onOpenDir}
              onDownload={onDownload}
              onRemove={onRemove}
              onRename={onRename}
              onMove={onMove}
              onSelect={onSelect}
              onActivateFile={onActivateFile}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
