interface Props {
  /** 选中总数（含目录）。 */
  total: number;
  /** 其中普通文件的数量——下载与删除都只对文件有意义。 */
  files: number;
  busy: boolean;
  onDownload: () => void;
  onRemove: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}

/**
 * 多选批量操作条：选了才出现，位置在文件列表上方（不遮列表）。
 *
 * WHY 不做成浮层：列表本身可滚动，浮层会盖住行；做成常驻窄条只占一行高度，
 * 且选中数变化时按钮可用性一眼能看明白。
 * WHY 下载/删除按文件数判可用：目录没有「下载」这回事，删除目录是递归删，
 * 不混在批量里（仍走行尾按钮）。
 */
export function FileBatchBar({ total, files, busy, onDownload, onRemove, onSelectAll, onClear }: Props) {
  return (
    <div
      role="toolbar"
      aria-label="批量操作"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/5 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <span className="shrink-0">已选 {total} 个</span>
      <button
        type="button"
        disabled={busy || files === 0}
        onClick={onDownload}
        className="rounded-md px-2 py-1 text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        下载所选
      </button>
      <button
        type="button"
        disabled={busy || files === 0}
        onClick={onRemove}
        className="rounded-md px-2 py-1 text-destructive-ink hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        删除所选
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onSelectAll}
        className="rounded-md px-2 py-1 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        全选
      </button>
      <button
        type="button"
        disabled={total === 0}
        onClick={onClear}
        className="ml-auto rounded-md px-2 py-1 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        取消选择
      </button>
    </div>
  );
}
