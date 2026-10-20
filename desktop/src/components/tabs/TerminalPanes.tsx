import { useRef, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { SshTerminal } from "./SshTerminal";
import { RestoredTabPlaceholder } from "./TerminalRestore";
import type { SplitInfo } from "./useTerminalSplit";
import type { SshConnection } from "../../lib/types";
import type { SshSessionRef } from "./TerminalConnectionItem";
import type { TermTabMetaPatch } from "../../hooks/useTerminalTabMeta";
import { focusedTerminalSession } from "../../lib/terminalWorkspace";

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
}: TerminalPanesProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const primary = split ? (sessions.find((s) => s.sessionId === activeId) ?? null) : null;
  const sec = split?.secTabId ? (sessions.find((s) => s.tabId === split.secTabId) ?? null) : null;
  const splitActive = split !== null && primary !== null;
  const vertical = split?.dir === "v";
  const focused = focusedTerminalSession(sessions, activeId, split, focusedTabId);

  // 会话包装 div 的定位：非分屏 = 绝对定位叠放（原行为）；分屏的两个格 = flex 项。
  const wrapStyle = (s: SshSessionRef): CSSProperties => {
    if (splitActive && primary && s.tabId === primary.tabId) {
      return { display: "flex", flexDirection: "column", order: 0, flex: `0 0 calc(${split.ratio}% - 3px)`, minWidth: 0 };
    }
    if (splitActive && sec && s.tabId === sec.tabId) {
      return { display: "flex", flexDirection: "column", order: 2, flex: 1, minWidth: 0 };
    }
    return { position: "absolute", inset: 0, display: s.sessionId === activeId ? "block" : "none" };
  };

  const onSplitterDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const area = areaRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const pct =
        vertical === false
          ? ((ev.clientX - rect.left) / rect.width) * 100
          : ((ev.clientY - rect.top) / rect.height) * 100;
      onSplitRatio(pct);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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
            return (
              <div key={s.tabId} style={wrapStyle(s)} onPointerDown={() => onFocusPane(s.tabId)} onFocusCapture={() => onFocusPane(s.tabId)} data-focused={focused?.tabId === s.tabId || undefined}>
                {splitActive && (isSec || s.sessionId === activeId) && (
                  <PaneHead
                    s={s}
                    focused={focused?.tabId === s.tabId}
                    secondary={isSec}
                    vertical={!!vertical}
                    onToggleDir={onToggleDir}
                    onClose={onCloseSplit}
                  />
                )}
                {/* 会话恢复占位（closedReason: "restored" 哨兵）：不挂 SshTerminal——
                    假 sessionId 没有对应 PTY，挂上去只会拿到一堆报错。 */}
                {s.closedReason === "restored" ? (
                  <RestoredTabPlaceholder s={s} onReconnect={() => onReconnect(s)} onCloseTab={() => onCloseTab(s)} />
                ) : (
                  <SshTerminal
                    sessionId={s.sessionId}
                    toolbarHost={toolbarHost}
                    toolbarActive={focused?.tabId === s.tabId}
                    conn={s.conn}
                    closedReason={s.closedReason}
                    onClosed={(reason) => onClosed(s, reason)}
                    // 重连回**这个**标签：同一连接可能有多个标签，不指定就可能接到别人头上。
                    onReconnect={() => onReconnect(s)}
                    onCloseTab={() => onCloseTab(s)}
                    visible={s.sessionId === activeId || isSec}
                    dragSelectEnabled={dragSelectEnabled}
                    copyOnSelectEnabled={copyOnSelectEnabled}
                    fullscreen={fullscreen}
                    onToggleFullscreen={onToggleFullscreen}
                    onCwd={(cwd) => onCwd(s.sessionId, cwd)}
                    onMeta={(p) => onMeta(s.sessionId, p)}
                    onOpenFilePath={(p) => onOpenFilePath(s.conn, p)}
                  />
                )}
              </div>
            );
          })}
          {/* 分屏选择态：副格还没选连接 */}
          {splitActive && !sec && (
            <div style={{ order: 2, flex: 1, minWidth: 0 }} className="relative">
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
          {splitActive && (
            <div
              onPointerDown={onSplitterDown}
              className={`z-10 flex shrink-0 items-center justify-center ${
                vertical ? "h-1.5 cursor-row-resize flex-col" : "w-1.5 cursor-col-resize"
              }`}
              title="拖动调整比例"
            >
              <div className={`rounded-full bg-border transition-colors hover:bg-primary ${vertical ? "h-0.5 w-8" : "h-8 w-0.5"}`} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Both split panes retain their host identity when sharing a single toolbar. */
function PaneHead({
  s,
  focused,
  secondary,
  vertical,
  onToggleDir,
  onClose,
}: {
  s: SshSessionRef;
  focused: boolean;
  secondary: boolean;
  vertical: boolean;
  onToggleDir: () => void;
  onClose: () => void;
}) {
  const closed = s.closedReason !== null;
  return (
    <div className="terminal-pane-head flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1 text-xs" data-focused={focused || undefined}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${closed ? "bg-destructive" : "bg-green-500"}`} />
      <span className="min-w-0 truncate font-medium">{s.conn.name || s.conn.host}</span>
      <span className="min-w-0 truncate text-muted-foreground">
        {s.conn.username}@{s.conn.host}
      </span>
      {focused && <span className="ml-auto shrink-0 text-[10px] text-primary">当前操作</span>}
      {secondary && <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onToggleDir}
          title={vertical ? "改为左右并排" : "改为上下堆叠"}
          className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {vertical ? "⇆" : "⇅"}
        </button>
        <button
          type="button"
          onClick={onClose}
          title="关闭分屏（Ctrl+Shift+D）"
          className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive-ink"
        >
          <Icon name="close" size={11} />
        </button>
      </div>}
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
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-card/70 p-4">
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
