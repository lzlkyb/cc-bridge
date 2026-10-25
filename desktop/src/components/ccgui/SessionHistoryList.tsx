import { useState } from "react";
import type { CcStoredSummary } from "../../lib/ccEventTypes";
import { agoText } from "../../lib/ccStoredList";
import { Icon } from "../ui/icon";
import { SessionRowMenu } from "./SessionRowMenu";

/** 默认摆几条。一屏 12 行左右，给「已打开」留一半，历史先露 5 条。 */
const PAGE = 5;

/**
 * 侧栏的「历史」区：库里落盘过、但当前没打开的会话。
 *
 * 与主列表的区别只有一条 —— **它们没有活着的进程**：点一下才载入（新开一条
 * pane，见 `useCcPaneList.openStored`）。所以这一区没有状态点、没有关闭键，
 * 副标题写的是「哪个目标 · 几轮 · 多久以前」，而不是「正在干什么」。
 *
 * 为什么默认只露 5 条：历史会一直涨（`KEEP_SESSIONS` 100 条），全摆出来会把
 * 「已打开的那几条」挤到看不见 —— 而后者才是用户此刻要操作的对象。
 *
 * 3-1d 起这一区还承载「已归档」：同一个组件换 `archived` 就变成归档视图
 * （标题变「已归档」、每行菜单项变「取消归档」）。共用一套渲染而不是两个
 * 组件，是因为两者的差别只有标题和副标题 —— 复制一份必然漂。
 */
export function SessionHistoryList({
  rows,
  targets,
  archived = false,
  onOpen,
  onRename,
  onArchive,
}: {
  /** 已过滤好的历史（见 `filterStored` / `archivedOnly`）。`[]` = 不渲染整区。 */
  rows: CcStoredSummary[];
  targets: { id: string; label: string }[];
  /** 摆的是「已归档」那一档（3-1d）。 */
  archived?: boolean;
  onOpen: (rowId: number) => void;
  onRename: (rowId: number, title: string) => Promise<unknown>;
  onArchive: (rowId: number, archived: boolean) => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;
  const shown = expanded ? rows : rows.slice(0, PAGE);
  const rest = rows.length - shown.length;

  const labelOf = (id: string) =>
    targets.find((t) => t.id === (id ?? ""))?.label ?? (id ? id : "本机");

  return (
    <div>
      <div className="sticky top-0 z-[1] flex h-[26px] items-center gap-1.5 bg-card/95 px-1.5 text-[10.5px] text-muted-foreground backdrop-blur-[2px]">
        <span className="flex-1 truncate font-medium">{archived ? "已归档" : "历史"}</span>
        <span className="tabular-nums">{rows.length} 条</span>
      </div>
      {shown.map((r) => (
        // 外层用 div 而不是 button：行内要嵌「⋯」菜单，button 里套 button 是非法的。
        <div
          key={r.rowId}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(r.rowId)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen(r.rowId);
            }
          }}
          title={`打开这条${archived ? "已归档" : "历史"}会话（${labelOf(r.connectionId)}${r.cwd ? ` · ${r.cwd}` : ""}）`}
          className="group flex w-full cursor-pointer items-start gap-[7px] rounded-lg py-1.5 pl-2.5 pr-1.5 text-left transition-colors hover:bg-foreground/[.045]"
        >
          <Icon
            name={archived ? "package" : "clock"}
            size={11}
            className="mt-[3px] shrink-0 text-muted-foreground/70"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-normal leading-[1.35]">
              {r.title || "（无标题）"}
            </span>
            <span className="mt-px block truncate text-[10.5px] leading-[1.4] text-muted-foreground tabular-nums">
              {labelOf(r.connectionId)} · {r.messageCount} 轮 · {agoText(r.updatedAt)}
            </span>
          </span>
          <SessionRowMenu
            rowId={r.rowId}
            title={r.title || "（无标题）"}
            archived={archived}
            onRename={onRename}
            onArchive={onArchive}
          />
        </div>
      ))}
      {rest > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mb-1 w-full rounded-md py-1 text-center text-[10.5px] text-muted-foreground transition-colors hover:bg-foreground/[.045] hover:text-foreground"
        >
          展开其余 {rest} 条
        </button>
      )}
    </div>
  );
}
