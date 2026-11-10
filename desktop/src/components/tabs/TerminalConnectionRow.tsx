import { useState, type ComponentProps } from "react";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { toast } from "../ui/toast";
import type { ConnectionListItem, SshSessionRef } from "./TerminalConnectionItem";
import { setForwardPanelConnId, useTunnelStatus } from "../../lib/sshTunnelStore";

const TUNNEL_LABEL = { connecting: "连接中", up: "运行中", reconnecting: "重连中", error: "已停止", stopped: "未开启" };

type Props = ComponentProps<typeof ConnectionListItem> & {
  liveCount: number; onActivate: (sessionId: string) => void;
  sessions?: SshSessionRef[]; activeId?: string | null; connectionError?: string;
};

/** Host navigation keeps connection actions distinct from per-session actions. */
export function TerminalConnectionRow({ conn, jumpName, session, sessions = [], activeId, connectionError, liveCount, isActive, connecting, confirmingDelete, onConnect, onDisconnect, onNewTerminal, onActivate, onOpenFiles, onEdit, onDeleteRequest, onConfirmDelete, onCancelDelete }: Props) {
  const [expanded, setExpanded] = useState(false);
  const tunnel = useTunnelStatus(conn.id);
  const connected = !!session && !session.closedReason;
  const name = conn.name || conn.host;
  const reason = connectionError || (session?.closedReason && session.closedReason !== "restored" && session.closedReason !== "已手动断开" ? session.closedReason : "");
  const state = connecting ? "connecting" : liveCount ? "connected" : reason ? "failed" : "idle";
  const status = connecting ? "连接中" : liveCount ? "已连接" : reason ? "连接失败" : session?.closedReason === "restored" ? "待恢复" : session ? "已断开" : "未连接";
  const tabs = sessions.filter(s => s.conn.id === conn.id && !s.splitOnly);
  const copyAddress = async () => {
    try { await navigator.clipboard.writeText(`${conn.username}@${conn.host}:${conn.port}`); toast("连接地址已复制", "success"); }
    catch { toast("复制失败，请检查剪贴板权限", "error"); }
  };
  return <div className="terminal-connection-row" data-active={isActive || undefined} data-status={state}>
    <button className="terminal-connection-pick" disabled={connecting} onClick={() => connected ? onActivate(session.sessionId) : onConnect(conn)} title={`${name} · ${conn.username}@${conn.host}:${conn.port}`} aria-label={`${connected ? "切换到" : "连接"} ${name}`}>
      <span className="terminal-server-symbol"><Icon name={connecting ? "refresh" : "server"} size={23} className={connecting ? "animate-spin" : ""}/></span>
      <span className="terminal-connection-text"><span className="terminal-connection-title"><strong>{name}</strong><span className="terminal-connection-state" role={connecting ? "status" : undefined}>{status}</span></span><small className="terminal-connection-host">{conn.host}{conn.port !== 22 ? `:${conn.port}` : ""}</small></span>
    </button>
    <div className="terminal-connection-user" title={conn.username}>{conn.username}</div>
    {jumpName && <small className="terminal-connection-jump">经 {jumpName}</small>}
    {tunnel && <button type="button" className="terminal-connection-jump text-left" title={tunnel.message ?? undefined} onClick={() => setForwardPanelConnId(conn.id)}>端口转发 · {TUNNEL_LABEL[tunnel.state]}</button>}
    <div className="terminal-connection-meta">
      <button type="button" className="terminal-connection-expand" disabled={connecting} aria-expanded={tabs.length > 1 ? expanded : undefined} onClick={() => tabs.length > 1 ? setExpanded(v => !v) : connected ? onActivate(session.sessionId) : onConnect(conn)}>
        {tabs.length > 1 && expanded ? "收起会话" : liveCount > 0 ? `${liveCount} 个会话` : tabs.length > 1 ? `${tabs.length} 个终端` : "连接服务器"}<Icon name="chevronRight" size={13}/>
      </button>
      <Menu portal trigger={(open, toggle) => <button type="button" className="terminal-connection-more" disabled={connecting} aria-label={`${name}的更多操作`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Icon name="more" size={18}/></button>}>
        {close => <>
          <MenuItem label={connected ? "另开终端" : "连接"} icon="plus" disabled={connecting} onClick={() => { if (connected) onNewTerminal(conn); else onConnect(conn); close(); }}/>
          {connected && <MenuItem label="文件管理" icon="folder" onClick={() => { onOpenFiles(conn); close(); }}/>}
          <MenuItem label="端口转发" icon="arrowRight" onClick={() => { setForwardPanelConnId(conn.id); close(); }}/>
          <MenuItem label="复制连接地址" icon="copy" onClick={() => { void copyAddress(); close(); }}/>
          <MenuItem label="编辑连接" icon="settings" onClick={() => { onEdit(conn); close(); }}/>
          {connected && <MenuItem label="断开当前会话" icon="power" onClick={() => { onDisconnect(session.sessionId); close(); }}/>}
          <MenuItem label="删除连接" icon="trash" onClick={() => { onDeleteRequest(); close(); }}/>
        </>}
      </Menu>
    </div>
    {expanded && tabs.length > 1 && <div className="terminal-connection-sessions">{tabs.map((s, i) => <button key={s.tabId} type="button" data-active={s.sessionId === activeId || undefined} onClick={() => onActivate(s.sessionId)}><Icon name="terminal" size={12}/><span>{s.label || `终端 ${i + 1}`}</span>{s.closedReason && <small>已断开</small>}</button>)}</div>}
    {state === "failed" && !confirmingDelete && <div className="terminal-connection-failure"><p title={reason}>{reason}</p><button type="button" onClick={() => onConnect(conn)}>重试</button><button type="button" onClick={() => onEdit(conn)}>编辑配置</button></div>}
    {confirmingDelete && <div className="terminal-connection-delete"><span>删除此连接？{liveCount > 0 && `将断开 ${liveCount} 个会话并关闭终端。`}</span><button type="button" onClick={onConfirmDelete}>确认删除</button><button type="button" onClick={onCancelDelete}>取消</button></div>}
  </div>;
}
