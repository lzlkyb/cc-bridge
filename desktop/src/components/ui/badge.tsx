import type { HTMLAttributes } from "react";

const variants = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive/10 text-destructive border border-destructive/30",
  success: "bg-success/10 text-success border border-success/30",
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
