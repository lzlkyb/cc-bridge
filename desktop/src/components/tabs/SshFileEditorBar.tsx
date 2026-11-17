import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

interface Props {
  /** 远程文件完整路径（用于展示所在目录）。 */
  path: string;
  fileName: string;
  dirty: boolean;
  busy: boolean;
  /** 只读态不显示保存（大文件预览）。 */
  canSave: boolean;
  onBack: () => void;
  onSave: () => void;
  onOpenExternal: () => void;
}

/**
 * 编辑器顶栏：返回 + 文件名（带未保存圆点）+ 目录 + 右侧操作。
 * 尺寸对齐 `SshFileToolbar.tsx` 的 `FileHeader`（h-7 / text-xs），
 * 两个面板叠在同一个终端覆盖层里，条高不一致会看起来像两个产品。
 */
export function SshFileEditorBar({
  path,
  fileName,
  dirty,
  busy,
  canSave,
  onBack,
  onSave,
  onOpenExternal,
}: Props) {
  const dir = path.slice(0, Math.max(0, path.length - fileName.length)).replace(/\/$/, "") || "/";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
        title="返回文件列表"
      >
        <Icon name="arrowLeft" size={14} /> 文件列表
      </button>
      <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
        📄 编辑
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <b className="truncate text-sm font-medium" title={fileName}>
          {fileName}
        </b>
        {dirty && (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
            title="有未保存的修改"
          />
        )}
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline" title={dir}>
          {dir}
        </span>
      </span>
      <div className="ml-auto flex items-center gap-1">
        {/* 只读态也要能打开本机编辑器——那是大文件唯一的出路 */}
        <Button
          size="sm"
          className="h-7 px-2 text-xs"
          variant="outline"
          disabled={busy}
          onClick={onOpenExternal}
        >
          <Icon name="external" size={13} /> 用本机编辑器打开
        </Button>
        {canSave &&
          (dirty ? (
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={busy}
              onClick={onSave}
              title="Ctrl+S"
            >
              保存
            </Button>
          ) : (
            <Button size="sm" className="h-7 px-2 text-xs" variant="outline" disabled>
              <Icon name="check" size={13} /> 已保存
            </Button>
          ))}
      </div>
    </div>
  );
}
