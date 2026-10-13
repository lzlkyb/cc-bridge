import { useId, useState, useRef, useEffect } from "react";
import { Icon } from "./icon";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";

/**
 * 自定义 Combobox（P0-3）：替换 LogTab 中的原生 <select>。
 * WHY：原生 select 在深色模式下走系统样式，与设计系统割裂。
 * 复用现有 Icon + Tailwind 令牌，浮层/圆角/hover 全部走设计系统。
 *
 * a11y（设计稿《日志页-a11y键盘交互》）：触发器带 aria-expanded/aria-haspopup，
 * 浮层 role=listbox、项 role=option/aria-selected；展开时 ↑/↓ 移动高亮、
 * Enter 选中、Esc 关闭——焦点始终留在触发器上（combobox 惯例，浮层不抢焦）。
 */
export interface ComboboxOption {
  value: string;
  label: string;
  /** 右侧的次要说明（地址、不可选的理由等）。 */
  hint?: string;
  /**
   * 置灰不可选。
   *
   * 为什么置灰而不是直接不列出来：用户在列表里找不到自己知道存在的一条
   * 连接时，无从得知是自己看错了还是它本来就不能选。配合 `hint` 给出理由。
   */
  disabled?: boolean;
}

interface ComboboxProps {
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  className?: string;
  /** 触发按钮的可访问名称（placeholder 不算 label，读屏需要显式命名）。 */
  ariaLabel?: string;
  /** 触发按钮撑满容器（表单里与 Input 对齐时用）。 */
  fullWidth?: boolean;
}

export function Combobox({
  value,
  options,
  onChange,
  className = "",
  ariaLabel,
  fullWidth = false,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  /** 键盘高亮项（↑/↓ 移动，Enter 选中）。焦点不离开触发器，高亮纯视觉。 */
  const [activeIdx, setActiveIdx] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useAutoAnimateRM<HTMLDivElement>();
  const listboxId = useId();

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

  const selectedIdx = options.findIndex((o) => o.value === value);
  const selected = selectedIdx >= 0 ? options[selectedIdx] : undefined;

  const pick = (opt: ComboboxOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    setActiveIdx(-1);
  };
  const move = (step: 1 | -1) => {
    // 跳过禁用项循环移动；全禁用时原地不动。
    for (let n = 1; n <= options.length; n++) {
      const idx = ((activeIdx + step * n) % options.length + options.length) % options.length;
      if (!options[idx]?.disabled) {
        setActiveIdx(idx);
        return;
      }
    }
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          setOpen((v) => {
            if (!v) setActiveIdx(selectedIdx >= 0 ? selectedIdx : 0);
            return !v;
          });
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (open) {
              e.stopPropagation(); // 关下拉就行，别顺手关掉底下的弹窗（如连接编辑对话框）
              setOpen(false);
              setActiveIdx(-1);
            }
            return;
          }
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            // 关闭态按方向键直接展开（Enter 走原生 click，别在这里抢——
            // 双触发会开完立刻关上）
            e.preventDefault();
            setActiveIdx(selectedIdx >= 0 ? selectedIdx : 0);
            setOpen(true);
            return;
          }
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter" && activeIdx >= 0) {
            e.preventDefault();
            const opt = options[activeIdx];
            if (opt) pick(opt);
          }
        }}
        className={`flex h-8 min-w-[120px] items-center justify-between gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs transition-colors hover:border-primary ${
          fullWidth ? "w-full" : ""
        }`}
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <Icon
          name="chevronDown"
          size={14}
          className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          id={listboxId}
          ref={listRef}
          role="listbox"
          className={`absolute left-0 top-full z-20 mt-1 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-pop ${
            fullWidth ? "right-0" : ""
          }`}
        >
          {options.map((opt, i) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              disabled={opt.disabled}
              title={opt.hint}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => pick(opt)}
              className={`flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs transition-colors enabled:hover:bg-accent enabled:hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-45 ${
                i === activeIdx ? "bg-accent text-primary" : ""
              } ${opt.value === value && i !== activeIdx ? "font-medium text-primary" : ""}`}
            >
              <Icon
                name="check"
                size={12}
                className={`shrink-0 ${opt.value === value ? "opacity-100" : "opacity-0"}`}
              />
              <span className="truncate">{opt.label}</span>
              {opt.hint && (
                <span className="ml-auto shrink-0 pl-2 text-[10.5px] text-muted-foreground">
                  {opt.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
