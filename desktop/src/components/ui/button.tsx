import type { ButtonHTMLAttributes } from "react";

const base = "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

const variants = {
  default: "bg-primary text-primary-foreground hover:brightness-110 hover:shadow-md hover:shadow-primary/20",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  outline: "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground hover:border-primary",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  link: "text-primary underline-offset-4 hover:underline",
};

const sizes = {
  default: "h-9 px-4 py-2",
  sm: "h-8 px-3 text-xs",
  lg: "h-10 px-8",
  icon: "h-9 w-9 hover:scale-[1.08] active:scale-95",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export function Button({ variant = "default", size = "default", className = "", ...props }: ButtonProps) {
  return <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...props} />;
}
