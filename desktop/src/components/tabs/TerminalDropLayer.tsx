import { SshDropOverlay } from "./SshDropOverlay";
import { SshUploadSheet, SshUploadResult } from "./SshUploadSheet";
import { TransferBar, OverwriteConfirmDialog } from "./SshTransferBar";
import type { useTerminalUpload } from "./useTerminalUpload";

interface Props {
  up: ReturnType<typeof useTerminalUpload>;
  /** 当前是否有文件悬停在终端上。 */
  dropping: boolean;
  count: number;
}

/**
 * 终端区的上传相关 UI：结果条 / 进度条（占位）+ 拖入遮罩 / 弹框（不占位）。
 *
 * 单独抽一个组件，是为了让 `TerminalTab` 只多一行——它已经 246 行，
 * 靠近 300 行上限（规则 7）。
 */
export function TerminalDropLayer({ up, dropping, count }: Props) {
  return (
    <>
      {up.result && (
        <SshUploadResult
          dir={up.result.dir}
          count={up.result.count}
          onDismiss={up.dismissResult}
        />
      )}
      {up.transfer && <TransferBar transfer={up.transfer} onCancel={up.cancel} />}
      {dropping && <SshDropOverlay count={count} />}
      <SshUploadSheet
        files={up.pending}
        initialDir={up.dir}
        onCancel={up.cancelSheet}
        onConfirm={(d) => void up.confirm(d)}
      />
      <OverwriteConfirmDialog prompt={up.prompt} onCancel={up.dismissPrompt} />
    </>
  );
}
