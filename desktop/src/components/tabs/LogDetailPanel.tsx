import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../../lib/tauri";
import { toolLabel, formatDurationMs } from "../../lib/utils";
import type { AuditEntry, FileDiffResult } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";

/** 尝试 pretty-print JSON；失败退回原文。 */
function prettyParams(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** D10：从 LogTab.tsx 拆出——展开行详情 + 耗时拆解 + 变更 Diff / 一键还原 弹窗，都是同一个
 * "审计条目详情"工作流的组成部分，收拢到一个文件。 */

/** 展开行：结构化 key-value + 参数高亮代码块 + 复制 + 错误块 + 一键回滚 / 变更 Diff 入口。 */
export function DetailPanel({
  entry,
  onViewDiff,
  onRestore,
}: {
  entry: AuditEntry;
  onViewDiff: (e: AuditEntry) => void;
  onRestore: (e: AuditEntry) => void;
}) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.params);
      setCopied(true);
      toast("参数已复制到剪贴板", "success");
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toast(`复制失败：${e}`, "error");
    }
  };
  return (
    <div className="space-y-3 py-1">
      {entry.backupPath && entry.targetPath && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => onViewDiff(entry)}>
            <Icon name="history" size={14} />
            查看变更
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            onClick={() => onRestore(entry)}
          >
            <Icon name="restore" size={14} />
            {entry.tool === "delete_files" ? "恢复被删文件" : "一键还原"}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-[76px_1fr] gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">时间</span>
        <span className="break-all">{new Date(entry.timestamp).toLocaleString()}</span>
        <span className="text-muted-foreground">操作</span>
        <span className="break-all">
          {toolLabel(entry.tool)}{" "}
          <span className="font-mono text-[11px] text-muted-foreground">({entry.tool})</span>
        </span>
        {entry.sourceIp && (
          <>
            <span className="text-muted-foreground">来源 IP</span>
            <span className="break-all font-mono text-[11px]">{entry.sourceIp}</span>
          </>
        )}
        {entry.durationMs != null && (
          <>
            <span className="text-muted-foreground">耗时</span>
            <span>{formatDurationMs(entry.durationMs)}</span>
          </>
        )}
      </div>
      <TimingBreakdown entry={entry} />
      <div>
        <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>参数</span>
          <button
            onClick={copy}
            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <Icon name={copied ? "check" : "copy"} size={12} />
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <pre className="overflow-auto rounded-md bg-foreground/90 p-3 text-[11px] leading-relaxed text-background">
          {prettyParams(entry.params)}
        </pre>
      </div>
      {entry.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive break-all">
          {entry.error}
        </div>
      )}
    </div>
  );
}

/** O1 结构化耗时拆解：单条审计日志的 5 维耗时可视化。无 O1 数据时显示灰色提示。 */
function TimingBreakdown({ entry }: { entry: AuditEntry }) {
  const serverMs = entry.serverMs;
  if (serverMs == null) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-dashed border-border bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
        <Icon name="activity" size={12} />
        此记录无结构化耗时数据（O1 字段在后端 v2.2.20 后才写入，旧条目不包含 serverMs / ioMs 等）
      </div>
    );
  }

  const io = entry.ioMs ?? 0;
  const audit = entry.auditMs ?? 0;
  const overhead = entry.overheadMs ?? 0;
  const net = entry.netMs ?? Math.max(0, (entry.durationMs ?? serverMs) - serverMs);
  const dispatch = Math.max(0, serverMs - io - audit - overhead);

  const items = [
    { label: "调度逻辑", ms: dispatch, color: "#6366f1" },
    { label: "文件读写 I/O", ms: io, color: "#14b8a6" },
    { label: "审计写盘", ms: audit, color: "#f59e0b" },
    { label: "网络往返", ms: net, color: "#ef4444" },
    { label: "传输/序列化", ms: overhead, color: "#8b5cf6" },
  ].filter((s) => s.ms > 0);

  const total = items.reduce((s, x) => s + x.ms, 0) || 1;
  const maxMs = Math.max(1, ...items.map((x) => x.ms));

  return (
    <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-primary">
        <Icon name="activity" size={13} />
        耗时拆解
        <span className="ml-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold">O1</span>
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">
          服务端 <strong className="font-semibold text-foreground">{formatDurationMs(serverMs)}</strong>
          {entry.durationMs != null && <> · 客户端测 {formatDurationMs(entry.durationMs)}</>}
        </span>
      </div>
      <div className="flex h-5 overflow-hidden rounded border border-border bg-muted/30">
        {items.map((s) => {
          const pct = (s.ms / total) * 100;
          return (
            <div
              key={s.label}
              className="flex items-center justify-center overflow-hidden whitespace-nowrap text-[9px] font-semibold text-white transition-all"
              style={{ width: `${pct}%`, background: s.color }}
              title={`${s.label}: ${formatDurationMs(s.ms)}`}
            >
              {pct >= 8 ? formatDurationMs(s.ms) : ""}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        {items.map((s) => {
          const pct = (s.ms / total) * 100;
          return (
            <div key={s.label} className="flex items-center gap-2 text-[11px]">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: s.color }} />
              <span className="w-20 shrink-0 text-muted-foreground">{s.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className="h-full rounded"
                  style={{ width: `${(s.ms / maxMs) * 100}%`, background: s.color }}
                />
              </div>
              <span className="w-16 shrink-0 text-right font-mono font-semibold">{formatDurationMs(s.ms)}</span>
              <span className="w-10 shrink-0 text-right text-[10px] text-muted-foreground">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 变更 Diff 弹窗：调 get_file_diff，行级红绿高亮展示备份（前）vs 当前文件（后）。
 *  大文件 / 二进制 / 行数过多触发护栏，仅提示可还原、不展示全量 diff。 */
export function DiffModal({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
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
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const fileName = entry.targetPath?.split(/[\\/]/).pop() ?? "文件";

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="animate-scale-in flex h-[80vh] w-full max-w-3xl flex-col rounded-xl modal-surface"
        onClick={(e) => e.stopPropagation()}
      >
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
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              加载中…
            </div>
          )}
          {err && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive break-all">
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
            <pre className="overflow-auto rounded-md bg-foreground/90 p-3 text-[12px] leading-relaxed text-background">
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
      </div>
    </div>,
    document.body,
  );
}

/** 一键还原确认弹窗：调 restore_file，把备份写回目标（删除类=恢复被删文件）。 */
export function RestoreConfirmDialog({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();

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
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="animate-scale-in mx-4 w-full max-w-md rounded-xl modal-surface p-5"
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
        <div className="flex justify-end gap-2">
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
