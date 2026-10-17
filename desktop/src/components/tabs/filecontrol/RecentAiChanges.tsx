import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../../../lib/tauri";
import type { AuditEntry, AuditPage } from "../../../lib/types";
import { toolLabel } from "../../../lib/utils";
import { Icon } from "../../ui/icon";
import { Skeleton } from "../../ui/Skeleton";
import { LogDiffModal } from "../LogDiffModal";
import { LogRestoreDialog } from "../LogRestoreDialog";

/** 最多展示的条数——完整历史走「日志」页，这里只做近期速览。 */
const MAX_SHOW = 10;
/** 产生备份的改动类工具；backupPath 存在即代表可对比 / 可还原。 */
const CHANGE_TOOLS = new Set(["write_files", "edit_files", "delete_files", "move_files"]);

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 「近期 AI 改动」展开区（文件管控卡 SumRow 折叠态之下）。
 *
 * 从 get_audit_log 拉最近 200 条审计，前端过滤出带备份的改动类条目，按时间
 * 倒序排成时间线；对比 / 还原直接复用日志页的 LogDiffModal / LogRestoreDialog，
 * 零新弹窗。仅在展开时拉取（active 控制 enabled），不占首屏请求。
 *
 * 2026-10-17（四项增强·批A）：还原成功后没有回调可挂——LogRestoreDialog 自成
 * 一体，这里在 onClose 里统一失效缓存重拉，顺带覆盖 diff 弹窗关闭的刷新需求。
 */
export function RecentAiChanges({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const [diffEntry, setDiffEntry] = useState<AuditEntry | null>(null);
  const [restoreEntry, setRestoreEntry] = useState<AuditEntry | null>(null);

  const { data, isLoading } = useQuery<AuditPage>({
    queryKey: ["recentAiChanges"],
    queryFn: () => invoke<AuditPage>("get_audit_log", { page: 1, page_size: 200 }),
    enabled: active,
    staleTime: 30_000,
  });

  const changes = (data?.entries ?? [])
    .filter((e) => e.backupPath && e.targetPath && CHANGE_TOOLS.has(e.tool))
    .slice(0, MAX_SHOW);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["recentAiChanges"] });
  };

  return (
    <div className="space-y-2.5 px-2.5 pb-2">
      {isLoading && (
        <div className="space-y-2 p-1">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      )}

      {!isLoading && changes.length === 0 && (
        <div className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          <Icon name="clock" size={16} className="mx-auto mb-1.5 text-muted-foreground/60" />
          暂无 AI 改动记录
          <div className="mt-1 text-[10.5px]">
            AI 写入 / 删除受保护文件时会在这里留档，可随时对比与还原。
          </div>
        </div>
      )}

      {changes.map((e) => {
        const name = e.targetPath?.split(/[\\/]/).pop() ?? "文件";
        return (
          <div key={`${e.timestamp}-${e.targetPath}`} className="s-row group">
            <span className="title-chip">
              <Icon name="file" size={15} aria-hidden="true" />
            </span>
            <div className="s-body min-w-0">
              <div className="flex items-center gap-2">
                <span className="s-label truncate" title={e.targetPath}>
                  {name}
                </span>
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                  {toolLabel(e.tool)}
                </span>
                {!e.success && (
                  <span title={e.error ?? "操作失败"}>
                    <Icon name="alert" size={12} className="shrink-0 text-amber-600 dark:text-amber-400" />
                  </span>
                )}
              </div>
              <div className="s-row-desc font-mono text-[10.5px]">{fmtTime(e.timestamp)}</div>
            </div>
            <div className="s-right flex shrink-0 gap-1">
              <button
                onClick={() => setDiffEntry(e)}
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="对比改动前后"
                aria-label={`对比 ${name}`}
              >
                <Icon name="eye" size={14} />
              </button>
              <button
                onClick={() => setRestoreEntry(e)}
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={e.tool === "delete_files" ? "恢复被删文件" : "还原到操作前版本"}
                aria-label={`还原 ${name}`}
              >
                <Icon name="restore" size={14} />
              </button>
            </div>
          </div>
        );
      })}

      {changes.length > 0 && (
        <p className="px-2.5 pb-1 text-[10.5px] text-muted-foreground">
          仅显示最近 {MAX_SHOW} 条 · 完整记录见「日志」页
        </p>
      )}

      {diffEntry && <LogDiffModal entry={diffEntry} onClose={() => { setDiffEntry(null); invalidate(); }} />}
      {restoreEntry && (
        <LogRestoreDialog
          entry={restoreEntry}
          onClose={() => { setRestoreEntry(null); invalidate(); }}
        />
      )}
    </div>
  );
}
