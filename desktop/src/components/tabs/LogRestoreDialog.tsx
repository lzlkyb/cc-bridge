import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../../lib/tauri";
import { friendlyAuditError } from "../../lib/auditError";
import type { AuditEntry } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";

/**
 * 一键还原确认弹窗：调 restore_file，把备份写回目标（删除类=恢复被删文件）。
 *
 * 2026-09-16：从 LogDetailPanel.tsx 抽出成独立文件（原因见 LogDiffModal）。
 */
export function LogRestoreDialog({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();

  // Esc = 取消（危险操作确认的最低预期）；执行中（busy）不响应，避免误关。
  // 必须在下方 early return 之前声明（rules-of-hooks）。
  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  if (!entry.backupPath || !entry.targetPath) return null;
  const isDelete = entry.tool === "delete_files";

  const onConfirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await invoke("restore_file", {
        backup_path: entry.backupPath,
        target_path: entry.targetPath,
      });
      toast(isDelete ? "已恢复被删文件" : "已还原到操作前版本", "success");
      onClose();
    } catch (e) {
      setErr(friendlyAuditError(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm dlg-mask"
      onClick={onClose}
    >
      <div
        className="animate-scale-in mx-4 w-full max-w-md rounded-xl modal-surface p-5 dlg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="mb-2 flex items-center gap-2 text-base font-semibold text-destructive">
          <Icon name="restore" size={18} />
          {isDelete ? "恢复被删文件？" : "确认回滚到操作前？"}
        </h4>
        <p className="mb-3 text-sm text-muted-foreground">
          {isDelete
            ? "将从备份中恢复该文件到被删除前的版本。"
            : "将把目标文件恢复到本次操作之前的版本。还原前会自动再生成一份备份，可再次撤销。"}
        </p>
        <div className="mb-4 space-y-1.5 rounded-md bg-muted/30 p-3 text-xs">
          <div className="flex gap-2">
            <span className="w-12 shrink-0 text-muted-foreground">目标</span>
            <code className="break-all font-mono">{entry.targetPath}</code>
          </div>
          <div className="flex gap-2">
            <span className="w-12 shrink-0 text-muted-foreground">备份</span>
            <code className="break-all font-mono">{entry.backupPath}</code>
          </div>
        </div>
        {err && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive break-all">
            {err}
          </div>
        )}
        <div className="flex justify-end gap-2 dlg-act">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={busy}>
            {busy && <Icon name="spinner" size={14} className="animate-spin" />}
            {isDelete ? "恢复文件" : "确认还原"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
