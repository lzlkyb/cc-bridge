import { useState, type ButtonHTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";

const base = "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";

const variants = {
  default: "bg-primary text-primary-foreground hover:brightness-110 hover:shadow-glow-primary",
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

interface Ripple {
  key: number;
  x: number;
  y: number;
  size: number;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  isLoading?: boolean;
  loadingText?: string;
}

export function Button({
  variant = "default",
  size = "default",
  className = "",
  isLoading,
  loadingText,
  children,
  disabled,
  onPointerDown,
  ...props
}: ButtonProps) {
  const reduced = usePrefersReducedMotion();
  const [ripples, setRipples] = useState<Ripple[]>([]);

  const addRipple = (e: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(e);
    if (reduced || disabled || isLoading || !e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const sizePx = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - sizePx / 2;
    const y = e.clientY - rect.top - sizePx / 2;
    const key = Date.now() + Math.random();
    setRipples((rs) => [...rs, { key, x, y, size: sizePx }]);
    window.setTimeout(() => setRipples((rs) => rs.filter((r) => r.key !== key)), 600);
  };

  return (
    <button
      className={`${base} relative overflow-hidden ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || isLoading}
      onPointerDown={addRipple}
      {...props}
    >
      {ripples.map((r) => (
        <span key={r.key} className="ripple" style={{ left: r.x, top: r.y, width: r.size, height: r.size }} />
      ))}
      {isLoading && (
        <svg className="animate-spin shrink-0" viewBox="0 0 24 24" width={size === "sm" ? 14 : 16} height={size === "sm" ? 14 : 16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
      )}
      {isLoading && loadingText ? loadingText : children}
    </button>
  );
}
