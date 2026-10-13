import type { HTMLAttributes } from "react";

const variants = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  // 文字用 -ink：基础语义色在 12px 淡底上仅 2.1–3.3:1（浅色），不达 AA 4.5:1
  destructive: "bg-destructive/10 text-destructive-ink border border-destructive/30",
  success: "bg-success/10 text-success-ink border border-success/30",
  accent: "bg-accent text-accent-foreground",
  outline: "border text-foreground",
};

/* 现代外观钩子：设计稿 .badge 的色调命名（ok/warn/danger/brand）与本组件的
   variant 命名不同，这里做一次映射，让 index.css 能按设计稿的名字写规则。 */
const modernTone: Record<keyof typeof variants, string> = {
  default: "brand",
  secondary: "",
  destructive: "danger",
  success: "ok",
  accent: "brand",
  outline: "",
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof variants;
}

export function Badge({ variant = "default", className = "", ...props }: BadgeProps) {
  return (
    <span
      className={`badge ${modernTone[variant]} inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${variants[variant]} ${className}`}
      {...props}
    />
  );
}
