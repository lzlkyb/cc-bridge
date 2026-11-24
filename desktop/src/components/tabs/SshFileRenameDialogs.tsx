import { Dialog, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { isImeComposing } from "../../lib/utils";
import type { SshFileEntry } from "../../lib/types";

/* ── 重命名 ─────────────────────────────────────────────────── */

interface RenameDialogProps {
  entry: SshFileEntry;
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * 重命名对话框：预填当前名，「只能修改名称」写进提示文案——
 * 后端也结构性保证（rename 命令只收 new_name，父目录由服务端算）。
 */
export function RenameDialog({ entry, value, busy, onChange, onSubmit, onCancel }: RenameDialogProps) {
  return (
    <Dialog open onClose={onCancel}>
      <DialogHeader>
        <DialogTitle>重命名</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        正在重命名
        <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-foreground">{entry.name}</code>。
      </p>
      <div className="mt-4">
        <label htmlFor="ssh-rename-input" className="mb-1.5 block text-sm font-medium">
          新名称
        </label>
        <Input
          id="ssh-rename-input"
          autoFocus
          value={value}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          // IME 组词的 Enter 是上屏候选词，不是提交（中文名高频）
          onKeyDown={(e) => !isImeComposing(e.nativeEvent) && e.key === "Enter" && onSubmit()}
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          只能修改名称；要换目录请用「移动」。名称不能包含 / 或空值。
        </p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button disabled={busy || !value.trim()} onClick={onSubmit}>
          重命名
        </Button>
      </div>
    </Dialog>
  );
}

/* ── 移动到目录 ─────────────────────────────────────────────── */

interface MoveDialogProps {
  entries: SshFileEntry[];
  dir: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** 移动对话框：单条与批量共用（条目数区分文案；批量给清单 + 串行说明）。 */
export function MoveDialog({ entries, dir, busy, onChange, onSubmit, onCancel }: MoveDialogProps) {
  const one = entries.length === 1 ? entries[0] : null;
  return (
    <Dialog open onClose={onCancel}>
      <DialogHeader>
        <DialogTitle>{one ? "移动到" : `移动 ${entries.length} 个条目`}</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        {one ? (
          <>
            把
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-foreground">{one.name}</code>
            移动到下面的目录。
          </>
        ) : (
          "把选中的条目移动到下面的目录。"
        )}
      </p>
      <div className="mt-4">
        <label htmlFor="ssh-move-dir" className="mb-1.5 block text-sm font-medium">
          目标目录
        </label>
        <Input
          id="ssh-move-dir"
          autoFocus
          value={dir}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => !isImeComposing(e.nativeEvent) && e.key === "Enter" && onSubmit()}
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          目标已存在同名文件时会先询问；目录不存在时后端会报错。
        </p>
      </div>
      {!one && (
        <ul className="mt-2 max-h-24 overflow-y-auto rounded border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
          {entries.map((e) => (
            <li key={e.name} className="truncate">
              {e.name}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button disabled={busy || !dir.trim()} onClick={onSubmit}>
          移动
        </Button>
      </div>
    </Dialog>
  );
}

/* ── 覆盖确认 ───────────────────────────────────────────────── */

interface OverwritePromptView {
  /** 冲突的目标名。 */
  names: string[];
  /** 展示用：完整目标路径（单条时给路径框）。 */
  paths?: string[];
}

interface RenameOverwriteDialogProps {
  prompt: OverwritePromptView;
  busy: boolean;
  onCancel: () => void;
  onOverwrite: () => void;
  /** 批量冲突才给「跳过这些」（只执行没冲突的那些）；单条冲突没有跳过可言。 */
  onSkip?: () => void;
}

/**
 * 覆盖确认（重命名/移动共用）：后端 TARGET_EXISTS 预检命中后弹。
 *
 * 与删除确认同一立场：丢数据的操作必须过确认，没有静默覆盖路径。
 */
export function RenameOverwriteDialog({
  prompt,
  busy,
  onCancel,
  onOverwrite,
  onSkip,
}: RenameOverwriteDialogProps) {
  const one = prompt.names.length === 1 ? prompt.names[0] : null;
  return (
    <Dialog open onClose={onCancel}>
      <DialogHeader>
        <DialogTitle>目标已存在</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        {one ? (
          <>
            远端已存在同名文件
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-foreground">{one}</code>
            ，继续将覆盖该文件，原内容无法恢复。
          </>
        ) : (
          <>
            选中的条目里有 <strong className="text-foreground">{prompt.names.length}</strong>{" "}
            个在目标目录已有同名文件，继续将覆盖它们，原内容无法恢复。
          </>
        )}
      </p>
      {one && prompt.paths?.[0] && (
        <span className="mt-2 block break-all rounded-md border border-border bg-muted px-2.5 py-2 font-mono text-xs text-foreground">
          {prompt.paths[0]}
        </span>
      )}
      {!one && (
        <ul className="mt-2 max-h-24 overflow-y-auto rounded border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
          {prompt.names.map((n) => (
            <li key={n} className="truncate">
              {n}
            </li>
          ))}
        </ul>
      )}
      {!one && (
        <p className="mt-2 text-xs text-muted-foreground">
          串行执行（一次一条会话）；也可以只移动没冲突的那些。
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          取消
        </Button>
        {onSkip && (
          <Button variant="outline" onClick={onSkip} disabled={busy}>
            跳过这些
          </Button>
        )}
        <Button
          className="bg-destructive text-white hover:bg-destructive/90"
          disabled={busy}
          onClick={onOverwrite}
        >
          覆盖
        </Button>
      </div>
    </Dialog>
  );
}
