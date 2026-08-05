import { useState } from "react";
import { invoke } from "../../lib/tauri";
import type { BackupCleanupResult } from "../../lib/types";
import { formatBytes } from "../../lib/utils";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useToast } from "../ui/toast";

/**
 * 删除目标。`one` 只服务「精确删某一份」——逐条删除不承担批量职责，
 * 批量请走备份卡的「清理备份…」（带预览与保留底线）。
 */
export type BackupDeleteTarget =
  | { kind: "one"; backupPath: string }
  | { kind: "group"; originalFile: string; count: number };

/**
 * 版本历史里的删除二级确认。单独成文件是为了不再抱 VersionHistoryModal
 * 那个已经很大的文件；它只需持一个 `target` state 并把本组件渲染出来。
 *
 * 渲染在 `Modal`（zIndex 1000）**内部**，所以必须把确认框抬到 1001：
 * 不抬的话它会被盖在版本历史的遮罩下面，看不见、点不到，
 * 而点击会落到父遮罩上直接把版本历史关掉（`RestoreBackupDialog` 早就踩过这个坑）。
 */
export function BackupDeleteConfirm({
  target,
  onCancel,
  onDeleted,
}: {
  target: BackupDeleteTarget;
  onCancel: () => void;
  /** 删除成功：调用方需刷新统计并失效备份列表缓存。 */
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const handleConfirm = async () => {
    setBusy(true);
    try {
      if (target.kind === "one") {
        const freed = await invoke<number>("delete_backup", { backupPath: target.backupPath });
        toast(`已删除 1 份备份，释放 ${formatBytes(freed)}`, "success");
      } else {
        const r = await invoke<BackupCleanupResult>("delete_backups_of_file", {
          originalPath: target.originalFile,
        });
        const failed = r.failed > 0 ? `；${r.failed} 份删失败（可能被占用）` : "";
        toast(
          `已删除 ${r.removed} 份备份，释放 ${formatBytes(r.freedBytes)}${failed}`,
          r.failed > 0 ? "error" : "success",
        );
      }
      onDeleted();
      onCancel();
      // 成功路径上本组件已被父级卸载（onCancel 把 target 置空），不能再 setBusy
      return;
    } catch (e) {
      toast(`删除失败：${e}`, "error");
    }
    setBusy(false);
  };

  if (target.kind === "one") {
    const name = target.backupPath.split(/[\\/]/).pop();
    return (
      <ConfirmDialog
        title="删除这份备份？"
        variant="destructive"
        zIndex={1001}
        confirmLabel={busy ? "删除中..." : "删除"}
        confirmDisabled={busy}
        description={
          <>
            将删除 <span className="font-mono">{name}</span>
            。当前文件不受影响，但这个时间点的快照不可恢复。
          </>
        }
        onCancel={onCancel}
        onConfirm={handleConfirm}
      />
    );
  }

  return (
    <ConfirmDialog
      title="删除该分组的全部备份？"
      variant="destructive"
      zIndex={1001}
      confirmLabel={busy ? "删除中..." : `删除 ${target.count} 份`}
      confirmDisabled={busy}
      description={
        <>
          <span className="font-mono">{target.originalFile}</span> 名下的 {target.count}{" "}
          份备份将全部删除，之后没有任何可还原的历史版本。
        </>
      }
      onCancel={onCancel}
      onConfirm={handleConfirm}
    >
      {/* 版本历史是按**文件名**分组的（不区分目录），所以这一键可能涵盖
          多个目录下的同名文件。不写清的话，文案读起来像只影响一个文件。 */}
      <p className="rounded-r-lg border-l-[3px] border-warning bg-warning/10 px-3 py-2 text-[11.5px] leading-relaxed">
        该分组按文件名归类，<b>不区分目录</b>——如果多个目录下存在同名文件，
        它们的备份会一并删除。
      </p>
    </ConfirmDialog>
  );
}
