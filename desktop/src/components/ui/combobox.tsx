import { useState, useRef, useEffect } from "react";
import { Icon } from "./icon";

/**
 * 自定义 Combobox（P0-3）：替换 LogTab 中的原生 <select>。
 * WHY：原生 select 在深色模式下走系统样式，与设计系统割裂。
 * 复用现有 Icon + Tailwind 令牌，浮层/圆角/hover 全部走设计系统。
 */
export interface ComboboxOption {
  value: string;
  label: string;
}

interface ComboboxProps {
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  className?: string;
}

export function Combobox({ value, options, onChange, className = "" }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className="flex h-8 min-w-[120px] items-center justify-between gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs transition-colors hover:border-primary"
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <Icon
          name="chevronDown"
          size={14}
          className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-pop">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground ${
                opt.value === value ? "font-medium text-primary" : ""
              }`}
            >
              <Icon
                name="check"
                size={12}
                className={`shrink-0 ${opt.value === value ? "opacity-100" : "opacity-0"}`}
              />
              <span className="truncate">{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
