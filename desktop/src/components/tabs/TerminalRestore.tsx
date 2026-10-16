import { Icon } from "../ui/icon";
import type { SshSessionRef } from "./TerminalConnectionItem";

/**
 * 终端会话恢复的两个 UI（方案 A：骨架恢复 + 手动重连，无自动连接行为）。
 *
 * 占位标签 closedReason 用 "restored" 哨兵：不会走 SshTerminal 的断开渲染，
 * 也不会被 markClosed 的 toast 误碰（那些只在真实会话上发生）。
 */

/** 「上次会话」占位卡：显示主机身份 + 恢复/关闭。挂在原 SshTerminal 的位置。 */
export function RestoredTabPlaceholder({
  s,
  onReconnect,
  onCloseTab,
}: {
  s: SshSessionRef;
  onReconnect: () => void;
  onCloseTab: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-card p-4">
      <div className="text-xs text-muted-foreground">上次会话（未连接）</div>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon name="server" size={14} className="text-muted-foreground" />
        <span className="max-w-56 truncate">{s.conn.name || s.conn.host}</span>
      </div>
      <div className="font-mono text-xs text-muted-foreground">
        {s.conn.username}@{s.conn.host}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={onReconnect}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90"
        >
          恢复连接
        </button>
        <button
          type="button"
          onClick={onCloseTab}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          关闭标签
        </button>
      </div>
    </div>
  );
}

/** 标签栏下方的恢复横幅：N 个上次会话待重连，可一键全部恢复（逐个串行连）。 */
export function RestoreBanner({
  sessions,
  onReconnect,
}: {
  sessions: SshSessionRef[];
  onReconnect: (s: SshSessionRef) => void;
}) {
  const restored = sessions.filter((s) => s.closedReason === "restored" && !s.splitOnly);
  if (restored.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/5 px-3 py-1.5 text-xs">
      <Icon name="history" size={13} className="shrink-0 text-primary" />
      <span className="text-muted-foreground">
        已恢复 {restored.length} 个上次会话的标签，连接由你手动发起
      </span>
      <button
        type="button"
        onClick={() => void (async () => {
          for (const s of restored) onReconnect(s); // 串行连，避免并发撞远端 MaxSessions
        })()}
        className="ml-auto shrink-0 rounded-md border border-border px-2 py-0.5 text-foreground transition-colors hover:border-primary hover:bg-muted"
      >
        全部恢复
      </button>
    </div>
  );
}
