import { useState } from "react";
import { toolLabel, formatDurationMs } from "../../lib/utils";
import { prettyParams } from "../../lib/logFormat";
import type { AuditEntry } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";

/** D10：从 LogTab.tsx 拆出——展开行详情 + 耗时拆解，都是同一个 "审计条目详情" 工作流的
 *  组成部分，收拢到一个文件。
 *
 *  2026-09-16：原来还住着 DiffModal 与 RestoreConfirmDialog。那两个各自带自己的
 *  useEffect 与弹窗生命周期，与本文件"展开行内容"的职责不是一回事，且让本文件冲到
 *  382 行 / 9 个 useState+useEffect（红线分别是 300 行 / 8 个）。已抽成
 *  `LogDiffModal.tsx`、`LogRestoreDialog.tsx`。 */

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
    <div className="space-y-3 py-1 detail">
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
      <div className="grid grid-cols-[76px_1fr] gap-x-3 gap-y-1 text-xs kv">
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
        <pre className="overflow-auto rounded-md bg-foreground/90 p-3 text-[11px] leading-relaxed text-background pre">
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
    { label: "调度逻辑", ms: dispatch, color: "var(--chart-1)" },
    { label: "文件读写 I/O", ms: io, color: "var(--chart-2)" },
    { label: "审计写盘", ms: audit, color: "var(--chart-3)" },
    { label: "网络往返", ms: net, color: "var(--chart-4)" },
    { label: "传输/序列化", ms: overhead, color: "var(--chart-5)" },
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
      <div className="flex h-5 overflow-hidden rounded border border-border bg-muted/30 tb-bar">
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
      <div className="mt-2 flex flex-col gap-1.5 tb-legend">
        {items.map((s) => {
          const pct = (s.ms / total) * 100;
          return (
            <div key={s.label} className="flex items-center gap-2 text-[11px] tb-item">
              <span className="h-2 w-2 shrink-0 rounded-sm sw2" style={{ background: s.color }} />
              <span className="w-20 shrink-0 text-muted-foreground nm">{s.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className="h-full rounded"
                  style={{ width: `${(s.ms / maxMs) * 100}%`, background: s.color }}
                />
              </div>
              <span className="w-16 shrink-0 text-right font-mono font-semibold ms">{formatDurationMs(s.ms)}</span>
              <span className="w-10 shrink-0 text-right text-[10px] text-muted-foreground pc">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
