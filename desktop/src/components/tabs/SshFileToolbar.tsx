import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import type { SshConnection, SshFileEntry } from "../../lib/types";

interface FileHeaderProps {
  conn: SshConnection;
  path: string;
  loading: boolean;
  busy: boolean;
  onBack: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
}

/**
 * 文件管理器顶部：返回 + 连接信息 + 刷新/新建/上传 + 路径条（上一级）。
 */
export function FileHeader({
  conn,
  path,
  loading,
  busy,
  onBack,
  onUp,
  onRefresh,
  onNewFolder,
  onUpload,
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
        <span className="truncate text-xs text-muted-foreground">
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
            disabled={loading || busy}
            onClick={onNewFolder}
          >
            <Icon name="plus" size={13} /> 新建
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            variant="outline"
            disabled={loading || busy}
            onClick={onUpload}
          >
            <Icon name="upload" size={13} /> 上传
          </Button>
        </div>
      </div>

      {/* 路径条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
        <button
          type="button"
          disabled={loading || busy}
          onClick={onUp}
          className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          上一级
        </button>
        <code className="truncate rounded bg-muted px-2 py-0.5 text-xs">{path}</code>
        {loading && <span className="text-xs text-muted-foreground">加载中…</span>}
      </div>
    </>
  );
}

interface RemoveConfirmDialogProps {
  target: SshFileEntry | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 删除二次确认（项目内 Dialog，统一 Tauri 风格）。
 */
export function RemoveConfirmDialog({
  target,
  busy,
  onConfirm,
  onCancel,
}: RemoveConfirmDialogProps) {
  return (
    <Dialog open={!!target} onClose={onCancel}>
      <DialogHeader>
        <DialogTitle>删除确认</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        确定要删除远程文件
        <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-foreground">
          {target?.name}
        </code>
        吗？该操作会<strong className="text-destructive">递归删除且不可恢复</strong>。
      </p>
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
