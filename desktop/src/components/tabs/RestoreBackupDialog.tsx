import { useState } from "react";
import { invoke } from "../../lib/tauri";
import type { BackupFileInfo } from "../../lib/types";
import { formatBytes } from "../../lib/utils";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { useToast } from "../ui/toast";
import { ConfirmModal } from "../ui/ConfirmModal";

/** 还原确认弹窗（调已有 restore_file）。targets 为空时禁用确认。 */
export function RestoreBackupDialog({ entry, onClose }: { entry: BackupFileInfo; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [target, setTarget] = useState(entry.targets[0] ?? "");
  const { toast } = useToast();

  const onConfirm = async () => {
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      await invoke("restore_file", { backup_path: entry.backupPath, target_path: target });
      toast("已还原到操作前版本", "success");
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmModal open onClose={onClose} maxWidth="md" zIndex={1001}>
      <h4 className="mb-2 flex items-center gap-2 text-base font-semibold text-destructive">
        <Icon name="restore" size={18} />
        还原备份
      </h4>
      <div className="mb-3 space-y-1.5 rounded-md bg-muted/30 p-3 text-xs">
        <div className="flex gap-2">
          <span className="w-14 shrink-0 text-muted-foreground">备份</span>
          <code className="break-all font-mono">{entry.backupPath}</code>
        </div>
        <div className="flex gap-2">
          <span className="w-14 shrink-0 text-muted-foreground">大小</span>
          <span className="font-mono">{formatBytes(entry.sizeBytes)}</span>
        </div>
      </div>
      {entry.targets.length > 0 ? (
        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            还原到（创建备份时记录的原始路径）
          </label>
          {entry.targets.length === 1 ? (
            <code className="block break-all rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
              {entry.targets[0]}
            </code>
          ) : (
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-card px-2 font-mono text-xs outline-none focus:border-primary"
            >
              {entry.targets.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : (
        <p className="mb-3 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          未找到还原目标（白名单关闭、该路径已不在白名单内，或这是无索引记录的历史备份），无法安全还原。可在「审计日志」中对应操作的详情里还原。
        </p>
      )}
      {err && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive break-all">
          {err}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirm}
          disabled={busy || entry.targets.length === 0 || !target}
          isLoading={busy}
          loadingText="还原中…"
        >
          确认还原
        </Button>
      </div>
    </ConfirmModal>
  );
}
