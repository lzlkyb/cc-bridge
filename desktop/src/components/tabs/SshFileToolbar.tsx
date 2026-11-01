import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import type { SshConnection, SshFileEntry } from "../../lib/types";
import { FilePathBar } from "./FilePathBar";

interface FileHeaderProps {
  conn: SshConnection;
  path: string;
  loading: boolean;
  busy: boolean;
  directoryReady?: boolean;
  onBack: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
  onNavigate: (path: string) => void;
  canBack: boolean; canForward: boolean; onHistoryBack: () => void; onHistoryForward: () => void;
}

/**
 * 文件管理器顶部：返回 + 连接信息 + 刷新/新建/上传 + 路径条（上一级）。
 */
export function FileHeader({
  conn,
  path,
  loading,
  busy,
  directoryReady = true,
  onBack,
  onUp,
  onRefresh,
  onNewFolder,
  onUpload,
  onNavigate, canBack, canForward, onHistoryBack, onHistoryForward,
}: FileHeaderProps) {
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
          title="返回终端"
        >
          <Icon name="arrowLeft" size={14} /> 返回终端
        </button>
        <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          📁 文件管理
        </span>
        <Icon name="terminal" size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium" title={`${conn.username}@${conn.host}:${conn.port}`}>
          {conn.name || conn.host}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={`${conn.username}@${conn.host}:${conn.port}`}>
          {conn.username}@{conn.host}:{conn.port}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={loading || busy}
            onClick={onRefresh}
          >
            <Icon name="refresh" size={13} /> 刷新
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            variant="outline"
            disabled={loading || busy || !directoryReady}
            onClick={onNewFolder}
          >
            <Icon name="plus" size={13} /> 新建
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            variant="outline"
            disabled={loading || busy || !directoryReady}
            onClick={onUpload}
          >
            <Icon name="upload" size={13} /> 上传
          </Button>
        </div>
      </div>

      <FilePathBar path={path} disabled={loading || busy} loading={loading} onUp={onUp} onNavigate={onNavigate} canBack={canBack} canForward={canForward} onBack={onHistoryBack} onForward={onHistoryForward}/>
    </>
  );
}

interface RemoveConfirmDialogProps {
  /** 待删除条目（多选时是多个）。单条时只显示名字，多条时给数量 + 清单。 */
  targets: SshFileEntry[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 删除二次确认（项目内 Dialog，统一 Tauri 风格）。
 */
export function RemoveConfirmDialog({
  targets,
  busy,
  onConfirm,
  onCancel,
}: RemoveConfirmDialogProps) {
  const one = targets.length === 1 ? targets[0] : null;
  return (
    <Dialog open={targets.length > 0} onClose={onCancel}>
      <DialogHeader>
        <DialogTitle>删除确认</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        {one ? (
          <>
            确定要删除远程文件
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-foreground">{one.name}</code>
            吗？
          </>
        ) : (
          <>
            确定要删除选中的 <strong className="text-foreground">{targets.length}</strong> 个文件吗？
          </>
        )}
        该操作会<strong className="text-destructive-ink">递归删除且不可恢复</strong>。
      </p>
      {!one && (
        <ul className="mt-2 max-h-24 overflow-y-auto rounded border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
          {targets.map((t) => (
            <li key={t.name} className="truncate">
              {t.name}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button
          className="bg-destructive text-white hover:bg-destructive/90"
          disabled={busy}
          onClick={onConfirm}
        >
          删除
        </Button>
      </div>
    </Dialog>
  );
}
