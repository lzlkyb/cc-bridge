import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { useTerminalPreset } from "../../hooks/useTerminalPreset";
import { setPreset, PRESETS } from "../../lib/terminalPreset";
import { TERMINAL_PALETTES, type TerminalPreset } from "../../lib/terminalTheme";
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
 * 另有一枚常驻「风格」按钮：在终端页面内一步切换预设，避免每次都进设置页。
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
        <PresetMenu />
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

/**
 * 终端风格快切：工具条常驻按钮，弹层列 4 套预设（小色板预览 + 名称 + 描述），
 * 当前项打勾。点击即走全局 store（`setPreset`），所有终端同时换肤、不断连、不丢历史。
 */
function PresetMenu() {
  const current = useTerminalPreset();
  return (
    <Menu
      width="w-60"
      trigger={(open, toggle) => (
        <ButtonIcon title="终端风格（点此切换）" highlight={open} onClick={toggle}>
          <Icon name="palette" size={14} />
        </ButtonIcon>
      )}
    >
      {(close) =>
        PRESETS.map((p) => (
          <MenuItem
            key={p.id}
            active={current === p.id}
            onClick={() => {
              setPreset(p.id);
              close();
            }}
            trailing={
              current === p.id ? (
                <Icon name="check" size={13} className="text-primary" />
              ) : null
            }
            label={
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <PresetSwatch preset={p.id} />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-[13px]">{p.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{p.desc}</span>
                </span>
              </span>
            }
          />
        ))
      }
    </Menu>
  );
}

/** 预设小色板预览：背景 + 几个代表 ANSI 色拼一行，一眼区分四套风格。 */
function PresetSwatch({ preset }: { preset: TerminalPreset }) {
  const pal = TERMINAL_PALETTES[preset].dark;
  const colors = [pal.background, pal.green, pal.cyan, pal.magenta, pal.yellow];
  return (
    <span
      className="flex shrink-0 overflow-hidden rounded border border-border"
      style={{ width: 22, height: 14 }}
    >
      {colors.map((c, i) => (
        <span key={i} style={{ background: c, flex: 1 }} />
      ))}
    </span>
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
  return (
    <Menu
      trigger={(open, toggle) => (
        <ButtonIcon title="更多" highlight={open} onClick={toggle}>
          <Icon name="more" size={14} />
        </ButtonIcon>
      )}
    >
      {(close) => (
        <>
          <MenuItem label="复制整屏" icon="monitor" onClick={() => { onCopyScreen(); close(); }} />
          <MenuItem
            label={selectMode ? "退出选择模式" : "选择模式"}
            hint={selectMode ? "恢复鼠标报告" : "拖选复制"}
            icon="sliders"
            active={selectMode}
            onClick={() => { onToggleSelectMode(); close(); }}
          />
          <MenuItem label="清屏" icon="refresh" onClick={() => { onClear(); close(); }} />
        </>
      )}
    </Menu>
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
