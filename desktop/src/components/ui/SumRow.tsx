import type { KeyboardEvent, ReactNode } from "react";
import { Icon, type IconName } from "./icon";

/**
 * 摘要行（文件管控卡折叠态行头）：值可见、整行是 button、aria-expanded 明示展开态。
 *
 * WHY 原语：备份 / 限流 / 后台命令三节原本铺开 9 个控件同屏（超出 8+ 过载线），
 * 改摘要行后首屏交互元素 9→5。三行结构完全相同，抽原语避免抄三遍。
 * 键盘交互与日志页导出菜单同一层：Enter/Space 由 button 原生支持，
 * ↑/↓ 在同一容器的摘要行之间移动焦点（不用自己记索引，querySelectorAll 现取）。
 */
export function SumRow({
  icon,
  label,
  value,
  expanded,
  onToggle,
}: {
  icon: IconName;
  label: string;
  value: ReactNode;
  /** 展开态行头：传入时渲染 aria-expanded 且 chevron 随状态旋转。
   *  动作行（如「版本历史」点它直接开弹窗）不传——那条行没有展开态。 */
  expanded?: boolean;
  onToggle: () => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const bar = e.currentTarget.parentElement;
    if (!bar) return;
    const rows = Array.from(bar.querySelectorAll<HTMLButtonElement>(":scope > .sumrow"));
    const i = rows.indexOf(e.currentTarget);
    const next = rows[e.key === "ArrowUp" ? i - 1 : i + 1];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  return (
    <button
      type="button"
      className="sumrow flex w-full items-center gap-3 rounded-lg border border-transparent px-2.5 py-2.5 text-left transition-colors hover:bg-muted"
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <span className="title-chip shrink-0">
        <Icon name={icon} size={15} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-foreground">{label}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{value}</span>
      </span>
      <Icon
        name="chevronDown"
        size={14}
        className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
      />    </button>
  );
}
