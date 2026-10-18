import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { toolLabel, formatDurationMs, formatVersion, copyText } from "../../lib/utils";
import { APP_INFO } from "../../lib/about";
import type { AuditFilter } from "../../lib/auditQuery";
import type { AuditEntry, StatusResponse } from "../../lib/types";
import { useToast } from "../ui/toast";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { perfSummaryLine } from "../../lib/logFormat";
import { useViewActive } from "../../lib/viewActivity";

interface LogExportMenuProps {
  /** 当前筛选结果（导出范围）。空数组时菜单项整体 disabled。 */
  filtered: AuditEntry[];
  /** 当前页未筛选条数（诊断报告里「本页 N / 总计 M」用）。 */
  entriesCount: number;
  total: number;
  filter: AuditFilter;
  pending: boolean;
}

interface ExportItem {
  key: string;
  label: string;
  icon: "file" | "download" | "activity";
  run: () => void | Promise<void>;
}

/** 导出范围由用户明确选择；全部/匹配结果从后端一次快照读取。 */
export function LogExportMenu({ filtered, entriesCount, total, filter, pending }: LogExportMenuProps) {
  const [open, setOpen] = useState(false);
  const active = useViewActive();
  const [scope, setScope] = useState("page");
  const [busy, setBusy] = useState(false);
  /** 键盘高亮项（↑/↓ 移动，Enter 确认）。-1 = 无高亮。 */
  const [activeIdx, setActiveIdx] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const empty = pending || busy || (scope === "page" ? filtered.length === 0 : scope === "results" && total === 0);
  const scopeLabel = scope === "page" ? `当前页 ${filtered.length} 条` : scope === "results" ? `匹配结果 ${total} 条` : "全部历史（忽略筛选）";
  const loadEntries = () => scope === "page" ? Promise.resolve(filtered) : invoke<AuditEntry[]>("get_audit_export", { filter: scope === "results" ? filter : null });
  const disabledTitle = "当前没有可导出的日志";

  const handleExport = async (format: "json" | "csv" = "json") => {
    if (empty) {
      toast("当前没有可导出的日志", "info");
      return;
    }
    setBusy(true);
    try {
      const filtered = await loadEntries();
      // 🔴 不能只看 `empty`（审查 U6）：「全部历史」这一档的范围是运行时才知道的，
      // 菜单项永远是可点的。原实现会把空数组导出成一个 0 行 CSV 再提示「已导出 0 条」，
      // 用户打开是一张空表。这里改为真加载后判空、直接取消并说明原因。
      if (filtered.length === 0) {
        toast("所选范围内没有日志，已取消导出", "info");
        return;
      }
      if (format === "csv") {
        const header = "时间,工具,工具名,参数,来源IP,耗时(ms),状态,错误\n";
        // 统一转义**所有**列（审查 U6）：原来只对 params / error 做 esc，
        // 其余列裸拼——含逗号或引号时整行错列，审计记录在 Excel 里串位。
        // 顺带做公式注入防护（= + - @ 开头加单引号）。
        const cell = (v: string | number | undefined | null) => {
          const raw = v === undefined || v === null ? "" : String(v);
          const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
          return `"${guarded.replace(/"/g, '""')}"`;
        };
        const rows = filtered
          .map((e) =>
            [
              cell(e.timestamp),
              cell(e.tool),
              cell(toolLabel(e.tool)),
              cell(e.params),
              cell(e.sourceIp ?? ""),
              cell(e.durationMs ?? ""),
              cell(e.success ? "成功" : "失败"),
              cell(e.error ?? ""),
            ].join(","),
          )
          .join("\n");
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
      // 与「导出诊断报告」对齐：导出要有成功反馈，否则瞬间下完时不知道导没导出。
      toast(`已导出 ${filtered.length} 条审计日志（${format.toUpperCase()}）`, "success");
    } catch (e) {
      toast(`导出失败：${String(e)}`, "error");
    } finally { setBusy(false); }
  };

  // O3：导出诊断报告——基于已有的日志聚合拼 Markdown（版本 + 性能摘要 + 按工具耗时 + 错误列表），
  // 下载为 .md 文件同时复制到剪贴板，方便直接粘进 issue/反馈。LogTab 不持有 status，这里 invoke 一次拿版本。
  const handleExportDiagnostic = async () => {
    if (empty) return;
    setBusy(true);
    try {
      const filtered = await loadEntries();
      if (filtered.length === 0) {
        toast("所选范围内没有日志，已取消导出", "info");
        return;
      }
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
        `# ${APP_INFO.name} 诊断报告`,
        "",
        `- 版本：${formatVersion(status?.version)}`,
        `- 导出时间：${new Date().toLocaleString()}`,
        `- 范围：${scopeLabel}，实际导出 ${filtered.length} 条（本页 ${entriesCount} / 匹配 ${total}）`,
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
    } finally { setBusy(false); }
  };

  const items: ExportItem[] = [
    { key: "json", label: "导出 JSON", icon: "file", run: () => handleExport("json") },
    { key: "csv", label: "导出 CSV (Excel)", icon: "download", run: () => handleExport("csv") },
    { key: "md", label: "导出诊断报告 (Markdown)", icon: "activity", run: () => void handleExportDiagnostic() },
  ];
  // 键盘 effect 通过 ref 读 items：菜单项随渲染重建，不进 effect 依赖
  // （否则 exhaustive-deps 要么每次重订阅，要么压规则）。
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const close = (refocus = false) => {
    setOpen(false);
    setActiveIdx(-1);
    // Esc 关闭后焦点归还触发器（a11y）。Button 不转发 ref，从容器查触发按钮。
    if (refocus) boxRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  };

  useEffect(() => {
    if (!active) { setOpen(false); setActiveIdx(-1); }
  }, [active]);

  // 保活的隐藏页面必须解绑捕获监听，避免拦截其他页面按键或触发隐藏导出。
  useEffect(() => {
    if (!open || !active) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement) return;
      const list = itemsRef.current;
      if (e.key === "Escape") {
        e.stopPropagation(); // 别让同一下 Esc 顺手关掉底下的弹窗
        close(true);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => {
          const step = e.key === "ArrowDown" ? 1 : -1;
          return ((i + step) % list.length + list.length) % list.length; // 循环
        });
      } else if (e.key === "Enter" && activeIdx >= 0 && !empty) {
        e.preventDefault();
        const item = list[activeIdx];
        close();
        void item?.run();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, activeIdx, empty, active]);

  return (
    <div ref={boxRef} className="relative">
      <Button
        variant="outline"
        size="sm"
        disabled={pending || busy}
        aria-busy={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => {
            if (!v) setActiveIdx(empty ? -1 : 0); // 展开即高亮第一项，Enter 直达
            return !v;
          });
        }}
      >
        <Icon name="download" size={14} />
        导出
        <Icon name="chevronDown" size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </Button>
      {open && (
        <div
          role="menu"
          className="animate-scale-in absolute right-0 top-full z-20 mt-1 flex min-w-[190px] origin-top-right flex-col rounded-md border bg-popover p-1 shadow-pop"
        >
          <label className="mb-1 border-b px-2 py-2 text-xs text-muted-foreground">导出范围
            <select aria-label="导出范围" className="mt-1 w-full rounded border bg-popover p-1.5 text-xs text-foreground" value={scope} onChange={e => setScope(e.target.value)}>
              <option value="page">当前页 · {filtered.length} 条</option><option value="results">当前筛选结果 · {total} 条</option><option value="all">全部历史（忽略筛选）</option>
            </select>
          </label>
          {items.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              aria-disabled={empty}
              title={empty ? disabledTitle : undefined}
              disabled={empty}
              onClick={() => {
                close();
                void item.run();
              }}
              className={`flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                i === activeIdx ? "bg-accent text-primary" : "hover:bg-accent"
              }`}
            >
              <Icon name={item.icon} size={12} />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
