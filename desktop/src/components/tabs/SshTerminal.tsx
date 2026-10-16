import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { SshTerminalContextMenu } from "./SshTerminalContextMenu";
import { SshTerminalToolbar } from "./SshTerminalToolbar";
import { SshDisconnectedBar } from "./SshDisconnectedBar";
import { useSshTerminalSelect } from "./useSshTerminalSelect";
import { useSshTerminalSession } from "./useSshTerminalSession";
import { useTerminalSearch } from "./useTerminalSearch";
import { useTerminalTypography } from "./useTerminalTypography";
import { SshTerminalFind } from "./SshTerminalFind";
import { TerminalStatusBar } from "./TerminalStatusBar";
import { TuiGuideBar } from "./TuiGuideBar";
import { WheelOwnerPopover } from "./WheelOwnerPopover";
import { useWheelGuide } from "../../hooks/useWheelGuide";
import { navJump } from "../../lib/terminalCommandNav";
import { registerPathLinkProvider } from "../../lib/terminalPathLink";
import { registerTerminal } from "../../lib/terminalRegistry";
import { useTerminalExport } from "./useTerminalExport";
import { SshCommandBlocksPanel } from "./SshCommandBlocksPanel";
import { setCmdPanelOpen, useCmdPanelOpen } from "../../lib/terminalPanelStore";
import { useTerminalTabMeta, type TermTabMetaPatch } from "../../hooks/useTerminalTabMeta";
import { useClipboardImagePaste } from "../../hooks/useClipboardImagePaste";
import { forceRepaint } from "../../lib/terminalRepaint";
import { invoke } from "../../lib/tauri";
import { toast } from "../ui/toast";
import { useTerminalThemeMode } from "../../hooks/useTerminalAppearance";
import { useTerminalPreset, useTerminalInject } from "../../hooks/useTerminalPreset";
import { useTerminalOsc } from "../../hooks/useTerminalOsc";
import { useTerminalProtocol } from "../../hooks/useTerminalProtocol";
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
  /** 复制行为设置项：拖拽即选 / 选中即复制（ref 承接与消费都在 useSshTerminalSelect，这里只透传）。 */
  dragSelectEnabled: boolean;
  copyOnSelectEnabled: boolean;
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
  copyOnSelectEnabled,
  fullscreen,
  onToggleFullscreen,
  onCwd,
  onMeta,
  onOpenFilePath,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const focusedRef = useRef(false); // 供 window 级键盘监听判断本会话是否聚焦
  const mode = useTerminalThemeMode();
  const preset = useTerminalPreset();
  const inject = useTerminalInject();
  const closed = closedReason !== null;

  const select = useSshTerminalSelect({ termRef, focusedRef, dragSelectEnabled, copyOnSelectEnabled });
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
    attachSelect: select.attach,
    copySelection: select.copySelection,
    attachSearch: search.attach,
    openSearch: search.openSearch,
  });
  const font = useTerminalTypography({ termRef, containerRef, doFit });
  // 远端状态探测：注入钩子 + 解析 OSC。钩子关闭 / 不支持时自动降级，终端本身不受影响。
  const { status, state } = useTerminalOsc({ sessionId, enabled: inject, closed, termRef });
  // 终端协议接缝：OSC 7501（远端自报「在干活 / 在等确认」）+ DEC 2031（主题变化通知）。
  const agent = useTerminalProtocol({ sessionId, closed, mode, termRef, visible, label: conn.name || conn.host });
  // closed / cwd 用 ref 承接：window 键盘监听只挂一次，闭包要总读到最新值。
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const cwdRef = useRef(status.cwd);
  cwdRef.current = status.cwd;
  // 剪贴板图片 → SFTP 上传远端 → 路径插入输入行（Ctrl+Shift+V / 工具栏按钮）。
  const { busy: imgBusy, pasteImage } = useClipboardImagePaste({ sessionId, connId: conn.id, closed });
  const pasteImageRef = useRef(pasteImage);
  pasteImageRef.current = pasteImage;

  // 把远端 cwd 上报给父级（拖拽上传的目标目录）。ref 承接：内联箭头不能进依赖。
  const onCwdRef = useRef(onCwd);
  onCwdRef.current = onCwd;
  useEffect(() => onCwdRef.current(status.cwd), [status.cwd]);

  // 滚轮归属四态 + 翻转引导 + 救急面板开关（逻辑在 hooks/useWheelGuide.ts，这里只消费）。
  const wheel = useWheelGuide({ sessionId, closed, termRef, containerRef });
  // 输出里的远端绝对路径 → 可点击（注册在 web-links 之后，URL 仍归它）。
  const onOpenFilePathRef = useRef(onOpenFilePath);
  onOpenFilePathRef.current = onOpenFilePath;
  // 🔴 依赖从 `[]` 改成 `[sessionId]`：本 effect 同时管两处登记，而重连会换 sessionId，
  // 全局终端注册表（跨标签搜索取实例用）的 key 必须跟着换。重挂路径链接无害（dispose 摘旧的）。
  // （term 由 session hook 的 effect 创建，它先于本 effect 运行，所以这里 termRef 一定有值。）
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const offLink = registerPathLinkProvider(term, (p) => onOpenFilePathRef.current(p));
    const offRegistry = registerTerminal(sessionId, term);
    return () => {
      offLink();
      offRegistry();
    };
  }, [sessionId]);

  // 终端聚焦时的 window capture 快捷键（🔴 不能走 attachTerminalKeymap——xterm 的 custom
  // key handler 是单槽位、session hook 已占用；capture 先于 xterm 的 textarea 处理）。
  useEffect(() => {
    const send = (data: string) => {
      if (closedRef.current) return;
      void invoke("ssh_input", { sessionId, data });
    };
    const onKey = (e: KeyboardEvent) => {
      if (!focusedRef.current || e.isComposing) return;
      // 命令导航：Ctrl+Shift+↑/↓ 跳到上一条/下一条命令的提示符行。
      if (e.ctrlKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        const term = termRef.current;
        if (!term) return;
        const dir = e.key === "ArrowUp" ? -1 : 1;
        if (!navJump(term, dir)) {
          toast(dir === -1 ? "没有更早的命令了" : "已经是最新的命令了", "info");
        }
        return;
      }
      // Shift+Enter → LF / Alt+Enter → ESC+CR：多行换行。Claude Code 把 LF 当换行、
      // \r 当提交（shell readline 对 LF 同样 accept-line，与 Ctrl+J 等价，零副作用）。
      // 🔴 必须绕开 useTerminalPaste——preparePaste 会把 \n 规范成 \r，语义就错了。
      if (e.key === "Enter" && !e.ctrlKey) {
        const seq = e.shiftKey && !e.altKey ? "\n" : e.altKey && !e.shiftKey ? "\x1b\r" : null;
        if (seq !== null) {
          e.preventDefault();
          e.stopPropagation();
          send(seq);
          return;
        }
      }
      // Ctrl+Shift+V → 剪贴板图片上传远端。必须在 xterm keymap 的 Ctrl+V 分支
      // （ctrl+key 是 v/V 都命中）之前拦下，否则会当成文本粘贴。
      if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
        e.preventDefault();
        e.stopPropagation();
        void pasteImageRef.current(cwdRef.current);
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sessionId]);

  // 标签 meta 上报（标题/进度/铃）。后台标签收到 BEL 才 toast：正盯着看时不必再弹。
  useTerminalTabMeta({
    termRef,
    closed,
    onMeta: (p) => {
      if (p.bellAt != null && !visible)
        toast(`${conn.name || conn.host}：终端有铃声（可能需要关注）`, "info");
      onMeta(p);
    },
    // OSC 9 通知带正文，是远端程序的显式提醒（如 Claude 的「任务完成/需要确认」）：
    // 无论标签是否活跃都弹——用户盯着看时多一条 toast 无伤大雅，切走了错过才是损失。
    onNotify: (text) => toast(`${conn.name || conn.host}：${text}`, "info"),
  });

  // 导出整个滚动历史（「更多」菜单里的「导出终端内容…」）。断开态也能用。
  const exportSession = useTerminalExport(termRef, conn.name || conn.host);
  // 命令历史面板：开关在模块级 store（触发按钮在工具栏），面板挂在本会话容器内。
  const cmdOpen = useCmdPanelOpen();

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
        onPasteImage={() => void pasteImage(cwdRef.current)}
        imgBusy={imgBusy}
        onRepaint={() => forceRepaint(termRef.current)}
        onSearch={search.openSearch}
        onToggleSelectMode={select.toggleSelectMode}
        onClear={() => termRef.current?.clear()}
        onToggleFullscreen={onToggleFullscreen}
        onExport={exportSession}
      />
      <TerminalStatusBar
        sessionId={sessionId}
        conn={conn}
        preset={preset}
        mode={mode}
        status={status}
        agent={agent}
        state={state}
        closed={closed}
        owner={wheel.owner}
        onDeadClick={wheel.openPopover}
        deadBadgeExpanded={wheel.popoverOpen}
        tuiGuideHint={wheel.guide === "collapsed"}
        onGuideHintClick={wheel.expandGuide}
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
        {cmdOpen && (
          <SshCommandBlocksPanel termRef={termRef} name={conn.name || conn.host} closed={closed} onClose={() => setCmdPanelOpen(false)} />
        )}
        {/* 覆盖层，不占布局（占高度会 fit→远端 TUI 重排，详见 TuiGuideBar 头注）。
            外层 padding 也要 pointer-events-none，否则终端顶部一整条横带成点击/选中死区。 */}
        {wheel.guide === "open" && !closed && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 p-2">
            <TuiGuideBar flips={wheel.flips} onSend={wheel.openSendConfirm} onDismiss={wheel.dismissForever} onCollapse={wheel.collapseGuide} />
          </div>
        )}
        {wheel.popoverOpen && !closed && (
          <WheelOwnerPopover sessionId={sessionId} initialStep={wheel.popStep} onSent={wheel.markSent} onClose={wheel.closePopover} />
        )}
        {font.badge !== null && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/70 px-3.5 py-1.5 text-xs tracking-wide text-white">
            字号 {font.badge}
          </div>
        )}
      </div>
      {/* 右键菜单层已抽到 SshTerminalContextMenu.tsx（本文件紧贴 300 行棘轮线）。 */}
      <SshTerminalContextMenu
        containerRef={containerRef}
        hasSelection={select.hasSelection}
        pasteDisabled={closed}
        onCopy={select.copySelection}
        onPaste={paste}
        onSelectAll={() => termRef.current?.selectAll()}
      />
    </div>
  );
}
