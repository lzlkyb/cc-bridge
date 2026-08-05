import type { ReactNode } from "react";

/**
 * 单选型圆角选项芯片（清理弹窗的方式 / 天数 / 体积 三组共用）。
 * 只表达「选中/未选中」，不承担动作语义——动作类请用 Button。
 */
export function OptionChip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
        on
          ? "border-primary/40 bg-primary/10 font-semibold text-primary"
          : "border-border bg-card text-muted-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}
