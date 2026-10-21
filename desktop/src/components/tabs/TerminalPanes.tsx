import { useRef, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { SshTerminal } from "./SshTerminal";
import { RestoredTabPlaceholder } from "./TerminalRestore";
import type { SplitInfo } from "./useTerminalSplit";
import type { SshConnection } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { TermTabMetaPatch } from "../../hooks/useTerminalTabMeta";
import { focusedTerminalSession, terminalSessionOrdinal } from "../../lib/terminalWorkspace";
import { TerminalPaneFrame } from "./TerminalPaneFrame";
import { useTerminalPaneLayout } from "../../hooks/useTerminalPaneLayout";

interface TerminalPanesProps {
  sessions: SshSessionRef[];
  activeId: string | null;
  /** 活动标签的分屏信息；null = 单格。 */
  split: SplitInfo | null;
  toolbarHost: HTMLDivElement | null;
  focusedTabId: string | null;
  onFocusPane: (tabId: string) => void;
  connections: SshConnection[];
  connectingId: string | null;
  emptyState: ReactNode;
  dragSelectEnabled: boolean;
  copyOnSelectEnabled: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClosed: (s: SshSessionRef, reason: string) => void;
  onReconnect: (s: SshSessionRef) => void;
  onCloseTab: (s: SshSessionRef) => void;
  onCwd: (sessionId: string, cwd: string | null) => void;
  onMeta: (sessionId: string, patch: TermTabMetaPatch) => void;
  onOpenFilePath: (conn: SshConnection, path: string) => void;
  onPickSplitConn: (conn: SshConnection) => void;
  onCloseSplit: () => void;
  onToggleDir: () => void;
  onSplitRatio: (ratio: number) => void;
  onZoomPane: (tabId: string) => void;
  onDisconnect: (sessionId: string) => void;
}

/**
 * 终端窗格区：全部会话的挂载层 + 轻量双栏布局（方案 A）。
 *
 * 🔴 **会话包装 div 必须保持稳定**：所有会话都以 tabId 为 key 挂在同一父节点下，
 * 分屏开合只改这些包装 div 的 style（flex/none）与父节点的 flex 方向——
 * React 按 key 复用节点，SshTerminal 与它的 xterm 实例、历史输出**不重挂**。
 * 分割条是插在兄弟中间的独立元素，同样不破坏 keyed 复用。
 *
 * 活动标签的分屏由父级传入（split）；其它标签的分屏副格走 display:none 照常收输出。
 */
export function TerminalPanes({
  sessions,
  activeId,
  split,
  toolbarHost,
  focusedTabId,
  onFocusPane,
  connections,
  connectingId,
  emptyState,
  dragSelectEnabled,
  copyOnSelectEnabled,
  fullscreen,
  onToggleFullscreen,
  onClosed,
  onReconnect,
  onCloseTab,
  onCwd,
  onMeta,
  onOpenFilePath,
  onPickSplitConn,
  onCloseSplit,
  onToggleDir,
  onSplitRatio,
  onZoomPane,
  onDisconnect,
}: TerminalPanesProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const primary = split ? (sessions.find((s) => s.sessionId === activeId) ?? null) : null;
  const sec = split?.secTabId ? (sessions.find((s) => s.tabId === split.secTabId) ?? null) : null;
  const splitActive = split !== null && primary !== null;
  const vertical = split?.dir === "v";
  const focused = focusedTerminalSession(sessions, activeId, split, focusedTabId);
  const zoomed = splitActive && (split?.zoomedTabId === primary?.tabId || split?.zoomedTabId === sec?.tabId) ? split?.zoomedTabId : null;
  const layout = useTerminalPaneLayout(areaRef, split, onSplitRatio);

  // 会话包装 div 的定位：非分屏 = 绝对定位叠放（原行为）；分屏的两个格 = flex 项。
  const wrapStyle = (s: SshSessionRef): CSSProperties => {
    if (zoomed && (s.tabId === primary?.tabId || s.tabId === sec?.tabId)) {
      return { display: s.tabId === zoomed ? "flex" : "none", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 };
    }
    if (splitActive && primary && s.tabId === primary.tabId) {
      return { display: "flex", flexDirection: "column", order: 0, flex: `0 0 calc(${layout.ratio}% - ${6 * layout.ratio / 100}px)`, minWidth: 0, minHeight: 0 };
    }
    if (splitActive && sec && s.tabId === sec.tabId) {
      return { display: "flex", flexDirection: "column", order: 2, flex: 1, minWidth: 0, minHeight: 0 };
    }
    return { position: "absolute", inset: 0, display: s.sessionId === activeId ? "block" : "none" };
  };

  return (
    <div
      ref={areaRef}
      className={`terminal-panes relative min-h-0 flex-1 ${splitActive ? (vertical ? "flex flex-col" : "flex") : ""}`}
    >
      {sessions.length === 0 ? (
        emptyState
      ) : (
        <>
          {sessions.map((s) => {
            const isSec = splitActive && sec != null && s.tabId === sec.tabId;
            const isPane = splitActive && (isSec || s.sessionId === activeId);
            const ordinal = terminalSessionOrdinal(sessions, s);
            const label = `${s.conn.name || s.conn.host}${ordinal ? ` #${ordinal}` : ""}`;
            return (
              <TerminalPaneFrame key={s.tabId} session={s} label={label} splitPane={isPane} focused={focused?.tabId === s.tabId} zoomed={zoomed === s.tabId}
                style={wrapStyle(s)} onFocus={() => onFocusPane(s.tabId)} onZoom={() => { onFocusPane(s.tabId); onZoomPane(s.tabId); }}>
                {localHost => <>
                {/* 会话恢复占位（closedReason: "restored" 哨兵）：不挂 SshTerminal——
                    假 sessionId 没有对应 PTY，挂上去只会拿到一堆报错。 */}
                {s.closedReason === "restored" ? (
                  <RestoredTabPlaceholder s={s} onReconnect={() => onReconnect(s)} onCloseTab={() => onCloseTab(s)} />
                ) : (
                  <SshTerminal
                    sessionId={s.sessionId}
                    toolbarHost={isPane ? localHost : toolbarHost}
                    toolbarActive={focused?.tabId === s.tabId}
                    pane={isPane ? (vertical ? "stacked" : "pane") : undefined}
                    onDisconnect={() => onDisconnect(s.sessionId)}
                    conn={s.conn}
                    closedReason={s.closedReason}
                    onClosed={(reason) => onClosed(s, reason)}
                    // 重连回**这个**标签：同一连接可能有多个标签，不指定就可能接到别人头上。
                    onReconnect={() => onReconnect(s)}
                    onCloseTab={() => onCloseTab(s)}
                    visible={zoomed ? s.tabId === zoomed : s.sessionId === activeId || isSec}
                    dragSelectEnabled={dragSelectEnabled}
                    copyOnSelectEnabled={copyOnSelectEnabled}
                    fullscreen={fullscreen}
                    onToggleFullscreen={onToggleFullscreen}
                    onCwd={(cwd) => onCwd(s.sessionId, cwd)}
                    onMeta={(p) => onMeta(s.sessionId, p)}
                    onOpenFilePath={(p) => onOpenFilePath(s.conn, p)}
                  />
                )}
                </>}
              </TerminalPaneFrame>
            );
          })}
          {/* 分屏选择态：副格还没选连接 */}
          {splitActive && !sec && !zoomed && (
            <div style={{ order: 2, flex: 1, minWidth: 0, minHeight: 0 }} className="relative overflow-auto">
              <SplitPicker
                connections={connections}
                connectingId={connectingId}
                vertical={!!vertical}
                onPick={onPickSplitConn}
                onToggleDir={onToggleDir}
                onClose={onCloseSplit}
              />
            </div>
          )}
          {splitActive && !zoomed && (
            <div
              role="separator" tabIndex={0} aria-label="调整分屏比例" aria-orientation={vertical ? "horizontal" : "vertical"}
              aria-valuenow={Math.round(layout.ratio)} aria-valuemin={Math.round(layout.min)} aria-valuemax={Math.round(layout.max)}
              onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={layout.move}
              onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onKeyDown={layout.keyDown}
              onDoubleClick={() => onSplitRatio(50)} className="terminal-splitter" data-direction={vertical ? "v" : "h"}
              title="拖动或方向键调整比例，双击恢复均分"
            >
              <div className="terminal-splitter-handle"/>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 副格连接选择器：分屏按钮点下后先显示这里，选中即连接。 */
function SplitPicker({
  connections,
  connectingId,
  vertical,
  onPick,
  onToggleDir,
  onClose,
}: {
  connections: SshConnection[];
  connectingId: string | null;
  vertical: boolean;
  onPick: (conn: SshConnection) => void;
  onToggleDir: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center gap-2.5 overflow-y-auto bg-card/70 p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        选择要在旁边打开的连接
        <button
          type="button"
          onClick={onToggleDir}
          className="rounded border border-border px-1.5 py-0.5 hover:border-primary hover:text-foreground"
        >
          {vertical ? "上下 ⇅" : "左右 ⇆"}
        </button>
      </div>
      <div className="w-full max-w-64 space-y-1">
        {connections.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={connectingId === c.id}
            onClick={() => onPick(c)}
            className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-left text-xs hover:border-primary disabled:opacity-50"
          >
            <Icon name="server" size={12} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{c.name || c.host}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">
              {connectingId === c.id ? "连接中…" : `${c.username}@${c.host}`}
            </span>
          </button>
        ))}
        {connections.length === 0 && (
          <div className="py-2 text-center text-xs text-muted-foreground">还没有连接，先在左侧新建一个</div>
        )}
      </div>
      <button type="button" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
        取消分屏
      </button>
    </div>
  );
}
