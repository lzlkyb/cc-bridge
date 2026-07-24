import type { CSSProperties } from "react";

/** 骨架屏：加载占位块，统一加载反馈（替代散落的"加载中…"纯文本）。
 *  通过 .skeleton 类（index.css）做微光呼吸动画，颜色跟随主题 muted。
 *
 *  - className: 尺寸/布局（如 "h-3.5 w-full"）
 *  - style?:    可选内联样式 */
export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}
