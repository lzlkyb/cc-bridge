import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { useClipboardImagePaste } from "../../hooks/useClipboardImagePaste";

interface Props {
  paste: ReturnType<typeof useClipboardImagePaste>;
  /** 关框后把焦点还给终端：Modal 不做焦点还原，不还的话用户接着打字没反应。 */
  onFocusReturn: () => void;
}

/**
 * 剪贴板图片上传前的确认框：预览 + 远端目标路径。
 * 上传是撤不回的远端副作用（图片留在服务器上），而触发它的两条路都容易误碰——
 * 理由与触发面见 hooks/useClipboardImagePaste 头注。
 */
export function SshImagePasteConfirm({ paste, onFocusReturn }: Props) {
  const p = paste.pending;
  if (!p) return null;
  return (
    <ConfirmDialog
      title="把剪贴板图片上传到远端？"
      description="图片会传到服务器并留在那里，撤回不了。先看一眼是不是想发的那张。"
      confirmLabel="上传并填入路径"
      onCancel={() => {
        paste.cancelUpload();
        onFocusReturn();
      }}
      onConfirm={() => {
        void paste.confirmUpload();
        onFocusReturn();
      }}
    >
      <div className="space-y-2">
        <img
          src={p.url}
          alt="剪贴板图片预览"
          className="max-h-48 w-full rounded-md border border-border object-contain"
        />
        <p className="break-all text-xs text-muted-foreground">
          {p.width}×{p.height} → {p.remote}
        </p>
      </div>
    </ConfirmDialog>
  );
}