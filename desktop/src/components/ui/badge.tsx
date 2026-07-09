import type { HTMLAttributes } from "react";

const variants = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive/10 text-destructive border border-destructive/30",
  success: "bg-success/10 text-success border border-success/30",
  accent: "bg-accent text-accent-foreground",
  outline: "border text-foreground",
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof variants;
}

export function Badge({ variant = "default", className = "", ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${variants[variant]} ${className}`}
      {...props}
    />
  );
}
