import { useState, useEffect, useRef, memo } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { toolLabel } from "../../lib/utils";
import type { AuditEntry, AuditPage } from "../../lib/types";
import { useToast } from "../ui/toast";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { EmptyState } from "../ui/EmptyState";
import { Table, TableHeader, TableBody, TableRow, TableHead } from "../ui/table";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import { useAuditLog } from "../../hooks/useAuditLog";
import { Collapse } from "../ui/Collapse";
import { useSlashFocus } from "../../hooks/useSlashFocus";
import { Combobox } from "../ui/combobox";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PerfCharts } from "./PerfCharts";
import { AuditPager } from "./AuditPager";
import { LogRow } from "./LogRow";
import { LogExportMenu } from "./LogExportMenu";
import { LogDiffModal } from "./LogDiffModal";
import { LogRestoreDialog } from "./LogRestoreDialog";
import { auditRowKey, perfSummaryLine } from "../../lib/logFormat";

function LogTabImpl({
  highlightAnchor,
}: {
  /**
   * 跳转锚点。与设置页 / Header 安全徽章同一套机制（App 的 `pendingAnchor`）。
   *
   * 本页目前只认 `"perf"`：展开性能分析面板并滚到它。
   * 为何复用 anchor 而不新加一个 `openPerf` props：App 已经在维护 `pendingAnchor`，
   * 再开一条平行管线会出现两套“跳转意图”要同步。
   */
  highlightAnchor?: { anchor: string; nonce: number } | null;
}) {
  const audit = useAuditLog();
  const { page, pageSize, search, setSearch, setPage, setToolFilter, setStatusFilter, resetFilters, appHidden } = audit;
  const pageData = audit.data, refetch = audit.refetch;
  const toolFilter = audit.tool, statusFilter = audit.status;
  const entries = pageData?.entries ?? [], total = pageData?.total ?? 0;
  const toolNames = pageData?.toolNames ?? [];
  // 展开行的稳定标识（timestamp-tool-sourceIp，见 auditRowKey）：10s 轮询重拉
  // 数据后按 key 重认领，展开态不再静默收起。
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showPerf, setShowPerf] = useState(false);
  const perfBtnRef = useRef<HTMLButtonElement>(null);

  // 深链到性能面板：连接页的「P95 延迟」卡点击后跳这里。
  // 依赖 nonce 而不是 anchor：同一个锚点连点两次也要再触发一次（anchor 不变，nonce 变）。
  useEffect(() => {
    if (appHidden || highlightAnchor?.anchor !== "perf") return;
    setShowPerf(true);
    // rAF 等展开后的布局落定再滚，否则滚到的是展开前的位置。
    requestAnimationFrame(() => {
      perfBtnRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
    });
  }, [highlightAnchor?.anchor, highlightAnchor?.nonce, appHidden]);

  // 性能分析面板独立拉取最近 500 条（后端 page_size 上限），避免统计口径只覆盖当前分页页。
  // 仅在面板展开时启用，关闭时不轮询、不占用请求。
  const { data: perfPage } = useQuery<AuditPage>({
    queryKey: ["auditLogPerf"],
    queryFn: () => invoke<AuditPage>("get_audit_log", { page: 1, page_size: 500 }),
    enabled: showPerf && !appHidden,
    refetchInterval: appHidden ? false : 30000,
  });
  const perfEntries = perfPage?.entries ?? entries;
  // 一键回滚 / 变更 Diff 的弹窗状态（指向被点击的审计条目）。
  const [diffEntry, setDiffEntry] = useState<AuditEntry | null>(null);
  const [restoreEntry, setRestoreEntry] = useState<AuditEntry | null>(null);
  const { toast } = useToast();
  // 审计列表增删/筛选/清空时 FLIP 平滑进出场（动画质感升级；减弱动效时自动关闭）。
  const auditBody = useAutoAnimateRM<HTMLTableSectionElement>();

  // `/` 聚焦搜索框；Esc 在框内清空并失焦（a11y，见 hooks/useSlashFocus）。
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef, () => setSearch(""));

  // 筛选是否生效（供 info chip 展示当前条件）。
  const hasFilter = !!toolFilter || statusFilter !== "all" || !!search.trim();
  const filterSummary = [
    toolFilter && `工具=${toolLabel(toolFilter)}`,
    statusFilter !== "all" && `状态=${statusFilter === "success" ? "成功" : "失败"}`,
    search.trim() && `关键词「${search.trim()}」`,
  ].filter(Boolean).join(" · ");

  const handlePageChange = setPage;
  const handlePageSizeChange = audit.setPageSize;

  const handleClear = async () => {
    // 之前无 try/catch：失败是 unhandled rejection，确认框关了日志却没清、界面毫无反应。
    try {
      await invoke("clear_audit_log");
      setConfirmClear(false);
      setPage(1);
      refetch();
      toast("审计日志已清空", "success");
    } catch (e) {
      toast(`清空失败：${String(e)}`, "error");
      setConfirmClear(false);
    }
  };

  const filtered = entries;

  return (
    <Card className="flex flex-col log-tab h-full min-h-0 overflow-hidden">
      <CardHeader className="flex-row items-center justify-between space-y-0 gap-3 flex-wrap">
        <CardTitle icon={<Icon name="log" />}>审计日志</CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search：aria-label 是给读屏的（placeholder 不算可访问名称）；`/` 快捷键见 useSlashFocus */}
          <div className="flex items-center gap-1.5 h-8 rounded-md bg-background px-2 transition-shadow focus-within:ring-2 focus-within:ring-ring">
            <Icon name="search" size={13} className="text-muted-foreground shrink-0" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="搜索全部历史日志"
              placeholder="搜索全部历史：工具 / 参数 / IP…"
              className="w-52 max-w-full bg-transparent text-xs outline-none log-search-input placeholder:text-muted-foreground"
            />
          </div>
          {/* Tool filter：选项来自独立查询的全量工具名（近 500 条去重） */}
          <Combobox
            value={toolFilter}
            ariaLabel="按工具筛选"
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
          {/* 导出（JSON/CSV/诊断报告）：受控下拉 + 键盘导航，实现见 LogExportMenu */}
          <LogExportMenu filtered={filtered} entriesCount={entries.length} total={total} filter={audit.filter} pending={audit.pending} />
          <Button
            variant="outline"
            size="sm"
            className="text-destructive-ink hover:text-destructive-ink"
            disabled={!entries || entries.length === 0}
            onClick={() => setConfirmClear(true)}
          >
            <Icon name="trash" size={14} />
            清空日志
          </Button>
        </div>
      </CardHeader>
      {/* 常驻说明（原在分页器里的 10.5px 灰字没人看见，上移到工具栏正下方） */}
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-primary/5 px-5 py-1.5 text-[11px] text-muted-foreground">
        <Icon name="info" size={12} className="shrink-0" />
        <span>{audit.pending ? "正在查询…" : `全部历史 · 匹配 ${total.toLocaleString()} 条`}</span>
        {hasFilter && <button type="button" className="ml-auto text-primary hover:underline" onClick={resetFilters}>重置筛选</button>}
        {hasFilter && <span className="text-foreground">当前：{filterSummary}</span>}
      </div>
      <CardContent className="flex flex-col flex-1 min-h-0 overflow-y-auto">
        {entries && entries.some((e) => typeof e.durationMs === "number") && (
          <div className="mb-3">
            <button
              type="button"
              id="log-perf"
              ref={perfBtnRef}
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
            <Collapse open={showPerf}><div className="mt-2"><p className="mb-2 text-xs text-muted-foreground">独立统计：最近最多 500 条记录，不随列表筛选变化。</p><PerfCharts entries={perfEntries} /></div></Collapse>
          </div>
        )}
        {audit.isError ? <div role="alert" className="py-8 text-sm text-destructive-ink">日志读取失败：{String(audit.error)} <button className="underline" onClick={() => void refetch()}>重试</button></div> : !pageData ? (
          <div className="space-y-1.5 py-2" aria-hidden="true">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="skel-row flex items-center gap-3 px-1">
                <div className="skel h-3 w-20 rounded bg-muted" />
                <div className="skel h-3 flex-1 rounded bg-muted" />
                <div className="skel h-3 w-24 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            className="h-52 empty"
            bigIconSize={96}
            iconSize={28}
            icon={entries?.length === 0 ? "file" : "search"}
            description={entries?.length === 0
              ? "暂无审计记录，远程 AI 工具连接后操作记录将显示在这里。"
              : "没有匹配的记录，试试调整筛选条件。"}
          />
        ) : (
          <Table className="table-fixed audit">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[74px]">时间</TableHead>
                <TableHead className="w-[124px]">操作</TableHead>
                <TableHead>参数摘要</TableHead>
                <TableHead className="w-[100px]">来源</TableHead>
                <TableHead className="w-[64px]">耗时</TableHead>
                <TableHead className="w-[64px]">状态</TableHead>
                <TableHead className="w-9">
                  <span className="sr-only">详情</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody ref={auditBody}>
              {filtered.map((entry, i) => (
                <LogRow
                  key={auditRowKey(entry)}
                  entry={entry}
                  index={i}
                  expanded={expandedRow === auditRowKey(entry)}
                  onToggle={() =>
                    setExpandedRow(expandedRow === auditRowKey(entry) ? null : auditRowKey(entry))
                  }
                  onViewDiff={setDiffEntry}
                  onRestore={setRestoreEntry}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {pageData && (
        <div className="shrink-0 border-t bg-card px-5 py-3">
          <AuditPager
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
          />
        </div>
      )}

      <ConfirmDialog open={confirmClear}
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
      {diffEntry && <LogDiffModal entry={diffEntry} onClose={() => setDiffEntry(null)} />}
      {restoreEntry && (
        <LogRestoreDialog entry={restoreEntry} onClose={() => setRestoreEntry(null)} />
      )}
    </Card>
  );
}

// E-P5/P6: 日志页不消费 status，用 memo 隔离 App.tsx 每 5s 状态轮询的父级级联重渲染，
// 仅自身 10s 审计轮询与用户操作触发本组件重渲染（消除双重轮询 + 整树空转重算）。
export const LogTab = memo(LogTabImpl);
