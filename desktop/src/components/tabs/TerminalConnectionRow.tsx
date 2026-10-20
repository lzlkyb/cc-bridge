import type { ComponentProps } from "react";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import type { ConnectionListItem } from "./TerminalConnectionItem";

type Props = ComponentProps<typeof ConnectionListItem> & { liveCount: number; onActivate: (sessionId: string) => void };

/** Shared navigation has one row per host; session tabs remain the source of per-session actions. */
export function TerminalConnectionRow({ conn, jumpName, session, liveCount, isActive, connecting, confirmingDelete, onConnect, onDisconnect, onNewTerminal, onActivate, onOpenFiles, onEdit, onDeleteRequest, onConfirmDelete, onCancelDelete }: Props) {
  const connected = !!session && !session.closedReason;
  const name = conn.name || conn.host;
  return <div className="terminal-connection-row" data-active={isActive || undefined}>
    <div className="terminal-connection-line">
      <button className="terminal-connection-pick" disabled={connecting} onClick={() => connected ? onActivate(session.sessionId) : onConnect(conn)} title={`${name} · ${conn.username}@${conn.host}:${conn.port}`} aria-label={`${connected ? "切换到" : "连接"} ${name}`}>
        <span className="terminal-server-symbol"><Icon name={connecting ? "refresh" : "server"} size={16} className={connecting ? "animate-spin" : ""}/><i data-connected={liveCount > 0 || undefined}/></span>
        <span className="terminal-connection-text"><strong>{name}</strong><small>{conn.username}@{conn.host}:{conn.port}</small></span>
        {liveCount > 0 && <span className="terminal-session-count" title={`${liveCount} 个已连接会话`}>{liveCount}</span>}
      </button>
      <Menu portal trigger={(open, toggle) => <button className="terminal-connection-more" disabled={connecting} aria-label={`${name}的更多操作`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="more" size={14}/></button>}>
        {close => <>
          <MenuItem label={connected ? "另开终端" : "连接"} icon="plus" disabled={connecting} onClick={() => { if (connected) onNewTerminal(conn); else onConnect(conn); close(); }}/>
          {connected && <MenuItem label="文件管理" icon="folder" onClick={() => { onOpenFiles(conn); close(); }}/>}
          <MenuItem label="编辑连接" icon="settings" onClick={() => { onEdit(conn); close(); }}/>
          {connected && <MenuItem label="断开当前会话" icon="power" onClick={() => { onDisconnect(session.sessionId); close(); }}/>}
          <MenuItem label="删除连接" icon="trash" onClick={() => { onDeleteRequest(); close(); }}/>
        </>}
      </Menu>
    </div>
    {jumpName && <small className="terminal-connection-jump">经 {jumpName}</small>}
    {connecting && <small className="terminal-connection-jump" role="status">连接中…</small>}
    {confirmingDelete && <div className="terminal-connection-delete"><span>删除此连接？</span><button onClick={onConfirmDelete}>确认删除</button><button onClick={onCancelDelete}>取消</button></div>}
  </div>;
}
