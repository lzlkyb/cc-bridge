import { useState, useMemo, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { toolLabel } from "../../lib/utils";
import type { AuditEntry } from "../../lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Icon } from "../ui/icon";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";

/** 参数原始 JSON → 表格行内简短摘要。parse 失败退回原文截断。纯函数（规则 11 只在本文件复用，故留本地）。 */
function summarizeParams(raw: string): string {
  const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + "…" : s);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return clip(raw);
  }
  if (!obj || typeof obj !== "object") return clip(raw);
  const parts: string[] = [];
  if (Array.isArray(obj.files)) {
    parts.push(`files: ${obj.files.length} 项`);
    if (typeof obj.encoding === "string") parts.push(`encoding: ${obj.encoding}`);
  } else if (typeof obj.path === "string") {
    parts.push(`path: …/${obj.path.split(/[\\/]/).pop() || obj.path}`);
  }
  if (typeof obj.oldString === "string") parts.push(`oldString: "${clip(obj.oldString, 20)}"`);
  return parts.length ? parts.join(" · ") : clip(raw);
}

/** 尝试 pretty-print JSON；失败退回原文。 */
function prettyParams(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function LogTab() {
  const { data: entries, refetch } = useQuery<AuditEntry[]>({
    queryKey: ["auditLog"],
    queryFn: () => invoke<AuditEntry[]>("get_audit_log", { limit: 100 }),
    refetchInterval: 10000,
  });

  const [toolFilter, setToolFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error">("all");
  const [search, setSearch] = useState("");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const handleClear = async () => {
    await invoke("clear_audit_log");
    setConfirmClear(false);
    refetch();
  };

  const toolNames = useMemo(() => {
    if (!entries) return [];
    return [...new Set(entries.map((e) => e.tool))].sort();
  }, [entries]);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const kw = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (toolFilter && e.tool !== toolFilter) return false;
      if (statusFilter === "success" && !e.success) return false;
      if (statusFilter === "error" && e.success) return false;
      if (kw) {
        const hay = `${e.params}\n${e.error ?? ""}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [entries, toolFilter, statusFilter, search]);

  const handleExport = () => {
    if (filtered.length === 0) return;
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cc-bridge-audit-log.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center justify-between space-y-0 gap-3 flex-wrap">
        <CardTitle icon={<Icon name="log" />}>审计日志</CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="flex items-center gap-1.5 h-8 rounded-md border border-input bg-background px-2">
            <Icon name="search" size={13} className="text-muted-foreground shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索参数 / 错误…"
              className="w-28 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          {/* Tool filter */}
          <select
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">全部工具</option>
            {toolNames.map((t) => (
              <option key={t} value={t}>{toolLabel(t)}</option>
            ))}
          </select>
          {/* Status filter */}
          <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
            {([["all", "全部"], ["success", "成功"], ["error", "失败"]] as const).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setStatusFilter(val)}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                  statusFilter === val
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <Icon name="refresh" size={14} />
            刷新
          </Button>
          <Button variant="outline" size="sm" disabled={filtered.length === 0} onClick={handleExport}>
            <Icon name="download" size={14} />
            导出
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={!entries || entries.length === 0}
            onClick={() => setConfirmClear(true)}
          >
            <Icon name="trash" size={14} />
            清空日志
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <div className="flex h-40 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {entries?.length === 0
                ? "暂无审计记录，远程 Claude Code 连接后操作记录将显示在这里。"
                : "没有匹配的记录，试试调整筛选条件。"}
            </p>
          </div>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[74px]">时间</TableHead>
                <TableHead className="w-[124px]">操作</TableHead>
                <TableHead>参数摘要</TableHead>
                <TableHead className="w-[100px]">来源</TableHead>
                <TableHead className="w-[64px]">耗时</TableHead>
                <TableHead className="w-[64px]">状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((entry, i) => (
                <Fragment key={i}>
                  <TableRow
                    className={`cursor-pointer ${entry.success ? "" : "bg-destructive/5 log-err"}`}
                    onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                  >
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs font-medium">{toolLabel(entry.tool)}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">{entry.tool}</span>
                      </div>
                    </TableCell>
                    <TableCell className="truncate text-xs text-muted-foreground">
                      {summarizeParams(entry.params)}
                    </TableCell>
                    <TableCell className="truncate font-mono text-[11px] text-muted-foreground">
                      {entry.sourceIp ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">
                      {entry.durationMs != null ? `${entry.durationMs}ms` : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={entry.success ? "success" : "destructive"}>
                        {entry.success ? "成功" : "失败"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                  {expandedRow === i && (
                    <TableRow key={`${i}-detail`}>
                      <TableCell colSpan={6} className="bg-muted/30">
                        <DetailPanel entry={entry} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {confirmClear && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setConfirmClear(false)}
        >
          <div
            className="animate-scale-in mx-4 w-full max-w-md rounded-xl border bg-card p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="mb-2 flex items-center gap-2 text-base font-semibold text-destructive">
              <Icon name="alertTriangle" size={18} />
              确定清空全部审计日志？
            </h4>
            <p className="mb-4 text-sm text-muted-foreground">
              此操作会删除本机所有历史调用记录，且<b>不可恢复</b>。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmClear(false)}>
                取消
              </Button>
              <Button variant="destructive" size="sm" onClick={handleClear}>
                确定清空
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/** 展开行：结构化 key-value + 参数高亮代码块 + 复制 + 错误块。 */
function DetailPanel({ entry }: { entry: AuditEntry }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(entry.params);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="space-y-3 py-1">
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
            <span>{entry.durationMs} ms</span>
          </>
        )}
      </div>
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
