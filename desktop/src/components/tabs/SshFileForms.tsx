import { Button } from "../ui/button";
import { Input } from "../ui/input";

/* ── 新建文件夹表单 ── */

interface MkdirFormProps {
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** 新建文件夹内联表单（Enter 提交）。 */
export function MkdirForm({ value, busy, onChange, onSubmit, onCancel }: MkdirFormProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <Input
        autoFocus
        value={value}
        placeholder="文件夹名"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
      />
      <Button size="sm" className="h-7 px-3 text-xs" disabled={busy} onClick={onSubmit}>
        创建
      </Button>
      <Button
        size="sm"
        className="h-7 px-3 text-xs"
        variant="outline"
        onClick={onCancel}
      >
        取消
      </Button>
    </div>
  );
}

/* ── 上传表单 ── */

interface UploadFormProps {
  value: string;
  busy: boolean;
  mac: boolean;
  onChange: (v: string) => void;
  onPick: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** 上传内联表单：系统文件选择器 + 可手填路径（Enter 提交）。 */
export function UploadForm({
  value,
  busy,
  mac,
  onChange,
  onPick,
  onSubmit,
  onCancel,
}: UploadFormProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <Button
        size="sm"
        className="h-7 px-3 text-xs"
        variant="outline"
        disabled={busy}
        onClick={onPick}
      >
        选择文件
      </Button>
      <Input
        value={value}
        placeholder={
          mac
            ? "本机文件完整路径，例如 /Users/you/file.zip"
            : "本机文件完整路径，例如 C:/Users/you/file.zip"
        }
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
      />
      <Button size="sm" className="h-7 px-3 text-xs" disabled={busy} onClick={onSubmit}>
        上传
      </Button>
      <Button
        size="sm"
        className="h-7 px-3 text-xs"
        variant="outline"
        onClick={onCancel}
      >
        取消
      </Button>
    </div>
  );
}

/* ── 下载目标表单 ── */

interface DownloadFormProps {
  name: string;
  value: string;
  busy: boolean;
  mac: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** 下载目标内联表单：预填本机下载目录 + 文件名，可改（Enter 提交）。 */
export function DownloadForm({
  name,
  value,
  busy,
  mac,
  onChange,
  onSubmit,
  onCancel,
}: DownloadFormProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/30 px-3 py-2">
      <span className="text-xs text-muted-foreground">下载 {name} 到：</span>
      <Input
        autoFocus
        value={value}
        placeholder={
          mac
            ? "本机保存路径，例如 /Users/you/Downloads/file"
            : "本机保存路径，例如 C:/Users/you/downloads/file"
        }
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
      />
      <Button
        size="sm"
        className="h-7 px-3 text-xs"
        disabled={busy}
        onClick={onSubmit}
      >
        保存
      </Button>
      <Button
        size="sm"
        className="h-7 px-3 text-xs"
        variant="outline"
        onClick={onCancel}
      >
        取消
      </Button>
    </div>
  );
}
