import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import type { SshConnection } from "../../lib/types";

interface Props {
  conn: SshConnection;
  /** 会话已断开（终端保留、仅可读） */
  closed: boolean;
  /** 终端是否聚焦（未聚焦时提示点击） */
  focused: boolean;
  /** 最近一次 ssh_input 失败原因，null = 正常 */
  inputErr: string | null;
  selectMode: boolean;
  shiftActive: boolean;
  dragSelecting: boolean;
  fullscreen: boolean;
  onCopy: () => void;
  onCopyScreen: () => void;
  onPaste: () => void;
  onSearch: () => void;
  onToggleSelectMode: () => void;
  onClear: () => void;
  onToggleFullscreen: () => void;
}

/**
 * SSH 终端标题栏：连接名 + 地址 + 状态徽标组 + 操作。
 *
 * 按钮分两层：常用的（复制选中 / 粘贴 / 全屏）直接露出，不常用的（复制整屏 / 选择模式 / 清屏）
 * 收进「更多」菜单并**带上文字**——纯图标并列时 `sliders` 代表「选择模式」基本猜不出来。
 * 清屏收进去也顺带降了误点风险（它会清掉滚动历史且无法撤销）。
 *
 * 注意这里**没有「断开」按钮**：断开入口在标签栏的 × 与左侧连接列表。
 */
export function SshTerminalToolbar({
  conn,
  closed,
  focused,
  inputErr,
  selectMode,
  shiftActive,
  dragSelecting,
  fullscreen,
  onCopy,
  onCopyScreen,
  onPaste,
  onSearch,
  onToggleSelectMode,
  onClear,
  onToggleFullscreen,
}: Props) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
      <Icon name="terminal" size={14} className="text-muted-foreground" />
      <span className="text-sm font-medium">{conn.name || conn.host}</span>
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {conn.username}@{conn.host}:{conn.port}
      </span>
      {closed ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
          已断开
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          已连接
        </span>
      )}
      {fullscreen && (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
          全屏 · F11 退出
        </span>
      )}
      {(selectMode || shiftActive || dragSelecting) && (
        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-400">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
          {dragSelecting
            ? "拖选复制"
            : shiftActive && !selectMode
              ? "按住 Shift·拖选复制"
              : "选择模式·拖选复制"}
        </span>
      )}
      {inputErr ? (
        <span
          title={inputErr}
          className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
          输入失败
        </span>
      ) : (
        !focused &&
        !closed && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            点击终端以输入
          </span>
        )
      )}
      <div className="ml-auto flex items-center gap-1 border-l border-border pl-2">
        <ButtonIcon title="复制选中（Ctrl+Shift+C）" onClick={onCopy}>
          <Icon name="copy" size={14} />
        </ButtonIcon>
        <ButtonIcon
          title={closed ? "连接已断开，无法粘贴" : "粘贴（Ctrl+V / 右键）"}
          disabled={closed}
          onClick={onPaste}
        >
          <Icon name="clipboard" size={14} />
        </ButtonIcon>
        <ButtonIcon title="搜索（Ctrl+Shift+F）" onClick={onSearch}>
          <Icon name="search" size={14} />
        </ButtonIcon>
        <ButtonIcon
          title={fullscreen ? "退出全屏（F11）" : "全屏（F11）"}
          highlight={fullscreen}
          onClick={onToggleFullscreen}
        >
          <Icon name={fullscreen ? "collapse" : "expand"} size={14} />
        </ButtonIcon>
        <MoreMenu
          selectMode={selectMode}
          onCopyScreen={onCopyScreen}
          onToggleSelectMode={onToggleSelectMode}
          onClear={onClear}
        />
      </div>
    </div>
  );
}

/** 「更多」下拉：不常用的三个操作，菜单项带文字。 */
function MoreMenu({
  selectMode,
  onCopyScreen,
  onToggleSelectMode,
  onClear,
}: {
  selectMode: boolean;
  onCopyScreen: () => void;
  onToggleSelectMode: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // 捕获阶段监听：终端容器在 mousedown 上会夺焦点，冒泡阶段才关菜单会慢一拍。
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <ButtonIcon title="更多" highlight={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="more" size={14} />
      </ButtonIcon>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-border bg-card p-1 shadow-lg"
        >
          <MenuItem label="复制整屏" icon="monitor" onClick={run(onCopyScreen)} />
          <MenuItem
            label={selectMode ? "退出选择模式" : "选择模式"}
            hint={selectMode ? "恢复鼠标报告" : "拖选复制"}
            icon="sliders"
            active={selectMode}
            onClick={run(onToggleSelectMode)}
          />
          <MenuItem label="清屏" icon="refresh" onClick={run(onClear)} />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  hint,
  icon,
  active,
  onClick,
}: {
  label: string;
  hint?: string;
  icon: "monitor" | "sliders" | "refresh";
  active?: boolean;
  onClick: () => void;
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
      <Icon name={icon} size={13} className="shrink-0" />
      <span>{label}</span>
      {hint && <span className="ml-auto text-[11px] text-muted-foreground">{hint}</span>}
    </button>
  );
}

function ButtonIcon({
  title,
  onClick,
  highlight,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  highlight?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        highlight ? "bg-primary/15 text-primary hover:bg-primary/20" : ""
      }`}
    >
      {children}
    </button>
  );
}
