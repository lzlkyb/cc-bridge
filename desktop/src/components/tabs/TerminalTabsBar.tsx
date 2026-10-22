import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { TerminalGlobalSearch } from "./TerminalGlobalSearch";
import { setCmdPanelOpen } from "../../lib/terminalPanelStore";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { TermTabMeta } from "../../lib/terminalTabMeta";
import type { IProgressState } from "@xterm/addon-progress";
import { terminalSessionOrdinal } from "../../lib/terminalWorkspace";
import { TitleBarControls } from "../layout/TitleBarControls";
import { useTerminalFullscreenActions } from "./TerminalFullscreenContext";

interface TerminalTabsBarProps {
  fullscreen?: boolean;
  onExitFullscreen?: () => void;
  splitControls?: ReactNode;
  onToolbarReady?: (node: HTMLDivElement | null) => void;
  sessions: SshSessionRef[];
  /** 各会话的标签 meta（标题/进度/铃），由 SshTerminal 上报。 */
  metaBySession: Record<string, TermTabMeta>;
  activeId: string | null;
  onActivate: (sessionId: string) => void;
  /** 已连接的会话点 ×：断开（但保留标签）。 */
  onDisconnect: (sessionId: string) => void;
  /** 已断开的会话点 ×：真正移除标签。 */
  onCloseTab: (sessionId: string) => void;
  /** 对当前活动连接另开一个终端；null = 没有可另开的目标（按钮隐藏）。 */
  onNewTerminal: (() => void) | null;
  /** 开/关当前标签的分屏（轻量双栏）；null = 没有活动标签（按钮隐藏）。 */
  onToggleSplit: (() => void) | null;
  /** 当前标签是否处于分屏态（按钮高亮）。 */
  splitActive: boolean;
}

/** OSC 9;4 进度条在标签底部的配色与几何（进度条条宽按 value%）。 */
function progressStyle(p: IProgressState): { className: string; width: string } {
  switch (p.state) {
    case 1:
      return { className: "bg-primary", width: `${Math.min(100, Math.max(0, p.value))}%` };
    case 2:
      return { className: "bg-destructive", width: `${Math.min(100, Math.max(0, p.value)) || 100}%` };
    case 3:
      return { className: "bg-primary animate-pulse", width: "100%" };
    case 4:
      return { className: "bg-amber-500", width: `${Math.min(100, Math.max(0, p.value)) || 100}%` };
    default:
      return { className: "", width: "0%" };
  }
}

/**
 * 终端标签栏：多会话时顶部横向标签。
 *
 * × 的语义分两档：**已连接 → 断开（标签保留）；已断开 → 关闭标签**。
 * 这个 11px 的 × 本来是一点就断、无确认；现在第一下只是进入可重连的断开态，
 * 误点不再丢历史输出——比加二次确认好，不多一步点击。
 *
 * meta 增强（P0 批次）：标题（OSC 0/2，显示为 `主机 ▸ 程序名`——标题**只作附加段**，
 * 不可顶替主机名，防「标题诈骗」）、进度条（OSC 9;4，贴标签底部）、未读铃点（BEL，
 * 激活标签即清零）。
 */
export function TerminalTabsBar({
  fullscreen = false,
  onExitFullscreen,
  splitControls,
  onToolbarReady,
  sessions,
  metaBySession,
  activeId,
  onActivate,
  onDisconnect,
  onCloseTab,
  onNewTerminal,
  onToggleSplit,
  splitActive,
}: TerminalTabsBarProps) {
  const fullscreenActions = useTerminalFullscreenActions();
  const activeRef = useRef<HTMLDivElement>(null);
  // 跨标签搜索浮层。它是 `fixed` 定位，所以放在这条 `overflow-x-auto` 里也不会被裁剪
  // （定位于视口，不参与这条 flex 布局）——省掉一层 Fragment 包裹与整块缩进。
  const [searchOpen, setSearchOpen] = useState(false);
  // 标签多了会溢出横向滚动区，新连的会话可能落在可视区外，看着像「没反应」。
  // block: "nearest" 避免把页面垂直方向也拉跑了。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  // 副格不占标签位置，但与窗格标题共用会话序号，避免同一会话出现两个名字。
  const tabSessions = sessions.filter((s) => !s.splitOnly);

  return (
    <div className="terminal-tabs-header flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1.5" data-fullscreen={fullscreen || undefined}>
      <div className="terminal-tabs-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="终端会话">
      {tabSessions.map((s) => {
        const closed = !!s.closedReason;
        const active = s.sessionId === activeId;
        const seq = terminalSessionOrdinal(sessions, s);
        const meta = metaBySession[s.sessionId];
        const title = !closed ? meta?.title : null;
        const hasBell = !closed && meta?.bellAt != null;
        const progress = !closed ? meta?.progress : null;
        const bar = progress && progress.state !== 0 ? progressStyle(progress) : null;
        return (
          <div
            key={s.tabId}
            ref={active ? activeRef : undefined}
            className={`relative flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
              active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onActivate(s.sessionId)}
              className="terminal-session-tab flex items-center gap-1.5"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  closed
                    ? "bg-destructive/60"
                    : active
                      ? "bg-green-500"
                      : "bg-muted-foreground/40"
                }`}
              />
              <span
                className={`min-w-0 max-w-48 truncate ${closed ? "line-through opacity-70" : ""}`}
                title={s.conn.name || s.conn.host}
              >
                {s.conn.name || s.conn.host}
              </span>
              {/* 标题只作主机名的附加段：正常程序可显示，恶意标题顶不掉主机名。 */}
              {title && (
                <span className="terminal-session-title max-w-40 truncate font-mono text-muted-foreground" title={title}>▸ {title}</span>
              )}
              {seq && (
                <span className="rounded bg-muted-foreground/15 px-1 font-mono text-[11px]">
                  #{seq}
                </span>
              )}
              {s.conn.authType === "key" && <span>🔑</span>}
              {hasBell && <Icon name="bell" size={11} className="text-amber-500" />}
            </button>
            <button
              type="button"
              onClick={() => {
                // 真正移除标签时顺手收起「命令历史」面板：那是个全局开关，而面板本体挂在
                // 各会话自己的容器里——不关的话，标签一消失它就在相邻标签上自己打开，
                // 用户没点过任何东西。断开（保留标签）不关，那时继续看记录是合理的。
                if (closed) setCmdPanelOpen(false);
                return closed ? onCloseTab(s.sessionId) : onDisconnect(s.sessionId);
              }}
              className="terminal-session-close rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive-ink"
              title={closed ? "关闭标签" : "断开（标签保留，可重连）"}
            >
              <Icon name="close" size={14} />
            </button>
            {/* OSC 9;4 进度：贴标签底缘的 2px 细条，激活与否都显示（后台任务也要看得见）。 */}
            {bar && (
              <div className="absolute inset-x-1.5 bottom-0 h-0.5 overflow-hidden rounded-full bg-muted-foreground/15">
                <div
                  className={`h-full rounded-full transition-[width] duration-200 ${bar.className}`}
                  style={{ width: bar.width }}
                />
              </div>
            )}
          </div>
        );
      })}
      </div>
      <div className="terminal-tabs-actions flex shrink-0 items-center gap-1">
      {/* 跨标签搜索入口（和当前终端查找分开）。
          与工具栏的「搜索」区别：那个只搜当前标签，这个横跨所有会话的滚动历史。 */}
      {!fullscreen && <button
        type="button"
        onClick={() => setSearchOpen(true)}
        title="搜索所有标签的终端内容（含已断开标签的历史）"
        aria-label="搜索所有标签"
        className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Icon name="search" size={16} /><span className="terminal-action-label">搜索所有标签</span>
      </button>}
      {onNewTerminal && (
        <button
          type="button"
          onClick={onNewTerminal}
          title="对当前连接再开一个终端"
          aria-label="新终端"
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Icon name="plus" size={16} /><span className="terminal-action-label">新终端</span>
        </button>
      )}
      {onToggleSplit && !splitActive && (
        <button
          type="button"
          onClick={onToggleSplit}
          title="分屏：在旁边再开一个会话（Ctrl+Shift+D）"
          aria-label="分屏"
          aria-pressed={splitActive}
          className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
            splitActive
              ? "bg-primary/10 text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <Icon name="monitor" size={16} /><span className="terminal-action-label">分屏</span>
        </button>
      )}
      </div>
      {fullscreen && <><div className="terminal-fullscreen-drag" data-tauri-drag-region title="拖动窗口"/>{fullscreenActions.safety}</>}
      {splitControls}
      <div className="terminal-toolbar-host" ref={onToolbarReady} aria-label="当前窗格操作"/>
      {fullscreen && <div className="terminal-fullscreen-window" data-tauri-drag-region="false">
        <button type="button" className="terminal-fullscreen-exit" aria-label="退出终端全屏（F11）" title="退出终端全屏（F11）" onClick={onExitFullscreen}><Icon name="collapse" size={16}/><span>退出全屏</span><kbd>F11</kbd></button>
        <TitleBarControls/>
      </div>}
      {searchOpen && (
        <TerminalGlobalSearch
          sessions={sessions}
          onActivate={onActivate}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}
