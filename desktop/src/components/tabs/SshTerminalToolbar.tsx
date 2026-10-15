import { Icon } from "../ui/icon";
import { setCmdPanelOpen, useCmdPanelOpen } from "../../lib/terminalPanelStore";
import type { SshConnection } from "../../lib/types";
import { MoreMenu, ButtonIcon } from "./SshTerminalMoreMenu";
import { TerminalAppearanceMenu } from "./TerminalAppearanceMenu";

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
  /** 剪贴板图片上传远端（无图/断开时由 hook 侧 toast 说明）。 */
  onPasteImage: () => void;
  /** 图片上传进行中：按钮禁用防连按。 */
  imgBusy: boolean;
  /** 强制全量重绘（Claude Code 差分渲染残影的社区共识自救）。 */
  onRepaint: () => void;
  onSearch: () => void;
  onToggleSelectMode: () => void;
  onClear: () => void;
  onToggleFullscreen: () => void;
  /** 导出整个滚动历史为 .txt（「更多」菜单项）。 */
  onExport: () => void;
}

/**
 * SSH 终端标题栏：连接名 + 地址 + 状态徽标组 + 操作。
 *
 * 按钮分两层：常用的（复制选中 / 粘贴 / 全屏）直接露出，不常用的（复制整屏 / 选择模式 / 清屏）
 * 收进「更多」菜单并**带上文字**——纯图标并列时 `sliders` 代表「选择模式」基本猜不出来。
 * 清屏收进去也顺带降了误点风险（它会清掉滚动历史且无法撤销）。
 *
 * 另有一枚常驻「外观」按钮：终端页面内一步切换风格 / 明暗 / 字体，避免每次都进设置页。
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
  onPasteImage,
  imgBusy,
  onRepaint,
  onSearch,
  onToggleSelectMode,
  onClear,
  onToggleFullscreen,
  onExport,
}: Props) {
  // 命令历史面板的开关在模块级 store 里：按钮在每个会话自己的工具栏上，面板本体挂在
  // 会话容器（SshTerminal）里——两端不同子树，靠 props 串会把 SshTerminal.tsx 撑破 300 行线。
  const cmdOpen = useCmdPanelOpen();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
      <Icon name="terminal" size={14} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-sm font-medium" title={conn.name || conn.host}>
        {conn.name || conn.host}
      </span>
      <span
        className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline"
        title={`${conn.username}@${conn.host}:${conn.port}`}
      >
        {conn.username}@{conn.host}:{conn.port}
      </span>
      {closed ? (
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive-ink">
          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
          已断开
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          已连接
        </span>
      )}
      {fullscreen && (
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
          全屏 · F11 退出
        </span>
      )}
      {(selectMode || shiftActive || dragSelecting) && (
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-indigo-500/15 px-2 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />
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
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
          输入失败
        </span>
      ) : (
        !focused &&
        !closed && (
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
            点击终端以输入
          </span>
        )
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1 border-l border-border pl-2">
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
        <ButtonIcon
          title={
            closed ? "连接已断开，无法发送图片" : "粘贴剪贴板图片到远端（Ctrl+Shift+V）"
          }
          disabled={closed || imgBusy}
          onClick={onPasteImage}
        >
          <Icon name="image" size={14} />
        </ButtonIcon>
        <ButtonIcon title="搜索（Ctrl+Shift+F）" onClick={onSearch}>
          <Icon name="search" size={14} />
        </ButtonIcon>
        {/* 命令历史（OSC 133 命令块）。⚠️ 只有普通 shell 会话有记录，全屏 TUI 里为空——
            面板空态里写了这条限制。 */}
        <ButtonIcon
          title="命令历史（普通 shell 会话）"
          highlight={cmdOpen}
          onClick={() => setCmdPanelOpen(!cmdOpen)}
        >
          <Icon name="history" size={14} />
        </ButtonIcon>
        <ButtonIcon
          title={fullscreen ? "退出全屏（F11）" : "全屏（F11）"}
          highlight={fullscreen}
          onClick={onToggleFullscreen}
        >
          <Icon name={fullscreen ? "collapse" : "expand"} size={14} />
        </ButtonIcon>
        <TerminalAppearanceMenu />
        <MoreMenu
          selectMode={selectMode}
          onCopyScreen={onCopyScreen}
          onToggleSelectMode={onToggleSelectMode}
          onClear={onClear}
          onRepaint={onRepaint}
          onExport={onExport}
        />
      </div>
    </div>
  );
}

/** 「更多」下拉与 ButtonIcon 已迁至 SshTerminalMoreMenu.tsx（含快捷键面板）；「外观」菜单在 TerminalAppearanceMenu.tsx。 */
