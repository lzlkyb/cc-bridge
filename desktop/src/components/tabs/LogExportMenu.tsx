import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/tauri";
import { toolLabel, formatDurationMs, formatVersion, copyText } from "../../lib/utils";
import { APP_INFO } from "../../lib/about";
import type { AuditEntry, StatusResponse } from "../../lib/types";
import { useToast } from "../ui/toast";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { perfSummaryLine } from "../../lib/logFormat";

interface LogExportMenuProps {
  /** 当前筛选结果（导出范围）。空数组时菜单项整体 disabled。 */
  filtered: AuditEntry[];
  /** 当前页未筛选条数（诊断报告里「本页 N / 总计 M」用）。 */
  entriesCount: number;
  total: number;
}

interface ExportItem {
  key: string;
  label: string;
  icon: "file" | "download" | "activity";
  run: () => void | Promise<void>;
}

/**
 * 审计日志导出下拉（受控）。
 *
 * 原实现是 hover-only 浮层（CSS group-hover），键盘完全不可达、鼠标用户也未必
 * 发现「导出 JSON 主按钮下面还藏着两个格式」（impeccable critique P1）。改成
 * 受控下拉：触发器 aria-haspopup/aria-expanded，浮层 role=menu，↑/↓ 移动高亮、
 * Enter 确认、Esc 关闭并归还焦点；与原「独立导出 JSON 按钮」合并为菜单第一项。
 *
 * 导出逻辑（JSON/CSV/诊断报告）从 LogTab 整体迁入——它们只为这个菜单服务，
 * 搬走后 LogTab 才能落回体量上限内（棘轮 487 只许变小）。
 */
export function LogExportMenu({ filtered, entriesCount, total }: LogExportMenuProps) {
  const [open, setOpen] = useState(false);
  /** 键盘高亮项（↑/↓ 移动，Enter 确认）。-1 = 无高亮。 */
  const [activeIdx, setActiveIdx] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const empty = filtered.length === 0;
  const disabledTitle = "当前没有可导出的日志";

  const handleExport = (format: "json" | "csv" = "json") => {
    if (empty) {
      toast("当前没有可导出的日志", "info");
      return;
    }
    try {
      if (format === "csv") {
        const header = "时间,工具,工具名,参数,来源IP,耗时(ms),状态,错误\n";
        const rows = filtered.map((e) => {
          const esc = (s: string) => {
            const v = String(s ?? "");
            const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
            return `"${guarded.replace(/"/g, '""')}"`;
          };
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
      // 与「导出诊断报告」对齐：导出要有成功反馈，否则瞬间下完时不知道导没导出。
      toast(`已导出 ${filtered.length} 条审计日志（${format.toUpperCase()}）`, "success");
    } catch (e) {
      toast(`导出失败：${String(e)}`, "error");
    }
  };

  // O3：导出诊断报告——基于已有的日志聚合拼 Markdown（版本 + 性能摘要 + 按工具耗时 + 错误列表），
  // 下载为 .md 文件同时复制到剪贴板，方便直接粘进 issue/反馈。LogTab 不持有 status，这里 invoke 一次拿版本。
  const handleExportDiagnostic = async () => {
    if (empty) return;
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
        `# ${APP_INFO.name} 诊断报告`,
        "",
        `- 版本：${formatVersion(status?.version)}`,
        `- 导出时间：${new Date().toLocaleString()}`,
        `- 范围：当前筛选结果 ${filtered.length} 条（本页 ${entriesCount} / 总计 ${total}）`,
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

  // 展开期：点击外部关闭（捕获阶段，与 ui/Menu 同款）+ ↑/↓/Enter/Esc 键盘导航。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
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
  }, [open, activeIdx, empty]);

  return (
    <div ref={boxRef} className="relative">
      <Button
        variant="outline"
        size="sm"
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
          className="absolute right-0 top-full z-20 mt-1 flex min-w-[190px] flex-col rounded-md border bg-popover p-1 shadow-pop"
        >
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
