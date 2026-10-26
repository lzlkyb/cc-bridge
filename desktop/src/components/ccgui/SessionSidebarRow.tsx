import { useState } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icon";
import type { CcPaneMeta, CcPaneState } from "../../lib/ccPaneMeta";
import type { CcPaneEntry } from "../../hooks/useCcPaneList";
import { SessionRowMenu } from "./SessionRowMenu";

/** 侧栏一行（`CcPaneEntry` + 派生出来的四段文字）。 */
export type SessionRowData = CcPaneEntry & {
  title: string;
  detail: string;
  state: CcPaneState;
  label: string;
};

/** 五态 → 圆点样式。填充 / 描边 / dash 三种形态，不只靠颜色区分（色弱也读得出）。 */
export const DOT_CLASS: Record<CcPaneState, string> = {
  run: "bg-success shadow-[0_0_0_3px_hsl(var(--success)/.16)]",
  ask: "bg-warning shadow-[0_0_0_3px_hsl(var(--warning)/.16)]",
  wait: "border-[1.5px] border-primary bg-transparent",
  idle: "bg-muted-foreground/40",
  dead: "border-[1.5px] border-dashed border-muted-foreground/60 bg-transparent",
};

/** 五态 → hover 提示（圆点太小，光看颜色分不清「等审批」和「等你选」）。 */
export const STATE_HINT: Record<CcPaneState, string> = {
  run: "生成中",
  ask: "等你批准",
  wait: "等你选",
  idle: "空闲",
  dead: "连接已断",
};

/** 行数据的公共部分：一条 entry + 它的 meta（还没有 meta 时给保守默认）。 */
export function rowOf(entry: CcPaneEntry, label: string): SessionRowData {
  const meta: CcPaneMeta | null = entry.meta;
  return {
    ...entry,
    title: meta?.title ?? "新对话",
    detail: meta?.detail ?? "新会话",
    state: meta?.state ?? "idle",
    label,
  };
}

/**
 * 展开态的一行：状态点 + 标题 + 副标题 + hover 才出现的「⋯」与关闭键。
 *
 * 关闭键是**单一动作**，所以不塞进菜单：为了关掉一条会话点两次没必要。
 * 重命名 / 归档在「⋯」里（3-1d），行内不再挂第二个常驻按钮 —— 240px 宽的一行
 * 塞两个图标加正文，标题只剩十来个字。
 */
export function SessionRow({
  row,
  active,
  canClose,
  archivedRows,
  onPick,
  onClose,
  onRename,
  onArchive,
}: {
  row: SessionRowData;
  active: boolean;
  canClose: boolean;
  /** 本窗口归档过的行号（打开着的行不在库里查归档态，靠这份本地账）。 */
  archivedRows: Record<number, boolean>;
  onPick: (key: string) => void;
  onClose: (key: string) => void;
  onRename: (rowId: number, title: string) => Promise<unknown>;
  onArchive: (rowId: number, archived: boolean) => Promise<unknown>;
}) {
  const rowId = row.meta?.rowId ?? null;
  const [confirming, setConfirming] = useState(false);
  // 生成中 / 等批准 / 等选择的会话：一次误点 × 就会中断一轮任务或作废一条待答请求，关前必须确认。
  // 空闲 / 已断开的直接关（内容都在历史里，没有什么可丢）。
  const busyState = row.state === "run" || row.state === "ask" || row.state === "wait";
  return (
    <>
    <div
      data-active={active || undefined}
      data-dead={row.state === "dead" || undefined}
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      className={`group relative flex cursor-pointer items-start gap-[7px] rounded-lg py-1.5 pl-2.5 pr-1.5 transition-colors hover:bg-foreground/[.045] ${
        active ? "bg-primary/[.085]" : ""
      } ${row.state === "dead" ? "opacity-55" : ""}`}
      onClick={() => onPick(row.key)}
      onKeyDown={(e) => {
        // 只接管行自己的键：内部的「⋯」「×」按钮有自己的 Enter / Space，不能被行拦走。
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(row.key);
        }
      }}
    >
      {active && <span className="absolute bottom-1.5 left-0.5 top-1.5 w-0.5 rounded bg-primary" />}
      <span
        title={row.meta?.stateHint ?? STATE_HINT[row.state]}
        aria-label={row.meta?.stateHint ?? STATE_HINT[row.state]}
        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[row.state]}`}
      />
      <div className="min-w-0 flex-1">
        <div
          className={`flex items-center gap-1 text-xs leading-[1.35] ${active ? "font-semibold" : "font-normal"}`}
        >
          <span className="truncate">{row.title}</span>
          {row.forkOf && (
            <span
              title="从另一条会话分叉出来（原会话仍在）"
              className="shrink-0 rounded border border-border px-1 text-[10px] leading-[1.4] text-muted-foreground"
            >
              分叉
            </span>
          )}
        </div>
        <div className="mt-px truncate text-[11px] leading-[1.4] text-muted-foreground tabular-nums">
          {row.detail}
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        <SessionRowMenu
          rowId={rowId}
          title={row.title}
          archived={rowId !== null && archivedRows[rowId] === true}
          onRename={onRename}
          onArchive={onArchive}
        />
        {canClose && (
          <button
            type="button"
            title="关闭会话（内容仍在历史里）"
            aria-label={`关闭会话：${row.title}`}
            onClick={(e) => {
              e.stopPropagation();
              if (busyState) setConfirming(true);
              else onClose(row.key);
            }}
            // focus-visible:opacity-100：键盘 Tab 到这里时必须看得见；h-6 w-6 = 24px 点击目标下限。
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/[.07] focus-visible:opacity-100 group-hover:opacity-100 data-[active]:opacity-100"
            data-active={active || undefined}
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
    </div>
    {confirming && (
      <ConfirmDialog
        title="关闭这条会话？"
        variant="destructive"
        confirmLabel="关闭会话"
        description={
          row.state === "run"
            ? `「${row.title}」正在生成，关闭会中断这一轮。对话内容仍保留在历史里。`
            : `「${row.title}」正在等你${row.state === "ask" ? "批准" : "选择"}，关闭后这条请求作废。对话内容仍保留在历史里。`
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onClose(row.key);
        }}
      />
    )}
    </>
  );
}

/** 折叠 rail 里的一个方块：首字 + 右上状态点。 */
export function RailItem({
  row,
  active,
  onPick,
}: {
  row: SessionRowData;
  active: boolean;
  onPick: (key: string) => void;
}) {
  const initial = row.title.trim().charAt(0).toUpperCase() || "?";
  return (
    <button
      type="button"
      title={`${row.title} · ${row.detail}`}
      onClick={() => onPick(row.key)}
      className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-muted ${
        active ? "bg-primary/15 text-primary" : ""
      }`}
    >
      {initial}
      <span
        className={`absolute right-1 top-1 h-[7px] w-[7px] rounded-full ${DOT_CLASS[row.state]}`}
      />
    </button>
  );
}
