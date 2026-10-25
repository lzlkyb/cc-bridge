import { Fragment, type ReactNode } from "react";
import { Icon, type IconName } from "../ui/icon";
import type { PaletteMatch } from "../../lib/paletteSearch";

/** 面板条目（类型从 CommandPalette 移来：列表渲染与主文件都要用）。 */
export interface CommandItem {
  id: string;
  label: string;
  icon: IconName;
  group: string;
  shortcut?: string;
  tab?: string;
  /** 跳转后要定位+高亮的锚点（Header 安全徽章同一套 `highlightAnchor` 机制）。 */
  anchor?: string;
  /** 额外搜索词（不展示，只参与匹配）。 */
  keywords?: string;
  run?: () => void | boolean | Promise<void | boolean>;
  /** 不可逆/高风险操作，需先过 ConfirmDialog。 */
  confirmTitle?: string;
  confirmDescription?: string;
}

/** 平铺渲染条目：`match` 是检索结果，`displayGroup` 是它在这份列表里挂的组名
 *  （「最近使用」组的条目 displayGroup 被改写，但也会以原组名再出现一次）。 */
export type ListEntry = { match: PaletteMatch<CommandItem>; displayGroup: string };

/** 最近使用组的组名（置顶展示，带时钟角标）。 */
export const RECENT_GROUP = "最近使用";

/** label 按命中下标加亮（子串/子序列命中）。折叠不等长（İ 类）时放弃高亮，整串原样。 */
function LabelWithHits({ label, hits }: { label: string; hits: number[] }) {
  if (hits.length === 0 || label.toLowerCase().length !== label.length) return <>{label}</>;
  const set = new Set(hits);
  const parts: ReactNode[] = [];
  let buf = "";
  let inHit = false;
  for (let i = 0; i < label.length; i++) {
    const hit = set.has(i);
    if (hit === inHit) {
      buf += label[i];
    } else {
      parts.push(inHit ? <b key={parts.length} className="font-semibold text-primary">{buf}</b> : buf);
      buf = label[i];
      inHit = hit;
    }
  }
  parts.push(inHit ? <b key={parts.length} className="font-semibold text-primary">{buf}</b> : buf);
  return <>{parts}</>;
}

/** 拼音注音槽：命中音节加亮，其余 muted。只有拼音路命中才有（占 shortcut 槽位，不加宽）。 */
function PinyinHint({ pinyin }: { pinyin: NonNullable<PaletteMatch<CommandItem>["pinyin"]> }) {
  return (
    <span className="hidden shrink-0 truncate font-mono text-[10px] tracking-[0.02em] text-muted-foreground/75 sm:inline">
      {pinyin.syllables.map((s, i) => (
        <Fragment key={i}>
          {pinyin.hitIdx.includes(i) ? <b className="font-semibold text-primary">{s}</b> : s}{" "}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * 面板列表（从 CommandPalette 拆出，2026-10-25）：分组头 + 命中高亮 + 注音槽。
 * 键盘链路（↑↓/Enter）留在主文件 —— 这里只管把 `flat` 摆出来。
 */
export function CommandPaletteList({
  flat,
  selectedIndex,
  busyId,
  onSelect,
  onHover,
}: {
  flat: ListEntry[];
  selectedIndex: number;
  busyId: string | null;
  onSelect: (item: CommandItem) => void;
  onHover: (index: number) => void;
}) {
  let lastGroup = "";
  return (
    <>
      {flat.map(({ match, displayGroup }, i) => {
        const { item } = match;
        const showHeader = displayGroup !== lastGroup;
        lastGroup = displayGroup;
        const isBusy = busyId === item.id;
        return (
          <Fragment key={`${displayGroup}:${item.id}:${i}`}>
            {showHeader && (
              <div
                className="flex items-center gap-1.5 px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground pal-g"
                style={{ animationDelay: `${Math.min(i, 12) * 10}ms` }}
              >
                {displayGroup === RECENT_GROUP && <Icon name="clock" size={10} />}
                {displayGroup}
              </div>
            )}
            <button
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(i)}
              disabled={isBusy}
              style={{ animationDelay: `${Math.min(i, 12) * 10}ms` }}
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors disabled:opacity-60 pal-it ${
                i === selectedIndex ? "sel bg-accent text-accent-foreground" : "text-foreground hover:bg-muted/60"
              }`}
            >
              <Icon name={item.icon} size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">
                <LabelWithHits label={item.label} hits={match.labelHits} />
              </span>
              {match.pinyin && <PinyinHint pinyin={match.pinyin} />}
              {isBusy && <Icon name="spinner" size={14} className="animate-spin" />}
              {item.shortcut && (
                <kbd className="shrink-0 text-[11px] font-mono text-muted-foreground">{item.shortcut}</kbd>
              )}
            </button>
          </Fragment>
        );
      })}
    </>
  );
}
