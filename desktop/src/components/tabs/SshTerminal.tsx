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
import { TerminalStatusBar } from "./TerminalStatusBar";
import { attachTuiScrollbar, attachShiftWheel } from "../../lib/terminalScroll";
import { navJump } from "../../lib/terminalCommandNav";
import { registerPathLinkProvider } from "../../lib/terminalPathLink";
import { useTerminalTabMeta, type TermTabMetaPatch } from "../../hooks/useTerminalTabMeta";
import { toast } from "../ui/toast";
import { useThemeMode } from "../../hooks/useThemeMode";
import { useTerminalPreset, useTerminalInject } from "../../hooks/useTerminalPreset";
import { useTerminalOsc } from "../../hooks/useTerminalOsc";
import { TERMINAL_SURFACE } from "../../lib/terminalTheme";
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
  /** 远端 cwd 变化（OSC 7 探测结果，探不到时为 null）。父级拿它当拖拽上传的目标目录。 */
  onCwd: (cwd: string | null) => void;
  /** 标签 meta 上报（OSC 标题 / OSC 9;4 进度 / BEL 铃）。父级存进会话状态供标签栏展示。 */
  onMeta: (patch: TermTabMetaPatch) => void;
  /** 点击输出里的远端绝对路径 → 父级打开该连接的文件浏览器并定位。 */
  onOpenFilePath: (path: string) => void;
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
  onCwd,
  onMeta,
  onOpenFilePath,
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
  const preset = useTerminalPreset();
  const inject = useTerminalInject();
  const closed = closedReason !== null;

  const select = useSshTerminalSelect({ termRef, focusedRef, dragSelectEnabledRef });
  const search = useTerminalSearch(termRef, mode);
  const { focused, inputErr, paste, copyScreen, doFit } = useSshTerminalSession({
    sessionId,
    visible,
    fullscreen,
    mode,
    preset,
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
  // 远端状态探测：注入钩子 + 解析 OSC。钩子关闭 / 不支持时自动降级，终端本身不受影响。
  const { status, state } = useTerminalOsc({ sessionId, enabled: inject, closed, termRef });

  // 把远端 cwd 上报给父级：拖拽上传要拿它当目标目录，有了它就不用每次拖文件都问一遍。
  // 用 ref 承接回调——调用方传的是内联箭头函数，进依赖会让这个 effect 每次渲染都重跑。
  const onCwdRef = useRef(onCwd);
  onCwdRef.current = onCwd;
  useEffect(() => {
    onCwdRef.current(status.cwd);
  }, [status.cwd]);

  // TUI 态虚拟滚动条：进 Claude Code 这类 fullscreen 程序（备用屏）时，
  // 原生滚动条没有东西可滚——覆盖一条虚拟滚动条，拖动翻译成 wheel 事件转发给 TUI。
  // 逻辑全在 lib/terminalScroll.ts；这里只管挂载与把激活态给状态栏当徽标。
  // 本 effect 声明在 useSshTerminalSession 之后，运行时终端已 open，termRef 必有值。
  const [tuiScrollActive, setTuiScrollActive] = useState(false);
  // onOpenFilePath 用 ref 承接：调用方传内联箭头函数，不能进挂载 effect 的依赖。
  const onOpenFilePathRef = useRef(onOpenFilePath);
  onOpenFilePathRef.current = onOpenFilePath;
  useEffect(() => {
    const term = termRef.current;
    const container = containerRef.current;
    if (!term || !container) return;
    // Shift+滚轮强制滚本地 scrollback（业界惯例）：与 TUI 滚动条互不干扰——
    // 合成 wheel 不带 shiftKey，会原样走转发路径。
    attachShiftWheel(term);
    // 输出里的远端绝对路径 → 可点击（注册在 web-links 之后，URL 仍归它）。
    const offLinks = registerPathLinkProvider(term, (p) => onOpenFilePathRef.current(p));
    const offTui = attachTuiScrollbar(term, container, { onActiveChange: setTuiScrollActive });
    return () => {
      offLinks();
      offTui();
    };
    // 终端实例由 session hook 创建（其 effect 先于本 effect 运行），只需挂一次。
  }, []);

  // 命令导航快捷键：Ctrl+Shift+↑/↓ 跳到上一条/下一条命令的提示符行。
  // 🔴 不能走 attachTerminalKeymap——xterm 的 custom key handler 是单槽位（Terminal.ts:914
  // 直接赋值），再挂会顶掉 session hook 装的那份。window capture 阶段先于 xterm 的
  // textarea 处理，preventDefault + stopPropagation 就能整条拦下，不往远端发 CSI。
  // focusedRef 守卫：只在终端聚焦时拦，搜索框/输入框里的这两个组合不受影响。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!focusedRef.current) return;
      if (!(e.ctrlKey && e.shiftKey) || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      e.stopPropagation();
      const term = termRef.current;
      if (!term) return;
      const dir = e.key === "ArrowUp" ? -1 : 1;
      if (!navJump(term, dir)) {
        toast(dir === -1 ? "没有更早的命令了" : "已经是最新的命令了", "info");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // 标签 meta 上报（标题/进度/铃）。后台标签收到 BEL 才 toast：用户正盯着这个终端时
  // 响铃不需要再弹一条「有铃声」，那反而是打扰。onMeta 由 hook 用 ref 承接，闭包读到最新 visible。
  useTerminalTabMeta({
    termRef,
    closed,
    onMeta: (p) => {
      if (p.bellAt != null && !visible)
        toast(`${conn.name || conn.host}：终端有铃声（可能需要关注）`, "info");
      onMeta(p);
    },
  });

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

  const surface = TERMINAL_SURFACE[preset][mode];
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
      <TerminalStatusBar
        sessionId={sessionId}
        conn={conn}
        preset={preset}
        mode={mode}
        status={status}
        state={state}
        closed={closed}
        tuiScroll={tuiScrollActive}
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
    </div>
  );
}
