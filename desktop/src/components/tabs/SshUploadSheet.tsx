import { useEffect, useState } from "react";
import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { humanSize, remoteDirError } from "../../lib/uploadDir";
import { isImeComposing } from "../../lib/utils";
import type { LocalFile } from "./useTerminalUpload";

interface SheetProps {
  files: LocalFile[] | null;
  initialDir: string;
  /** 预填的目录是 OSC 7 探到的远端 cwd（true）还是上次用过的目录（false）——只影响说明文案。 */
  dirFromCwd?: boolean;
  onCancel: () => void;
  onConfirm: (dir: string) => void;
}

/**
 * 终端拖拽的上传确认：文件清单 + 目标目录，回车即传。
 *
 * 每次拖放都过这里（含探到 cwd 的情况）：松手即传会把「拖向别处却松手在终端上」
 * 变成一次撤不回的服务器写入，理由见 useTerminalUpload 头注。
 * 目录预填 cwd（`hooks/useTerminalOsc.ts` 探到的远端当前目录），探不到才退回上次用过的。
 */
export function SshUploadSheet({ files, initialDir, dirFromCwd, onCancel, onConfirm }: SheetProps) {
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
            // IME 组词的 Enter 是上屏候选词，不是提交
            if (e.key === "Enter" && !err && !isImeComposing(e.nativeEvent)) onConfirm(dir);
          }}
          className="font-mono text-xs"
        />
        {err ? (
          <p className="mt-1 text-xs text-destructive-ink">{err}</p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {dirFromCwd ? (
              <>已预填终端当前目录，可直接回车上传，也可以改。</>
            ) : (
              <>
                终端里 <code className="rounded bg-muted px-1">cd</code> 到哪里本地无法探知，
                这里填的是你上次用过的目录。确认后记住。
              </>
            )}
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
  onChangeDir,
  onDismiss,
}: {
  dir: string;
  count: number;
  /** 传错目录时的出口：把那批文件放回确认队列重传。 */
  onChangeDir: () => void;
  onDismiss: () => void;
}) {
  return (
    // 同 RestoreBanner：这条也在终端画布上，必须用不透明 bg-card（半透明主题色叠深色画布
    // 会把 text-muted-foreground 压到 2.98:1，不达 AA）。
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5">
      <Icon name="check" size={13} className="shrink-0 text-primary" />
      <span className="shrink-0 text-xs text-muted-foreground">
        已上传 {count} 个文件到
      </span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-xs" title={dir}>
        {dir}
      </code>
      <button
        type="button"
        onClick={onChangeDir}
        title="传到别的目录"
        className="shrink-0 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
      >
        改目录
      </button>
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
