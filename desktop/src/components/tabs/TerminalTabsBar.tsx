import { useEffect, useRef } from "react";
import { Icon } from "../ui/icon";
import type { SshSessionRef } from "./TerminalConnectionItem";

interface TerminalTabsBarProps {
  sessions: SshSessionRef[];
  activeId: string | null;
  onActivate: (sessionId: string) => void;
  /** 已连接的会话点 ×：断开（但保留标签）。 */
  onDisconnect: (sessionId: string) => void;
  /** 已断开的会话点 ×：真正移除标签。 */
  onCloseTab: (sessionId: string) => void;
  /** 对当前活动连接另开一个终端；null = 没有可另开的目标（按钮隐藏）。 */
  onNewTerminal: (() => void) | null;
}

/**
 * 终端标签栏：多会话时顶部横向标签。
 *
 * × 的语义分两档：**已连接 → 断开（标签保留）；已断开 → 关闭标签**。
 * 这个 11px 的 × 本来是一点就断、无确认；现在第一下只是进入可重连的断开态，
 * 误点不再丢历史输出——比加二次确认好，不多一步点击。
 */
export function TerminalTabsBar({
  sessions,
  activeId,
  onActivate,
  onDisconnect,
  onCloseTab,
  onNewTerminal,
}: TerminalTabsBarProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  // 标签多了会溢出横向滚动区，新连的会话可能落在可视区外，看着像「没反应」。
  // block: "nearest" 避免把页面垂直方向也拉跑了。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  // 同一连接开了多个终端时给个序号，否则两个标签长得一模一样。
  // 只有一个时不显示，不给单终端的常见情况增噪。
  const totalPerConn = new Map<string, number>();
  for (const s of sessions) totalPerConn.set(s.conn.id, (totalPerConn.get(s.conn.id) ?? 0) + 1);
  const seenPerConn = new Map<string, number>();

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-2 py-1.5">
      {sessions.map((s) => {
        const closed = !!s.closedReason;
        const active = s.sessionId === activeId;
        const seq = (seenPerConn.get(s.conn.id) ?? 0) + 1;
        seenPerConn.set(s.conn.id, seq);
        const showSeq = (totalPerConn.get(s.conn.id) ?? 0) > 1;
        return (
          <div
            key={s.tabId}
            ref={active ? activeRef : undefined}
            className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
              active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <button
              type="button"
              onClick={() => onActivate(s.sessionId)}
              className="flex items-center gap-1.5"
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
              <span className={closed ? "line-through opacity-70" : undefined}>
                {s.conn.name || s.conn.host}
              </span>
              {showSeq && (
                <span className="rounded bg-muted-foreground/15 px-1 font-mono text-[10px]">
                  #{seq}
                </span>
              )}
              {s.conn.authType === "key" && <span>🔑</span>}
            </button>
            <button
              type="button"
              onClick={() => (closed ? onCloseTab(s.sessionId) : onDisconnect(s.sessionId))}
              className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title={closed ? "关闭标签" : "断开（标签保留，可重连）"}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        );
      })}
      {onNewTerminal && (
        <button
          type="button"
          onClick={onNewTerminal}
          title="对当前连接再开一个终端"
          className="flex shrink-0 items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Icon name="plus" size={12} /> 新终端
        </button>
      )}
    </div>
  );
}
