import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { getTerminal } from "../../lib/terminalRegistry";
import type { SshSessionRef } from "./TerminalConnectionItem";

/** Keep the header host and terminal siblings stable as a session moves in and out of a split. */
export function TerminalPaneFrame({ session, label, splitPane, focused, zoomed, style, onFocus, onZoom, children }: {
  session: SshSessionRef; label: string; splitPane: boolean; focused: boolean; zoomed: boolean;
  style: CSSProperties; onFocus: () => void; onZoom: () => void;
  children: (toolbarHost: HTMLDivElement | null) => ReactNode;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const zoom = () => {
    onZoom();
    // 控制按钮在终端画布外；布局更新后把输入还给选中的会话，不能让新露出的另一格抢走。
    requestAnimationFrame(() => {
      if (!session.closedReason && frameRef.current?.dataset.focused) getTerminal(session.sessionId)?.focus();
    });
  };
  return <div ref={frameRef} className="terminal-pane-frame" style={style} onPointerDown={onFocus} onFocusCapture={onFocus}
    data-pane={splitPane || undefined} data-focused={focused || undefined} aria-label={splitPane ? label : undefined}>
    <div className="terminal-pane-head" hidden={!splitPane}>
      <span className={`terminal-pane-dot ${session.closedReason ? "bg-destructive" : "bg-green-500"}`} aria-label={session.closedReason ? "已断开" : "已连接"}/>
      <span className="terminal-pane-name" title={`${label} · ${session.conn.username}@${session.conn.host}:${session.conn.port}`}>{label}</span>
      <div className="terminal-pane-tools" ref={setHost}/>
      <button type="button" className="terminal-pane-zoom" onClick={zoom} aria-pressed={zoomed}
        aria-label={`${zoomed ? "还原分屏" : "放大窗格"} ${label}`} title={zoomed ? "还原分屏布局" : "临时放大此窗格"}>
        <Icon name={zoomed ? "collapse" : "expand"} size={14}/>
      </button>
    </div>
    {children(host)}
  </div>;
}
