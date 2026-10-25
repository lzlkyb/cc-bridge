import { useMemo, useState } from "react";
import { Icon } from "../ui/icon";
import type { CcPaneEntry } from "../../hooks/useCcPaneList";
import { useSidebarWidth } from "../../hooks/useSidebarWidth";
import { RailItem, SessionRow, rowOf, type SessionRowData } from "./SessionSidebarRow";

/** 会话数达到这个量才显示搜索框（与终端侧栏同一条阈值）。 */
const SEARCH_THRESHOLD = 6;

type Props = {
  entries: CcPaneEntry[];
  active: string;
  collapsed: boolean;
  targets: { id: string; label: string }[];
  onToggleCollapsed: () => void;
  onPick: (key: string) => void;
  onNew: () => void;
  onClose: (key: string) => void;
};

/**
 * 对话页左侧会话栏（按 `design/对话页多会话侧栏-2026-10-24.html` 实现）。
 *
 * 骨架抄终端侧栏：240px / 可拖 180–360 / 折叠成 48px rail / ≥6 条才出搜索 /
 * 分组头 + 状态点。内容换成「会话」。行与 rail 方块在 `SessionSidebarRow`。
 *
 * ## 分组为什么按「目标」而不是按「项目目录」
 *
 * 目标（本机 / 某台 SSH）是**权限与失败面**的边界：一条会话在本机跑还是远端跑，
 * 决定了它能改哪台机器上的文件。目录只是它的属性，换目录不换目标。CC Desktop
 * 的侧栏也是按环境分组。
 */
export function SessionSidebar({
  entries,
  active,
  collapsed,
  targets,
  onToggleCollapsed,
  onPick,
  onNew,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const sizing = useSidebarWidth("cc-bridge.cc-sidebar-width");
  const width = collapsed ? 48 : sizing.width;

  const rows: SessionRowData[] = useMemo(
    () =>
      entries.map((e) => {
        const label =
          targets.find((t) => t.id === (e.meta?.connectionId ?? ""))?.label ??
          e.meta?.targetLabel ??
          "本机";
        return rowOf(e, label);
      }),
    [entries, targets],
  );

  const showSearch = !collapsed && rows.length >= SEARCH_THRESHOLD;
  const shown = useMemo(() => {
    const k = query.trim().toLowerCase();
    if (!k || !showSearch) return rows;
    return rows.filter(
      (r) => r.title.toLowerCase().includes(k) || r.detail.toLowerCase().includes(k),
    );
  }, [rows, query, showSearch]);

  /** 按目标分组，组顺序 = 首次出现顺序（本机通常在最前，因为它最先被用到）。 */
  const groups = useMemo(() => {
    const out: { label: string; rows: SessionRowData[] }[] = [];
    for (const r of shown) {
      const g = out.find((x) => x.label === r.label);
      if (g) g.rows.push(r);
      else out.push({ label: r.label, rows: [r] });
    }
    return out;
  }, [shown]);

  const live = (r: SessionRowData) =>
    r.state === "run" || r.state === "ask" || r.state === "wait";
  const runningCount = rows.filter(live).length;
  const canClose = rows.length > 1;

  return (
    <div
      data-cc-session-side
      className="relative flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-card transition-[width] duration-200 ease-[var(--ease)]"
      style={{ width }}
    >
      {!collapsed && (
        <button
          type="button"
          role="separator"
          aria-label="调整会话列表宽度"
          aria-orientation="vertical"
          aria-valuemin={180}
          aria-valuemax={360}
          aria-valuenow={sizing.width}
          title="拖动调宽；方向键微调，双击恢复"
          onPointerDown={sizing.start}
          onPointerMove={sizing.move}
          onPointerUp={sizing.end}
          onPointerCancel={sizing.end}
          onDoubleClick={() => sizing.resize(240)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              sizing.resize(sizing.width + (e.key === "ArrowLeft" ? -10 : 10));
            }
          }}
          className="cc-session-resizer"
        />
      )}
      {/* 固定宽 inner：外层 transition 宽度时 inner 不重排，被 overflow-hidden 裁切做擦除动画。 */}
      <div className="flex h-full flex-col" style={{ width }}>
        {collapsed ? (
          <div className="flex h-full flex-col items-center gap-1.5 overflow-y-auto py-2">
            <button
              type="button"
              onClick={onToggleCollapsed}
              title="展开会话列表 (Ctrl/Cmd+Shift+B)"
              aria-label="展开会话列表"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Icon name="chevronLeft" size={16} style={{ transform: "rotate(180deg)" }} />
            </button>
            <div className="h-px w-6 shrink-0 bg-border" />
            {rows.map((r) => (
              <RailItem key={r.key} row={r} active={r.key === active} onPick={onPick} />
            ))}
          </div>
        ) : (
          <>
            <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border pl-3 pr-2">
              <span className="flex-1 truncate text-xs font-semibold">对话</span>
              <button
                type="button"
                onClick={onNew}
                title="新建对话 (Ctrl/Cmd+N)"
                aria-label="新建对话"
                className="flex h-7 w-7 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary transition-colors hover:bg-primary/15"
              >
                <Icon name="plus" size={13} />
              </button>
              <button
                type="button"
                onClick={onToggleCollapsed}
                title="收起会话列表 (Ctrl/Cmd+Shift+B)"
                aria-label="收起会话列表"
                className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Icon name="chevronLeft" size={14} />
              </button>
            </div>

            {showSearch && (
              <div className="shrink-0 border-b border-border px-2 py-1.5">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`搜索 ${rows.length} 个会话（标题 / 状态）`}
                  aria-label="搜索会话"
                  className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
                />
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
              {groups.length === 0 && (
                <p className="p-3 text-center text-xs text-muted-foreground">没有匹配的会话</p>
              )}
              {groups.map((g) => (
                <div key={g.label}>
                  <div className="sticky top-0 z-[1] flex h-[26px] items-center gap-1.5 bg-card/95 px-1.5 text-[10.5px] text-muted-foreground backdrop-blur-[2px]">
                    <span className="flex-1 truncate font-medium">{g.label}</span>
                    <span className="tabular-nums">{g.rows.filter(live).length} 在跑</span>
                  </div>
                  {g.rows.map((r) => (
                    <SessionRow
                      key={r.key}
                      row={r}
                      active={r.key === active}
                      canClose={canClose}
                      onPick={onPick}
                      onClose={onClose}
                    />
                  ))}
                </div>
              ))}
            </div>

            <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-1.5 text-[10.5px] text-muted-foreground tabular-nums">
              <span
                className={`h-1.5 w-1.5 rounded-full ${runningCount > 0 ? "bg-success" : "bg-muted-foreground/40"}`}
              />
              {runningCount} 个在跑 · 共 {rows.length} 个
            </div>
          </>
        )}
      </div>
    </div>
  );
}
