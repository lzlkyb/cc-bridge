import type { HTMLAttributes, ReactNode } from "react";

const variants = {
  default: "bg-background text-foreground border",
  destructive: "border-destructive/50 bg-destructive/10 text-destructive",
  warning: "border-warning/50 bg-warning/10 text-warning-foreground",
  success: "border-success/50 bg-success/10 text-success",
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

export function AlertTitle({ className = "", children }: { className?: string; children: ReactNode }) {
  return <h5 className={`mb-1 font-medium leading-none ${className}`}>{children}</h5>;
}

export function AlertDescription({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`text-sm opacity-90 ${className}`}>{children}</div>;
}
