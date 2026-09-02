import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { SshTerminalMenu, type TerminalMenuPos } from "./SshTerminalMenu";
import { SshTerminalToolbar } from "./SshTerminalToolbar";
import { SshDisconnectedBar } from "./SshDisconnectedBar";
import { useSshTerminalSelect } from "./useSshTerminalSelect";
import { useSshTerminalSession } from "./useSshTerminalSession";
import { useTerminalSearch } from "./useTerminalSearch";
import { useTerminalFontSize } from "./useTerminalFontSize";
import { SshTerminalFind } from "./SshTerminalFind";
import { useThemeMode } from "../../hooks/useThemeMode";
import { TERMINAL_SURFACE } from "../../lib/terminalTheme";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { SshConnection } from "../../lib/types";

interface Props {
  sessionId: string;
  conn: SshConnection;
  /** 会话已断开时的原因；null = 还连着。 */
  closedReason: string | null;
  /** 会话结束（远端断开 / 连接失败），由父组件置为已断开态并提示。 */
  onClosed: (reason: string) => void;
  onReconnect: () => void;
  onCloseTab: () => void;
  /** 该终端当前是否可见（多标签切换时从 display:none → block，需重新 fit）。 */
  visible: boolean;
  /** 终端拖拽即选开关（设置项 ssh_drag_select_enabled）。 */
  dragSelectEnabled: boolean;
  /** 是否处于软件内全屏（布局由 TerminalTab 控制，这里只管图标/徽标与重新 fit）。 */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

/**
 * xterm.js 终端面板：渲染单个 SSH 会话。
 *
 * 本文件只管组装与布局，两块重逻辑各自成 hook：
 * - `useSshTerminalSession`：终端生命周期、输入输出回路、尺寸同步、主题热切换、粘贴
 * - `useSshTerminalSelect`：选择模式 / Shift 拖选 / 拖拽即选 / 松手自动复制
 */
export function SshTerminal({
  sessionId,
  conn,
  closedReason,
  onClosed,
  onReconnect,
  onCloseTab,
  visible,
  dragSelectEnabled,
  fullscreen,
  onToggleFullscreen,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const focusedRef = useRef(false); // 供 window 级键盘监听判断本会话是否聚焦
  // dragSelectEnabled 来自父组件 props（设置项），用 ref 承接，使监听闭包总能读到最新值，
  // 且不让它进入 effect 依赖导致 xterm 重建。
  const dragSelectEnabledRef = useRef(dragSelectEnabled);
  dragSelectEnabledRef.current = dragSelectEnabled;
  // 右键菜单锚点（视口坐标），null = 不显示。
  const [menuPos, setMenuPos] = useState<TerminalMenuPos | null>(null);
  const mode = useThemeMode();
  const closed = closedReason !== null;

  const select = useSshTerminalSelect({ termRef, focusedRef, dragSelectEnabledRef });
  const search = useTerminalSearch(termRef, mode);
  const { focused, inputErr, paste, copyScreen, pastePrompt, doFit } = useSshTerminalSession({
    sessionId,
    visible,
    fullscreen,
    mode,
    closed,
    onClosed,
    containerRef,
    termRef,
    focusedRef,
    selectActiveRef: select.selectActiveRef,
    attachSelect: select.attach,
    copySelection: select.copySelection,
    attachSearch: search.attach,
    openSearch: search.openSearch,
  });
  const font = useTerminalFontSize({ termRef, containerRef, doFit });

  // 右键：阻掉默认菜单，改弹自己的复制/粘贴/全选。用视口坐标定位，
  // 因为终端容器带 overflow-hidden，菜单挂在容器内会被裁掉。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      setMenuPos({ x: e.clientX, y: e.clientY });
    };
    container.addEventListener("contextmenu", onContextMenu);
    return () => container.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const surface = TERMINAL_SURFACE[mode];
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: surface }}>
      <SshTerminalToolbar
        conn={conn}
        closed={closed}
        focused={focused}
        inputErr={inputErr}
        selectMode={select.selectMode}
        shiftActive={select.shiftActive}
        dragSelecting={select.dragSelecting}
        fullscreen={fullscreen}
        onCopy={select.copySelection}
        onCopyScreen={copyScreen}
        onPaste={paste}
        onSearch={search.openSearch}
        onToggleSelectMode={select.toggleSelectMode}
        onClear={() => termRef.current?.clear()}
        onToggleFullscreen={onToggleFullscreen}
      />
      {closedReason !== null && (
        <SshDisconnectedBar
          reason={closedReason}
          onReconnect={onReconnect}
          onCloseTab={onCloseTab}
        />
      )}
      {/* 内边距与底色放外层；内层是 fit 的测量基准，**必须无 padding**。
          FitAddon 读的是 parentElement 的 computed height（不含 padding），而 doFit 的实测用的是
          clientHeight（含 padding）——两者对 padding 的口径不一样，分层之后就不存在这个陷阱。 */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden p-2"
        style={{ background: surface }}
      >
        <div ref={containerRef} className="h-full w-full" />
        <SshTerminalFind search={search} />
        {font.badge !== null && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/70 px-3.5 py-1.5 text-xs tracking-wide text-white">
            字号 {font.badge}
          </div>
        )}
      </div>
      {menuPos && (
        <SshTerminalMenu
          pos={menuPos}
          hasSelection={select.hasSelection()}
          pasteDisabled={closed}
          onCopy={select.copySelection}
          onPaste={paste}
          onSelectAll={() => termRef.current?.selectAll()}
          onClose={() => setMenuPos(null)}
        />
      )}
      {pastePrompt && (
        <ConfirmDialog
          variant="destructive"
          title={`粘贴 ${pastePrompt.lineCount} 行内容？`}
          description="多行内容粘进终端会被远端 shell 逐行执行，不会等你再按回车。"
          confirmLabel="粘贴并执行"
          onCancel={pastePrompt.cancel}
          onConfirm={pastePrompt.confirm}
        >
          <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted px-3 py-2 text-xs leading-relaxed text-foreground">
            {pastePrompt.preview}
          </pre>
        </ConfirmDialog>
      )}
    </div>
  );
}
