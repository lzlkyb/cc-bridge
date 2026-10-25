import { Icon } from "../ui/icon";
import type { CcPaneMeta, CcPaneState } from "../../lib/ccPaneMeta";
import type { CcPaneEntry } from "../../hooks/useCcPaneList";

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
 * 展开态的一行：状态点 + 标题 + 副标题 + hover 才出现的关闭键。
 *
 * 关闭键只有一个动作、没有菜单：设计稿那个「更多」菜单里另有重命名/归档两项，
 * 而那两项还没做（能力对齐表「重命名 / 归档：期三未做」）。只剩一个动作时套
 * 菜单等于让用户为了关掉一条点两次。
 */
export function SessionRow({
  row,
  active,
  canClose,
  onPick,
  onClose,
}: {
  row: SessionRowData;
  active: boolean;
  canClose: boolean;
  onPick: (key: string) => void;
  onClose: (key: string) => void;
}) {
  return (
    <div
      data-active={active || undefined}
      data-dead={row.state === "dead" || undefined}
      className={`group relative flex cursor-pointer items-start gap-[7px] rounded-lg py-1.5 pl-2.5 pr-1.5 transition-colors hover:bg-foreground/[.045] ${
        active ? "bg-primary/[.085]" : ""
      } ${row.state === "dead" ? "opacity-55" : ""}`}
      onClick={() => onPick(row.key)}
    >
      {active && <span className="absolute bottom-1.5 left-0.5 top-1.5 w-0.5 rounded bg-primary" />}
      <span
        title={STATE_HINT[row.state]}
        aria-label={STATE_HINT[row.state]}
        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[row.state]}`}
      />
      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-xs leading-[1.35] ${active ? "font-semibold" : "font-normal"}`}
        >
          {row.title}
        </div>
        <div className="mt-px truncate text-[10.5px] leading-[1.4] text-muted-foreground tabular-nums">
          {row.detail}
        </div>
      </div>
      {canClose && (
        <button
          type="button"
          title="关闭会话（内容仍在历史里）"
          aria-label={`关闭会话：${row.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose(row.key);
          }}
          className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/[.07] group-hover:opacity-100 data-[active]:opacity-100"
          data-active={active || undefined}
        >
          <Icon name="close" size={11} />
        </button>
      )}
    </div>
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
