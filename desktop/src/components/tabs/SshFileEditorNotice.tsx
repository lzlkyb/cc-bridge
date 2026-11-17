import { Button } from "../ui/button";

interface Props {
  /** 远端在打开后被改过（保存时被后端拒绝）。 */
  conflict: boolean;
  /** 远端最后修改时间（Unix 秒），仅 conflict 时用。 */
  remoteMtime: number;
  /** 大文件只读预览。 */
  truncated: boolean;
  /** 文件总字节数（只读态提示里显示）。 */
  size: number;
  /** 读取出错（含二进制）。 */
  error: string | null;
  busy: boolean;
  onReload: () => void;
  onForceSave: () => void;
  onOpenExternal: () => void;
}

/** 人类可读字节数。 */
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(s: number): string {
  if (!s) return "未知时间";
  try {
    return new Date(s * 1000).toLocaleTimeString();
  } catch {
    return "未知时间";
  }
}

/**
 * 编辑器提示条：远端被改 / 大文件只读 / 读取失败。
 *
 * 全部内联，**不弹窗**（R17）：冲突时用户手里可能正有未保存的修改，弹窗会把它
 * 的上下文整个抢走。两条出路直接摆在条上——「重新加载」丢修改、「仍然覆盖保存」
 * 保住修改，都由用户自己选。
 */
export function SshFileEditorNotice({
  conflict,
  remoteMtime,
  truncated,
  size,
  error,
  busy,
  onReload,
  onForceSave,
  onOpenExternal,
}: Props) {
  if (conflict) {
    return (
      <div
        role="status"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
      >
        <span className="min-w-0 flex-1">
          <b>服务器上的文件在你打开之后被改过</b>
          ——远端最后修改 {fmtTime(remoteMtime)}。你看到的还是打开时的版本。
        </span>
        <Button size="sm" className="h-6 px-2 text-xs" variant="outline" disabled={busy} onClick={onReload}>
          重新加载（放弃我的修改）
        </Button>
        <Button size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={onForceSave}>
          仍然覆盖保存
        </Button>
      </div>
    );
  }
  if (truncated) {
    return (
      <div
        role="status"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <span className="min-w-0 flex-1">
          文件 {fmtSize(size)}，超过内联编辑上限（2 MB），当前为只读预览，仅显示前一段。
        </span>
        <Button size="sm" className="h-6 px-2 text-xs" variant="outline" disabled={busy} onClick={onOpenExternal}>
          用本机编辑器打开
        </Button>
      </div>
    );
  }
  if (error) {
    const binary = error === "binary";
    return (
      <div
        role="alert"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive-ink"
      >
        <span className="min-w-0 flex-1">
          {binary ? "文件不是 UTF-8 文本，无法内联编辑。" : `读取失败：${error}`}
        </span>
        {binary && (
          <Button size="sm" className="h-6 px-2 text-xs" variant="outline" disabled={busy} onClick={onOpenExternal}>
            用本机编辑器打开
          </Button>
        )}
      </div>
    );
  }
  return null;
}
