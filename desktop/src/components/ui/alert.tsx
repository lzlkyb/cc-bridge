import type { HTMLAttributes } from "react";

const variants = {
  default: "bg-background text-foreground border",
  // 文字用 -ink：基础语义色浅色淡底上不达 AA；warning 原本走 --warning-foreground，
  // 那是「实底上的字」——深色主题下是近黑 hsl(240 6% 10%)，叠淡底只有 1.05:1，完全不可读。
  destructive: "border-destructive/50 bg-destructive/10 text-destructive-ink",
  warning: "border-warning/50 bg-warning/10 text-warning-ink",
  success: "border-success/50 bg-success/10 text-success-ink",
};

/* 现代外观钩子：设计稿 .alert 的色调命名与本组件 variant 命名的映射 */
const modernTone: Record<keyof typeof variants, string> = {
  default: "info",
  destructive: "danger",
  warning: "warn",
  success: "ok",
};

interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: keyof typeof variants;
}

export function Alert({ variant = "default", className = "", ...props }: AlertProps) {
  return (
    <div
      role="alert"
      className={`alert ${modernTone[variant]} relative w-full rounded-lg border p-4 text-sm ${variants[variant]} ${className}`}
      {...props}
    />
  );
}
