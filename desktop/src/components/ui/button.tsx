import { useLayoutEffect, useRef, type ButtonHTMLAttributes } from "react";

const base = "ui-button inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
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
  icon: "h-9 w-9",
};

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
  style,
  ...props
}: ButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const widthRef = useRef<number>();
  // Header 等调用方会在 busy 时移除 children；保留上一帧宽度仍然必要。
  useLayoutEffect(() => {
    if (!isLoading && buttonRef.current) widthRef.current = buttonRef.current.getBoundingClientRect().width;
  }, [isLoading, children]);
  return (
    <button
      ref={buttonRef}
      aria-busy={isLoading || undefined}
      data-loading={isLoading || undefined}
      style={{ minWidth: isLoading ? widthRef.current : undefined, ...style }}
      className={`${base} relative overflow-hidden ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || isLoading}
      {...props}
    >
      {/* 原内容保留尺寸，异步态覆盖其上，避免 spinner 插入时挤动相邻控件。 */}
      <span aria-hidden={isLoading || undefined} style={{ gap: "inherit" }} className={`inline-flex items-center justify-center ${isLoading ? "invisible" : ""}`}>{children}</span>
      {isLoading && <span className="ui-button-loader absolute inset-0 inline-flex min-w-0 items-center justify-center gap-2 px-2" role="status">
        <svg aria-hidden="true" className="animate-spin shrink-0" viewBox="0 0 24 24" width={size === "sm" ? 14 : 16} height={size === "sm" ? 14 : 16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
        {size === "icon" ? <span className="sr-only">{loadingText ?? "处理中"}</span> : <span className="truncate">{loadingText ?? children}</span>}
      </span>}
    </button>
  );
}
