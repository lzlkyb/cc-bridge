import { useEffect, useRef } from "react";

/** 菜单锚点（视口坐标，即 MouseEvent 的 clientX/clientY）。 */
export interface TerminalMenuPos {
  x: number;
  y: number;
}

interface Props {
  pos: TerminalMenuPos;
  /** 有无选中内容：无选中时「复制」置灰（而不是隐藏，菜单高度才稳定）。 */
  hasSelection: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onClose: () => void;
}

const MENU_W = 176;
const MENU_H = 124;

/**
 * 终端右键菜单：复制 / 粘贴 / 全选。
 *
 * 🔴 用 `position: fixed` + 视口坐标定位，而不是在终端容器内绝对定位：
 * 终端画布容器带 `overflow-hidden`，菜单挂在里面会被直接裁掉。
 *
 * 关闭时机：点菜单以外、Esc、窗口缩放。两个监听都走**捕获阶段**——
 * 终端自己在 document 上挂了 pointer/key 处理，冒泡阶段会被它们先吞掉。
 */
export function SshTerminalMenu({
  pos,
  hasSelection,
  onCopy,
  onPaste,
  onSelectAll,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // 贴边内收：靠近右 / 下边缘时向内移，避免菜单被视口截断。
  const left = Math.max(4, Math.min(pos.x, window.innerWidth - MENU_W - 4));
  const top = Math.max(4, Math.min(pos.y, window.innerHeight - MENU_H - 4));

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width: MENU_W }}
      className="fixed z-50 rounded-lg border border-border bg-card p-1 shadow-lg"
    >
      <Item label="复制" hint={hasSelection ? "Ctrl+Shift+C" : "无选中"} disabled={!hasSelection} onClick={run(onCopy)} />
      <Item label="粘贴" hint="Ctrl+V" onClick={run(onPaste)} />
      <Item label="全选" hint="Ctrl+A" onClick={run(onSelectAll)} />
    </div>
  );
}

function Item({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center justify-between gap-4 rounded-md px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-muted disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent"
    >
      <span>{label}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{hint}</span>
    </button>
  );
}
