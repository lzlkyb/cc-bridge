import type { ReactNode } from "react";

/**
 * 统一的「已保存 / 已复制」行内反馈组件。
 * 用于设置项保存后的即时确认（行内、就近、轻量）。
 * 页面级异步动作（如「端口已保存」）仍走 toast，两者作用域不重叠，不冗余。
 */
export function SavedHint({
  children,
  iconOnly = false,
  className = "",
}: {
  children?: ReactNode;
  iconOnly?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`saved-hint inline-flex items-center gap-1 text-xs font-medium text-success${
        iconOnly ? " saved-hint--icon" : ""
      } ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="h-3 w-3"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      {!iconOnly && <span>{children}</span>}
    </span>
  );
}
