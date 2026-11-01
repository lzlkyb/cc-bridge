import { SshDropOverlay } from "./SshDropOverlay";
import { SshUploadSheet, SshUploadResult } from "./SshUploadSheet";
import { TransferBar, OverwriteConfirmDialog } from "./SshTransferBar";
import type { useTerminalUpload } from "./useTerminalUpload";

interface Props {
  up: ReturnType<typeof useTerminalUpload>;
  /** 当前是否有文件悬停在终端上。 */
  dropping: boolean;
  count: number;
  /** 远端 shell 当前目录（OSC 7）。null/未探到 = 松手后会弹目录确认。 */
  cwd: string | null;
}

/**
 * 终端区的上传相关 UI：结果条 / 进度条（占位）+ 拖入遮罩 / 弹框（不占位）。
 *
 * 单独抽一个组件，是为了让 `TerminalTab` 只多一行——它已经 246 行，
 * 靠近 300 行上限（规则 7）。
 */
export function TerminalDropLayer({ up, dropping, count, cwd }: Props) {
  return (
    <>
      {up.result && (
        <SshUploadResult
          dir={up.result.dir}
          count={up.result.count}
          onChangeDir={up.changeDir}
          onDismiss={up.dismissResult}
        />
      )}
      {up.transfer && <TransferBar transfer={up.transfer} onCancel={up.cancel} />}
      {/* 🔴 必须把已知 cwd 传进去：探到了 cwd 时松手是**直接传**，遮罩却还写着
          「松手选择上传位置」「需要你确认一下」——文案和行为对不上（2026-10-29 盘点）。 */}
      {dropping && <SshDropOverlay count={count} busy={up.busy} dir={cwd ?? undefined} />}
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
