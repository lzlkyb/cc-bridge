import type { SortKey, SortState } from "../../lib/sshFileSort";

interface Props {
  /** 这一列对应的排序键。 */
  sortKey: SortKey;
  label: string;
  align: "left" | "right";
  /** 附加类名（列宽 / 内边距）。 */
  extra?: string;
  sort: SortState;
  onToggleSort: (key: SortKey) => void;
}

/**
 * 可排序表头单元格（设计稿：design/文件面板重命名与排序-设计稿-2026-11-24.html）。
 *
 * 激活列变主题色并显示 ▲/▼，其余列悬停才显色。🔴 箭头**只在激活列出现**：
 * 实测三列同时亮箭头会被用户读成「三个排序同时生效」，与「一次只有一个排序」
 * 的语义自相矛盾——这是渲染验收拦下来的真 bug，别改回去。
 */
export function SortableTh({ sortKey, label, align, extra = "", sort, onToggleSort }: Props) {
  const active = sort.key === sortKey;
  return (
    <th
      className={`${align === "right" ? "text-right " : "text-left "}${extra}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        title={`点击按${label}排序`}
        onClick={() => onToggleSort(sortKey)}
        className={`inline-flex items-center gap-1 rounded font-medium hover:text-foreground ${align === "right" ? "ml-auto " : ""}${active ? "text-primary" : ""}`}
      >
        {label}
        {active && <span aria-hidden="true" className="text-[10px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}
