import type { ReactNode } from "react";
import { Icon } from "./icon";

/** 统一空状态组件：背景大号半透明图标 + 前景小图标 + 引导文案 + 可选操作按钮。
 *  用于审计无记录 / 白名单为空 / 筛选无结果 / 无运行历史等场景，替代散落的纯文本占位。
 *
 *  - icon:         图标名（lucide，如 "folder" / "file" / "search" / "terminal"）
 *  - description:  引导文案
 *  - action?:      可选操作区（如"添加第一个目录"按钮），渲染在文案下方
 *  - bigIconSize?: 背景大图标尺寸（默认 84）
 *  - iconSize?:    前景小图标尺寸（默认 26）
 *  - className?:   容器额外类名（如高度/内边距，控制占位尺寸） */
export function EmptyState({
  icon,
  description,
  action,
  bigIconSize = 84,
  iconSize = 26,
  className = "",
}: {
  icon: string;
  description: string;
  action?: ReactNode;
  bigIconSize?: number;
  iconSize?: number;
  className?: string;
}) {
  return (
    <div className={`relative flex flex-col items-center justify-center gap-2.5 px-6 text-center ${className}`}>
      <Icon name={icon} size={bigIconSize} className="pointer-events-none absolute opacity-[0.06]" />
      <Icon name={icon} size={iconSize} className="relative z-[1] text-muted-foreground/40" />
      <p className="relative z-[1] max-w-[280px] text-sm leading-relaxed text-muted-foreground">{description}</p>
      {action && <div className="relative z-[1] mt-1">{action}</div>}
    </div>
  );
}
