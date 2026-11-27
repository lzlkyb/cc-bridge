import type { ReactNode } from "react";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import type { SshConnection, SshFileEntry } from "../../lib/types";
import { FilePathBar } from "./FilePathBar";
import { FileWorkspaceActions } from "./FileWorkspaceActions";

interface FileHeaderProps {
  conn: SshConnection;
  path: string;
  loading: boolean;
  busy: boolean;
  navigationBusy?: boolean;
  directoryReady?: boolean;
  disconnected?: boolean;
  moreActions?: ReactNode;
  onBack: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
  onUploadFolder?: () => void;
  onUploadPath?: () => void;
  onNavigate: (path: string) => void;
  canBack: boolean; canForward: boolean; onHistoryBack: () => void; onHistoryForward: () => void;
  /** 过滤词（常驻框；纯客户端派生，列目录进行中也随时可改）。 */
  query: string;
  onQueryChange: (q: string) => void;
}

/**
 * 文件管理器顶部：返回 + 连接信息 + 刷新/新建/上传 + 过滤框 + 路径条（上一级）。
 */
export function FileHeader({
  conn,
  path,
  loading,
  busy,
  navigationBusy = busy,
  directoryReady = true,
  disconnected,
  moreActions,
  onBack,
  onUp,
  onRefresh,
  onNewFolder,
  onUpload, onUploadFolder, onUploadPath,
  onNavigate, canBack, canForward, onHistoryBack, onHistoryForward,
  query, onQueryChange,
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
        <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          <Icon name="folder" size={13}/>文件管理
        </span>
        <Icon name="terminal" size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium" title={`${conn.username}@${conn.host}:${conn.port}`}>
          远端 · {conn.name || conn.host}
        </span>
        <span className="file-workspace-connection-address min-w-0 truncate text-xs text-muted-foreground" title={`${conn.username}@${conn.host}:${conn.port}`}>
          {conn.username}@{conn.host}:{conn.port}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <FileWorkspaceActions disconnected={disconnected}/>
          <Button
            size="sm"
            className="h-7 shrink-0 whitespace-nowrap px-2 text-xs"
            variant="ghost"
            aria-label="刷新"
            title="刷新目录"
            disabled={loading || busy}
            onClick={onRefresh}
          >
            <Icon name="refresh" size={13} /><span className="sr-only">刷新</span>
          </Button>
          <Button
            size="sm"
            className="h-7 shrink-0 whitespace-nowrap px-2 text-xs"
            variant="outline"
            disabled={loading || busy || !directoryReady}
            onClick={onNewFolder}
          >
            <Icon name="plus" size={13} /> 新建
          </Button>
          <div className="inline-flex">
            <Button size="sm" className="h-7 rounded-r-none px-2 text-xs" disabled={loading || busy || !directoryReady} onClick={onUpload}>
              <Icon name="upload" size={13}/> 上传
            </Button>
            <Menu portal trigger={(expanded, toggle) => <Button size="sm" className="h-7 rounded-l-none border-l border-primary-foreground/30 px-1.5"
              disabled={loading || busy || !directoryReady} aria-label="更多上传方式" aria-expanded={expanded} aria-haspopup="menu" onClick={toggle}><Icon name="chevronDown" size={13}/></Button>}>
              {close => <>
                <MenuItem label="上传文件…" icon="file" onClick={() => { close(); onUpload(); }}/>
                <MenuItem label="上传文件夹…" icon="folder" onClick={() => { close(); onUploadFolder?.(); }}/>
                <MenuItem label="输入本机路径…" icon="clipboard" onClick={() => { close(); onUploadPath?.(); }}/>
              </>}
            </Menu>
          </div>
          {/* 常驻过滤：输入即时过滤，清空恢复全量。纯客户端派生，不 disable。
              外层定宽：Input 基类带 w-full，直接写 w-32 会被基类压过。 */}
          <div className="w-32 shrink-0">
            <Input
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="过滤…"
              aria-label="按名称过滤当前目录"
              title="按名称过滤（大小写不敏感）"
              className="h-7 px-2 text-xs"
            />
          </div>
          {moreActions}
        </div>
      </div>

      <FilePathBar path={path} disabled={loading || navigationBusy} loading={loading} onUp={onUp} onNavigate={onNavigate} canBack={canBack} canForward={canForward} onBack={onHistoryBack} onForward={onHistoryForward}/>
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
