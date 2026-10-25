import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { isImeComposing } from "../../lib/utils";

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
        // IME 组词的 Enter 是上屏候选词，不是提交
        onKeyDown={(e) => !isImeComposing(e.nativeEvent) && e.key === "Enter" && onSubmit()}
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
        // IME 组词的 Enter 是上屏候选词，不是提交
        onKeyDown={(e) => !isImeComposing(e.nativeEvent) && e.key === "Enter" && onSubmit()}
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
