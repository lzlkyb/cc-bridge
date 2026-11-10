import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { TerminalGlobalSearch } from "./TerminalGlobalSearch";
import { TabRenameInput } from "./TerminalTabRename";
import { setCmdPanelOpen } from "../../lib/terminalPanelStore";
import type { SshSessionRef } from "./TerminalConnectionItem";
import { progressStyle, type TermTabMeta } from "../../lib/terminalTabMeta";
import { tabAgentMissingHint } from "../../lib/terminalTabAgent";
import { useScrollFade } from "../../hooks/useScrollFade";
import { TerminalTabAgentBadge } from "./TerminalTabAgentBadge";
import { TerminalTabAttentionPill } from "./TerminalTabAttentionPill";
import { terminalSessionOrdinal } from "../../lib/terminalWorkspace";
import { TitleBarControls } from "../layout/TitleBarControls";
import { useTerminalFullscreenActions } from "./TerminalFullscreenContext";
import { TerminalFullscreenDragStrip } from "./TerminalFullscreenDragStrip";

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
  /** 已连接会话使用断开按钮，保留标签与历史。 */
  onDisconnect: (sessionId: string) => void;
  /** 已断开的会话点 ×：真正移除标签。 */
  onCloseTab: (sessionId: string) => void;
  /** 当前活动连接另开一个终端；null = 没有可另开的目标（按钮隐藏）。 */
  onNewTerminal: (() => void) | null;
  /** 重命名标签（双击标签名）；null = 不支持（隐藏重命名入口）。 */
  onRename?: ((tabId: string, label: string) => void) | null;
  /** 开/关当前标签的分屏（轻量双栏）；null = 没有活动标签（按钮隐藏）。 */
  onToggleSplit: (() => void) | null;
  /** 当前标签是否处于分屏态（按钮高亮）。 */
  splitActive: boolean;
}

/**
 * 终端标签栏：多会话时顶部横向标签。
 *
 * 连接期间明确显示断开图标；已断开时才显示关闭标签的 ×，历史仍可查看。
 *
 * meta 增强（P0 批次）：标题（OSC 0/2，显示为 `主机 ▸ 程序名`——标题**只作附加段**，
 * 不可顶替主机名，防「标题诈骗」）、进度条（OSC 9;4，贴标签底部）、未读铃点（BEL，
 * 激活标签即清零）。
 *
 * CC 运行态徽标（2026-11-02）：标题之后那个 12px 图标来自 OSC 7501 的**程序自报**
 * （转圈=干活中 / 琥珀点=等确认 / ✓=已完成 / △=出错）。状态栏里也有一份同样的状态，
 * 但那只属于当前可见的 pane——多标签时全靠这个徽标才知道该切到哪个标签。见
 * `TerminalTabAgentBadge.tsx`。
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
  onRename,
  onToggleSplit,
  splitActive,
}: TerminalTabsBarProps) {
  const fullscreenActions = useTerminalFullscreenActions();
  const activeRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useScrollFade<HTMLDivElement>();
  // 跨标签搜索浮层。它是 `fixed` 定位，所以放在这条 `overflow-x-auto` 里也不会被裁剪
  // （定位于视口，不参与这条 flex 布局）——省掉一层 Fragment 包裹与整块缩进。
  const [searchOpen, setSearchOpen] = useState(false);
  // 正在重命名的标签（双击标签名进入；见 TerminalTabRename）。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Ctrl+Shift+G 打开跨标签搜索。此前只有标签栏那个按钮，键盘用户必须摸鼠标。
  // 🔴 必须 capture + stopPropagation：xterm 把 Ctrl+G 映射成 \x07（BEL），不抢在它
  // 前面按一下就会往远端发一个响铃（还会点亮标签的未读铃点）。
  // 只在终端页可见时接：App 用 display:none 隐藏本页来保活 SSH 会话，此时 offsetParent 为 null。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "g") return;
      if (!rootRef.current?.offsetParent) return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // 标签多了会溢出横向滚动区，新连的会话可能落在可视区外，看着像「没反应」。
  // block: "nearest" 避免把页面垂直方向也拉跑了。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  // 副格不占标签位置，但与窗格标题共用会话序号，避免同一会话出现两个名字。
  const tabSessions = sessions.filter((s) => !s.splitOnly);

  return (
    <div ref={rootRef} className="terminal-tabs-header flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1.5" data-fullscreen={fullscreen || undefined}>
      <div ref={scrollRef} className="terminal-tabs-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="终端会话">
      {tabSessions.map((s, index) => {
        const closed = !!s.closedReason;
        const active = s.sessionId === activeId;
        const seq = terminalSessionOrdinal(sessions, s);
        const meta = metaBySession[s.sessionId];
        const title = !closed ? meta?.title : null;
        const hasBell = !closed && meta?.bellAt != null;
        const progress = !closed ? meta?.progress : null;
        const bar = progress && progress.state !== 0 ? progressStyle(progress) : null;
        // CC 运行态（OSC 7501）。🔴 断开后一律 null：标签上挂着一个转圈而会话其实早就断了，
        // 是最坏的一种错信息——比不显示更糟。
        const agent = closed ? null : (meta?.agent ?? null);
        // 未读只在需要你看的那一档有意义；断开态同 agent 一起归零，免得留下一个暗掉的 ✓。
        const agentUnread = !closed && (meta?.agentUnread ?? false);
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
              tabIndex={active || !tabSessions.some(tab => tab.sessionId === activeId) && index === 0 ? 0 : -1}
              aria-selected={active}
              onClick={() => onActivate(s.sessionId)}
              onKeyDown={event => {
                const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                const next = event.key === "Home" ? 0 : event.key === "End" ? tabSessions.length - 1 : step ? (index + step + tabSessions.length) % tabSessions.length : -1;
                if (next < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
                event.preventDefault(); event.stopPropagation();
                onActivate(tabSessions[next].sessionId);
                event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
              }}
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
                // 同名不同主机的连接光看标签名分不出，tooltip 里带完整登录地址 + 会话序号。
                // 旧版 CC（< 2.1.295）不发 OSC 7501：有 TUI 标题却没有任何上报时补一句弱提示，
                // 免得用户以为是我们的徽标坏了（纯 shell 标签不加，它没有 CC 可报）。
                title={`${s.label || s.conn.name || s.conn.host} · ${s.conn.username}@${s.conn.host}:${s.conn.port}${seq ? ` · #${seq}` : ""}${tabAgentMissingHint(!!title, agent)}`}
                onDoubleClick={() => onRename && setRenamingId(s.tabId)}
              >
                {renamingId === s.tabId ? (
                  <TabRenameInput
                    initial={s.label ?? s.conn.name ?? s.conn.host}
                    onCommit={v => {
                      setRenamingId(null);
                      onRename?.(s.tabId, v);
                    }}
                    onCancel={() => setRenamingId(null)}
                  />
                ) : (
                  s.label || s.conn.name || s.conn.host
                )}
              </span>
              {/* 标题只作主机名的附加段：正常程序可显示，恶意标题顶不掉主机名。 */}
              {title && (
                <span className="terminal-session-title max-w-40 truncate font-mono text-muted-foreground" title={title}>▸ {title}</span>
              )}
              {/* CC 运行态徽标：放在标题之后、序号之前——不挤铃和按钮，也和「当前标签」那个绿点分开。 */}
              <TerminalTabAgentBadge agent={agent} unread={agentUnread} />
              {seq && (
                <span className="rounded bg-muted-foreground/15 px-1 font-mono text-[11px]">
                  #{seq}
                </span>
              )}
              {s.conn.authType === "key" && <span>🔑</span>}
              {closed && <span className="sr-only">，已断开</span>}
              {hasBell && <Icon name="bell" size={11} className="text-amber-500" />}
            </button>
            {/* 🔴 断开与关闭必须是**两个独立按钮**。这里曾共用一个按状态换行为的按钮：
                连着时是断开、断开后变关闭，于是双击 × = 「断开 + 永久删除标签」，
                该终端全部历史输出跟着 xterm.dispose() 一起没，既没有确认也没有撤销。
                现在 power 恒为断开（断开后禁用、位置不动），✕ 只在已断开时追加在它右侧——
                双击的第二下仍落在原坐标（禁用的 power）上，不会误删。 */}
            <button
              type="button"
              tabIndex={active && !closed ? 0 : -1}
              disabled={closed}
              aria-label={
                closed
                  ? `已断开：${s.conn.name || s.conn.host}`
                  : `断开会话，保留历史：${s.conn.name || s.conn.host}`
              }
              onClick={() => onDisconnect(s.sessionId)}
              className="terminal-session-power rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              title={closed ? "已断开（历史仍可查看）" : "断开会话，保留历史与重连入口"}
            >
              <Icon name="power" size={16} />
            </button>
            {closed && (
              <button
                type="button"
                tabIndex={active ? 0 : -1}
                aria-label={`关闭标签：${s.conn.name || s.conn.host}`}
                onClick={() => {
                  // 真正移除标签时顺手收起「命令历史」面板：那是个全局开关，而面板本体挂在
                  // 各会话自己的容器里——不关的话，标签一消失它就在相邻标签上自己打开，
                  // 用户没点过任何东西。
                  setCmdPanelOpen(false);
                  onCloseTab(s.sessionId);
                }}
                className="terminal-session-close rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive-ink"
                title="关闭标签——该终端的历史输出会一起清除，不可恢复"
              >
                <Icon name="close" size={16} />
              </button>
            )}
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
      {/* 待处理汇总：放在滚动区与操作按钮之间——它汇总的是标签，不是操作。见 TerminalTabAttentionPill。 */}
      <TerminalTabAttentionPill tabs={tabSessions} metaBySession={metaBySession} activeId={activeId} onActivate={onActivate} />
      <div className="terminal-tabs-actions flex shrink-0 items-center gap-1">
      {/* 跨标签搜索入口（和当前终端查找分开）。
          与工具栏的「搜索」区别：那个只搜当前标签，这个横跨所有会话的滚动历史。 */}
      {!fullscreen && <button
        type="button"
        onClick={() => setSearchOpen(true)}
        title="搜索所有标签的终端内容（含已断开标签的历史，Ctrl+Shift+G）"
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
      {fullscreen && <><TerminalFullscreenDragStrip />{fullscreenActions.safety}</>}
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
