import { Icon } from "./icon";

/** 统一的加载态旋转指示器。
 *  封装 Lucide `spinner` + `animate-spin`，替换散落的加载占位（如纯文本"加载中…"、内联 spinner），
 *  让全应用加载态观感一致。
 *  - size: 图标像素尺寸（默认 16）
 *  - className: 额外类名（如颜色、间距） */
export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return <Icon name="spinner" size={size} className={`animate-spin ${className}`} />;
}
