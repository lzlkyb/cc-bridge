import { useState } from "react";
import type { BackupCleanupPreview } from "../../lib/types";
import { formatBytes } from "../../lib/utils";
import { Icon } from "../ui/icon";

/**
 * 清理预览展示区（设计稿态 3 / 态 4）。
 *
 * 里面最要紧的是「其中 N 个文件将不再有任何备份」那一行：只告诉用户
 * 「删 847 个」，他根本意识不到自己丢了什么（半年前改过一次的文件，
 * 唯一那份备份被清）。所以这行必须带可展开的具体文件名。
 *
 * 纯展示组件：不发请求、不算数，数字全部来自后端 `plan_cleanup`。
 */
export function BackupCleanupPreviewPanel({
  preview,
  previewing,
  stale,
  error,
}: {
  preview: BackupCleanupPreview | null;
  previewing: boolean;
  /** 预览已过期（条件变了但新结果还没回来）：数字不能再以满不透明展示。 */
  stale: boolean;
  error: string;
}) {
  const [showAll, setShowAll] = useState(false);
  // 过期时不展示红字/绿字结论：它们对应的是旧条件，此时结论可能与新条件相反
  const losing = stale ? [] : (preview?.filesLosingAll ?? []);
  const after = preview ? Math.max(0, preview.totalBytesBefore - preview.freedBytes) : 0;

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[11.5px] text-destructive">
        预览失败：{error}
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border border-primary/25 bg-primary/10 px-3.5 py-3">
        {!preview ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon name="spinner" size={14} className="animate-spin" />
            正在计算…
          </div>
        ) : stale ? (
          // 条件刚变，旧数字已不适用——宁可什么都不显，也不能显一个错的
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon name="spinner" size={14} className="animate-spin" />
            条件已变，正在重新计算…
          </div>
        ) : (
          <>
            <div className={`text-[15px] font-bold ${previewing ? "opacity-50" : ""}`}>
              将删除 {preview.count} 个备份 · 释放 {formatBytes(preview.freedBytes)}
            </div>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground">
              当前 {formatBytes(preview.totalBytesBefore)}（{preview.totalCountBefore} 个）→
              清理后约 {formatBytes(after)}
            </div>
          </>
        )}
      </div>

      {losing.length > 0 && (
        <div className="rounded-r-lg border-l-[3px] border-destructive bg-destructive/10 px-3 py-2.5 text-[11.5px]">
          <div className="flex items-start gap-1.5 font-semibold text-destructive">
            <Icon name="alertTriangle" size={13} className="mt-0.5 shrink-0" />
            其中 {losing.length} 个文件将不再有任何备份
          </div>
          <div className="mt-1.5 space-y-0.5">
            {(showAll ? losing : losing.slice(0, 5)).map((f) => (
              <div key={f} className="break-all font-mono text-[11px] text-muted-foreground">
                {f}
              </div>
            ))}
            {losing.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                {showAll ? "收起" : `展开全部 ${losing.length} 个`}
              </button>
            )}
          </div>
        </div>
      )}

      {!stale && preview && losing.length === 0 && preview.count > 0 && (
        <div className="flex items-start gap-1.5 rounded-r-lg border-l-[3px] border-success bg-success/10 px-3 py-2.5 text-[11.5px]">
          <Icon name="check" size={13} className="mt-0.5 shrink-0 text-success" />
          <span>没有文件会失去全部备份。</span>
        </div>
      )}

      {!stale && preview && preview.count === 0 && (
        <p className="text-[11.5px] text-muted-foreground">当前条件下没有可清理的备份。</p>
      )}
    </>
  );
}
