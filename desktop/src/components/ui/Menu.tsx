import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePresence } from "../../hooks/usePresence";
import { Icon, type IconName } from "./icon";

/**
 * 受控弹出菜单原语：管理 open 状态 + 外部点击/Esc 关闭。
 * 触发器与菜单项均由调用方渲染，便于「更多」与「终端风格」两个菜单共用同一套关闭逻辑。
 *
 * 关闭逻辑照搬自原 SshTerminalToolbar 的 MoreMenu：mousedown 用捕获阶段监听，
 * 因为终端容器在 mousedown 上会夺焦点，冒泡阶段才关菜单会慢一拍。
 *
 * 与 Modal 共用可中断的进退场；退场菜单保持视觉连续，但立即停止接受操作。
 */
export function Menu({
  trigger,
  children,
  align = "right",
  width = "w-44",
}: {
  /** 渲染触发器；open 为当前是否展开，toggle 切换展开状态。 */
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  /** 渲染菜单体；close 关闭菜单（选完项后调用）。 */
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const { mounted, entered } = usePresence(open);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 先关菜单；不要让同一次 Esc 穿透到外层弹窗或终端。
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        boxRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
        return;
      }
      if (!boxRef.current?.contains(e.target as Node) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const items = Array.from(boxRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
      if (!items.length) return;
      e.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (current + 1) % items.length : (current <= 0 ? items.length : current) - 1;
      items[index].focus({ preventScroll: true });
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={boxRef} className="relative">
      {trigger(open, () => setOpen((v) => !v))}
      {mounted && (
        <div
          role="menu"
          aria-hidden={!open || undefined}
          ref={node => { if (node) node.inert = !open; }}
          data-state={entered ? "open" : "closed"}
          data-exiting={!open || undefined}
          className={`ui-surface absolute top-full z-20 mt-1 ${align === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left"} ${width} max-h-[70vh] overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  label,
  hint,
  icon,
  active,
  onClick,
  trailing,
}: {
  label: ReactNode;
  hint?: string;
  icon?: IconName;
  active?: boolean;
  onClick: () => void;
  /** 右侧附加内容（如当前项打勾），自带 ml-auto 推到最右。 */
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-muted ${
        active ? "text-primary" : "text-foreground"
      }`}
    >
      {icon && <Icon name={icon} size={13} className="shrink-0" />}
      {typeof label === "string" ? <span className="truncate">{label}</span> : label}
      {trailing && <span className="ml-auto flex shrink-0 items-center pl-2">{trailing}</span>}
      {hint && !trailing && (
        <span className="ml-auto text-xs text-muted-foreground">{hint}</span>
      )}
    </button>
  );
}
