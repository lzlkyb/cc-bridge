import { useState, useEffect } from "react";
import { Modal } from "../ui/Modal";
import { useDialogDismiss } from "../../hooks/useDialogDismiss";
import { invoke } from "../../lib/tauri";
import { friendlyAuditError } from "../../lib/auditError";
import type { AuditEntry, FileDiffResult } from "../../lib/types";
import { Icon } from "../ui/icon";
import { Skeleton } from "../ui/Skeleton";

/**
 * 变更 Diff 弹窗：调 get_file_diff，行级红绿高亮展示备份（前）vs 当前文件（后）。
 * 大文件 / 二进制 / 行数过多触发护栏，仅提示可还原、不展示全量 diff。
 *
 * 2026-09-16：从 LogDetailPanel.tsx 抽出成独立文件。它和 RestoreConfirmDialog
 * 各自带 useEffect 与自成一体的弹窗生命周期，混在详情面板里让那个文件既超
 * 300 行红线、又逼近「单文件 8 个 useState/useEffect」的上限。
 */
export function LogDiffModal({ entry, onClose: onClosed }: { entry: AuditEntry; onClose: () => void }) {
  const { closing, dismiss } = useDialogDismiss(onClosed);
  const onClose = () => dismiss();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<FileDiffResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await invoke<FileDiffResult>("get_file_diff", {
          backup_path: entry.backupPath,
          target_path: entry.targetPath,
        });
        if (!cancelled) setResult(r);
      } catch (e) {
        if (!cancelled) setErr(friendlyAuditError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const fileName = entry.targetPath?.split(/[\\/]/).pop() ?? "文件";

  return (
    <Modal open={!closing} onClose={onClose} className="flex h-[80vh] w-full max-w-3xl flex-col rounded-xl modal-surface" zIndex={50}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Icon name="history" size={16} className="text-primary" />
            变更 Diff
            <span className="font-mono text-xs font-normal text-muted-foreground">{fileName}</span>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {loading && (
            <div className="space-y-2 p-1">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3.5 w-10/12" />
            </div>
          )}
          {err && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive-ink break-all">
              {err}
            </div>
          )}
          {result && result.guard && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              {result.guard}
              <span className="ml-1 font-mono text-muted-foreground">
                （{result.beforeLines} → {result.afterLines} 行）
              </span>
            </div>
          )}
          {result && !result.guard && (
            <pre className="overflow-auto rounded-md bg-foreground/90 p-3 text-xs leading-relaxed text-background diff">
              {result.lines.map((l, i) => (
                <div
                  key={i}
                  className={
                    l.kind === "removed"
                      ? "bg-red-500/25"
                      : l.kind === "added"
                        ? "bg-green-500/25"
                        : ""
                  }
                >
                  {l.text}
                </div>
              ))}
            </pre>
          )}
        </div>
    </Modal>
  );
}
