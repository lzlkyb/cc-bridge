import { useState, useMemo, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { toolLabel, formatDurationMs, formatVersion, copyText } from "../../lib/utils";
import type { AuditEntry, AuditPage, StatusResponse } from "../../lib/types";
import { useToast } from "../ui/toast";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Icon } from "../ui/icon";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Combobox } from "../ui/combobox";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PerfCharts } from "./PerfCharts";
import { AuditPager } from "./AuditPager";
import { DetailPanel, DiffModal, RestoreConfirmDialog } from "./LogDetailPanel";

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

/** 折叠条上的实时摘要：自动加载后的关键信号，无需展开即可判断瓶颈。纯函数。 */
function perfSummaryLine(entries: AuditEntry[]): string {
  const valid = entries.filter(
    (e): e is AuditEntry & { durationMs: number } => typeof e.durationMs === "number"
  );
  if (valid.length === 0) return "暂无耗时数据";
  const ds = valid.map((e) => e.durationMs).sort((a, b) => a - b);
  const p95 = ds[Math.min(ds.length - 1, Math.floor((ds.length - 1) * 0.95))];
  const total = ds.reduce((s, d) => s + d, 0);
  const byTool = new Map<string, number>();
  for (const e of valid) byTool.set(e.tool, (byTool.get(e.tool) ?? 0) + e.durationMs);
  let topTool = "";
  let topSum = -1;
  for (const [t, s] of byTool) if (s > topSum) {
    topSum = s;
    topTool = t;
  }
  const errRate = (entries.filter((e) => !e.success).length / entries.length) * 100;
  return `P95 ${Math.round(p95)}ms · ${toolLabel(topTool)} 占 ${((topSum / total) * 100).toFixed(1)}% · 错误率 ${errRate.toFixed(1)}%`;
}

export function LogTab() {
  // 分页状态（策略 A：页码分页）。page/pageSize 变化即触发按页重新拉取。
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const { data: pageData, refetch } = useQuery<AuditPage>({
    queryKey: ["auditLog", page, pageSize],
    queryFn: () => invoke<AuditPage>("get_audit_log", { page, page_size: pageSize }),
    refetchInterval: 10000,
  });

  // 本页数据 + 总数（供分页器算总页数）。筛选仅作用于当前页 entries。
  const entries = pageData?.entries ?? [];
  const total = pageData?.total ?? 0;

  const [toolFilter, setToolFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error">("all");
  const [search, setSearch] = useState("");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showPerf, setShowPerf] = useState(false);
  // 一键回滚 / 变更 Diff 的弹窗状态（指向被点击的审计条目）。
  const [diffEntry, setDiffEntry] = useState<AuditEntry | null>(null);
  const [restoreEntry, setRestoreEntry] = useState<AuditEntry | null>(null);
  const { toast } = useToast();

  const handleClear = async () => {
    await invoke("clear_audit_log");
    setConfirmClear(false);
    setPage(1);
    refetch();
  };

  const handlePageSizeChange = (s: number) => {
    setPageSize(s);
    setPage(1);
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
        const hay = `${e.tool}\n${toolLabel(e.tool)}\n${e.params}\n${e.sourceIp ?? ""}\n${e.error ?? ""}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [entries, toolFilter, statusFilter, search]);

  const handleExport = (format: "json" | "csv" = "json") => {
    if (filtered.length === 0) return;
    if (format === "csv") {
      const header = "时间,工具,工具名,参数,来源IP,耗时(ms),状态,错误\n";
      const rows = filtered.map((e) => {
        const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
        return [
          e.timestamp,
          e.tool,
          toolLabel(e.tool),
          esc(e.params),
          e.sourceIp ?? "",
          e.durationMs ?? "",
          e.success ? "成功" : "失败",
          esc(e.error ?? ""),
        ].join(",");
      }).join("\n");
      const csv = "\uFEFF" + header + rows; // BOM for Excel Chinese support
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cc-bridge-audit-log.csv";
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cc-bridge-audit-log.json";
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  // O3：导出诊断报告——基于已有的日志聚合拼 Markdown（版本 + 性能摘要 + 按工具耗时 + 错误列表），
  // 下载为 .md 文件同时复制到剪贴板，方便直接粘进 issue/反馈。LogTab 本身不持有 status，临时 invoke 一次拿版本。
  const handleExportDiagnostic = async () => {
    if (filtered.length === 0) return;
    try {
      const status = await invoke<StatusResponse>("get_status");
      const byTool = new Map<string, { count: number; totalMs: number; errors: number }>();
      for (const e of filtered) {
        const cur = byTool.get(e.tool) ?? { count: 0, totalMs: 0, errors: 0 };
        cur.count += 1;
        if (typeof e.durationMs === "number") cur.totalMs += e.durationMs;
        if (!e.success) cur.errors += 1;
        byTool.set(e.tool, cur);
      }
      const toolRows = [...byTool.entries()]
        .sort((a, b) => b[1].totalMs - a[1].totalMs)
        .map(
          ([tool, s]) =>
            `| ${toolLabel(tool)} (${tool}) | ${s.count} | ${s.totalMs > 0 ? formatDurationMs(s.totalMs) : "—"} | ${s.errors} |`,
        );
      const errorRows = filtered
        .filter((e) => !e.success)
        .slice(0, 50)
        .map(
          (e) =>
            `- [${new Date(e.timestamp).toLocaleString()}] ${toolLabel(e.tool)} (${e.tool}): ${e.error ?? "(无详情)"}`,
        );

      const lines: string[] = [
        "# cc-bridge 诊断报告",
        "",
        `- 版本：${formatVersion(status?.version)}`,
        `- 导出时间：${new Date().toLocaleString()}`,
        `- 范围：当前筛选结果 ${filtered.length} 条（本页 ${entries.length} / 总计 ${total}）`,
        `- audit.log 位置：安装目录下的数据目录内（设置页「安装与快捷方式」可查看安装目录）`,
        "",
        "## 性能摘要",
        "",
        perfSummaryLine(filtered),
        "",
        "## 按工具统计",
        "",
        "| 工具 | 调用次数 | 总耗时 | 错误数 |",
        "| --- | --- | --- | --- |",
        ...(toolRows.length ? toolRows : ["| （无耗时数据） | | | |"]),
        "",
        `## 错误记录（最多列 50 条，共 ${filtered.filter((e) => !e.success).length} 条）`,
        "",
        ...(errorRows.length ? errorRows : ["（当前筛选范围内无错误记录）"]),
        "",
      ];
      const md = lines.join("\n");

      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cc-bridge-diagnostic-report.md";
      a.click();
      URL.revokeObjectURL(url);

      await copyText(
        md,
        () => toast("诊断报告已导出并复制到剪贴板", "success"),
        () => toast("诊断报告已导出为文件（复制到剪贴板失败）", "warning"),
      );
    } catch (e) {
      toast(`导出诊断报告失败：${e}`, "error");
    }
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
              placeholder="搜索工具 / 参数 / IP…"
              className="w-28 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          {/* Tool filter */}
          <Combobox
            value={toolFilter}
            options={[
              { value: "", label: "全部工具" },
              ...toolNames.map((t) => ({ value: t, label: toolLabel(t) })),
            ]}
            onChange={(v) => setToolFilter(v)}
          />
          {/* Status filter */}
          <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
            {([["all", "全部"], ["success", "成功"], ["error", "失败"]] as const).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setStatusFilter(val)}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                  statusFilter === val
                    ? "bg-background text-foreground shadow-card"
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
          <div className="relative group">
            <Button variant="outline" size="sm" disabled={filtered.length === 0} onClick={() => handleExport("json")}>
              <Icon name="download" size={14} />
              导出 JSON
            </Button>
            <div className="absolute right-0 top-full mt-1 hidden group-hover:flex flex-col rounded-md border bg-popover p-1 shadow-pop z-10 min-w-[120px]">
              <button
                onClick={() => handleExport("json")}
                disabled={filtered.length === 0}
                className="flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-xs hover:bg-accent transition-colors"
              >
                <Icon name="file" size={12} />
                导出 JSON
              </button>
              <button
                onClick={() => handleExport("csv")}
                disabled={filtered.length === 0}
                className="flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-xs hover:bg-accent transition-colors"
              >
                <Icon name="download" size={12} />
                导出 CSV (Excel)
              </button>
              <button
                onClick={() => void handleExportDiagnostic()}
                disabled={filtered.length === 0}
                className="flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-xs hover:bg-accent transition-colors"
              >
                <Icon name="activity" size={12} />
                导出诊断报告 (Markdown)
              </button>
            </div>
          </div>
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
        {entries && entries.some((e) => typeof e.durationMs === "number") && (
          <div className="mb-3">
            <button
              type="button"
              onClick={() => setShowPerf((v) => !v)}
              className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon name="activity" size={15} className="text-primary" />
                性能分析
                <span className="text-xs font-normal text-muted-foreground">{perfSummaryLine(entries)}</span>
              </span>
              <Icon
                name="arrowUp"
                size={16}
                className={`shrink-0 text-muted-foreground transition-transform ${showPerf ? "rotate-180" : ""}`}
              />
            </button>
            {showPerf && (
              <div className="mt-2">
                <PerfCharts entries={entries} />
              </div>
            )}
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="relative flex h-52 items-center justify-center">
            {/* 大号半透明背景图标 */}
            <Icon name="log" size={96} className="absolute opacity-[0.06] pointer-events-none" />
            <div className="relative z-[1] flex flex-col items-center gap-2 text-center">
              <Icon name={entries?.length === 0 ? "file" : "search"} size={28} className="text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground max-w-[320px]">
                {entries?.length === 0
                  ? "暂无审计记录，远程 Claude Code 连接后操作记录将显示在这里。"
                  : "没有匹配的记录，试试调整筛选条件。"}
              </p>
            </div>
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
                    className={`cursor-pointer ${
                      entry.success
                        ? i % 2 === 0 ? "bg-muted/20" : ""
                        : "bg-destructive/5 log-err"
                    }`}
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
                      {entry.durationMs != null ? formatDurationMs(entry.durationMs) : "—"}
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
                        <DetailPanel
                          entry={entry}
                          onViewDiff={setDiffEntry}
                          onRestore={setRestoreEntry}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
        {total > 0 && (
          <AuditPager
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={handlePageSizeChange}
          />
        )}
      </CardContent>

      {confirmClear && (
        <ConfirmDialog
          title="确定清空全部审计日志？"
          description={
            <>
              此操作会删除本机所有历史调用记录，且<b>不可恢复</b>。
            </>
          }
          variant="destructive"
          confirmLabel="确定清空"
          onCancel={() => setConfirmClear(false)}
          onConfirm={handleClear}
        />
      )}
      {diffEntry && <DiffModal entry={diffEntry} onClose={() => setDiffEntry(null)} />}
      {restoreEntry && (
        <RestoreConfirmDialog entry={restoreEntry} onClose={() => setRestoreEntry(null)} />
      )}
    </Card>
  );
}
