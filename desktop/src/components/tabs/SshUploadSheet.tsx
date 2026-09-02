import { useEffect, useState } from "react";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { humanSize, remoteDirError } from "../../lib/uploadDir";
import type { LocalFile } from "./useTerminalUpload";

interface SheetProps {
  files: LocalFile[] | null;
  initialDir: string;
  onCancel: () => void;
  onConfirm: (dir: string) => void;
}

/**
 * 终端拖拽的目标目录确认。
 *
 * 为什么必须确认：**终端的 cwd 对我们不可知**（见 `lib/uploadDir.ts`）。
 * 不猜、也不假装知道，而是预填上次用过的目录并让用户改。
 */
export function SshUploadSheet({ files, initialDir, onCancel, onConfirm }: SheetProps) {
  const [dir, setDir] = useState(initialDir);
  const open = !!files;

  useEffect(() => {
    if (open) setDir(initialDir);
  }, [open, initialDir]);

  const err = remoteDirError(dir);
  const total = (files ?? []).reduce((s, f) => s + f.size, 0);
  const head = files?.[0]?.name ?? "";

  return (
    <Dialog open={open} onClose={onCancel}>
      <DialogHeader>
        <DialogTitle>上传到远端</DialogTitle>
      </DialogHeader>

      <p className="text-xs text-muted-foreground">
        {files && files.length > 1
          ? `${head} 等 ${files.length} 个文件（共 ${humanSize(total)}）`
          : `${head}（${humanSize(total)}）`}
      </p>

      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          目标目录
        </label>
        <Input
          value={dir}
          autoFocus
          spellCheck={false}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !err) onConfirm(dir);
          }}
          className="font-mono text-xs"
        />
        {err ? (
          <p className="mt-1 text-xs text-destructive">{err}</p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            终端里 <code className="rounded bg-muted px-1">cd</code> 到哪里本地无法探知，
            这里填的是你上次用过的目录。确认后记住。
          </p>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button disabled={!!err} onClick={() => onConfirm(dir)}>
          上传
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * 上传完成后的结果条。
 *
 * 🔴 不自动把远端路径敲进终端：那是往一个**活着的 shell** 里注入文本，
 * 用户可能正在 vim 里、正在跑 top、正在输 sudo 密码。给个复制按钮就够了。
 */
export function SshUploadResult({
  dir,
  count,
  onDismiss,
}: {
  dir: string;
  count: number;
  onDismiss: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/5 px-3 py-1.5">
      <Icon name="check" size={13} className="shrink-0 text-primary" />
      <span className="shrink-0 text-xs text-muted-foreground">
        已上传 {count} 个文件到
      </span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-xs" title={dir}>
        {dir}
      </code>
      <button
        type="button"
        onClick={() => {
          // 全项目都用 navigator.clipboard 写入：`clipboard-manager:default`
          // 自述就是“默认不启用任何能力”，capabilities 里只补了读文本。
          void navigator.clipboard
            .writeText(dir)
            .then(() => toast("路径已复制", "success"))
            .catch(() => toast("复制失败", "error"));
        }}
        className="shrink-0 rounded-md px-2 py-0.5 text-xs text-primary hover:bg-primary/10"
      >
        复制
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title="关闭"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
