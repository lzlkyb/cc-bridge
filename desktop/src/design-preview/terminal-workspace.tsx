import { useState } from "react";
import { Icon, type IconName } from "../components/ui/icon";
import { Button } from "../components/ui/button";
import { Menu, MenuItem } from "../components/ui/Menu";
import { APP_INFO } from "../lib/about";
import type { SshConnection } from "../lib/types";
import type { SshSessionRef } from "../components/tabs/TerminalConnectionItem";

const navigation: [string, string, IconName][] = [["connect", "连接", "plug"], ["terminal", "终端", "terminal"], ["security", "安全", "shield"], ["log", "日志", "log"]];

export function WorkspaceSidebar({ connections, sessions, activeId, collapsed, onConnect, onNewTerminal, onDisconnect, notify }: {
  connections: SshConnection[]; sessions: SshSessionRef[]; activeId: string; collapsed: boolean;
  onConnect: (conn: SshConnection) => void; onNewTerminal: (conn: SshConnection) => void;
  onDisconnect: (id: string) => void; notify: (text: string) => void;
}) {
  const [search, setSearch] = useState("");
  const shown = connections.filter(c => `${c.name} ${c.host} ${c.username}`.toLowerCase().includes(search.toLowerCase()));
  const active = sessions.find(s => s.sessionId === activeId);
  return <aside className="app-side workspace-side" data-collapsed={collapsed || undefined}>
    <div className="app-side-head"><img src="/icon.png" className="app-side-logo" width={28} height={28} alt="CC Bridge"/><div className="app-side-brand"><span className="app-side-name">{APP_INFO.name}</span><span className="app-side-tagline">{APP_INFO.tagline}</span></div></div>
    <nav className="workspace-navigation" aria-label="工作区">{navigation.map(([key, label, icon]) => <button key={key} data-active={key === "terminal" || undefined} aria-current={key === "terminal" ? "page" : undefined} title={label} onClick={() => key !== "terminal" && notify(`${label}页保持现有实现。`)}><Icon name={icon} size={17}/><span>{label}</span></button>)}</nav>
    <div className="workspace-connections-heading"><strong>SSH 连接</strong><button title="新建 SSH 连接" aria-label="新建 SSH 连接" onClick={() => notify("新建连接沿用现有表单，此稿不保存配置。") }><Icon name="plus" size={15}/></button></div>
    <label className="workspace-connection-search"><Icon name="search" size={14}/><input aria-label="搜索 SSH 连接" placeholder="搜索名称或主机" value={search} onChange={e => setSearch(e.target.value)}/></label>
    <div className="workspace-connection-list">{shown.map(conn => {
      const live = sessions.filter(s => s.conn.id === conn.id && !s.closedReason);
      const selected = active?.conn.id === conn.id;
      return <div key={conn.id} className="workspace-connection" data-active={selected || undefined}>
        <button className="workspace-connection-pick" title={`${conn.name} · ${conn.username}@${conn.host}:${conn.port}`} onClick={() => onConnect(conn)}>
          <span className="workspace-server-symbol"><Icon name="server" size={16}/><i data-connected={live.length > 0 || undefined}/></span>
          <span className="workspace-connection-text"><strong>{conn.name}</strong><small>{conn.username}@{conn.host}</small></span>
          {live.length > 0 && <span className="workspace-session-count" title={`${live.length} 个已连接会话`}>{live.length}</span>}
        </button>
        <Menu trigger={(_, toggle) => <button className="workspace-connection-more" aria-label={`${conn.name}的更多操作`} onClick={toggle}><Icon name="more" size={14}/></button>}>
          {close => <><MenuItem label="另开终端" icon="plus" onClick={() => { onNewTerminal(conn); close(); }}/><MenuItem label="文件管理" icon="folder" onClick={() => { notify("文件管理沿用现有整区覆盖式浏览器。"); close(); }}/><MenuItem label="编辑连接" icon="edit" onClick={() => { notify("编辑连接沿用现有表单。"); close(); }}/>{live.length > 0 && <MenuItem label="断开会话" icon="power" onClick={() => { live.forEach(s => onDisconnect(s.sessionId)); close(); }}/>}</>}
        </Menu>
      </div>;
    })}{shown.length === 0 && <p className="workspace-no-match">没有匹配的连接</p>}</div>
    <div className="workspace-side-bottom"><span className="workspace-session-summary">{sessions.filter(s => !s.closedReason).length} 个会话已连接</span><button className="app-side-item" title="设置" onClick={() => notify("设置页保持现有实现。") }><Icon name="settings" size={16}/><span className="app-side-label">设置</span><small>v2.10.0</small></button></div>
  </aside>;
}

export function WorkspaceTabs({ sessions, activeId, onActivate, onDisconnect, onClose, onNew, split, onSplit, onSearch }: {
  sessions: SshSessionRef[]; activeId: string; onActivate: (id: string) => void; onDisconnect: (id: string) => void;
  onClose: (id: string) => void; onNew: () => void; split: boolean; onSplit: () => void; onSearch: () => void;
}) {
  return <>
    <div className="workspace-tabs" role="tablist" aria-label="终端会话">{sessions.map((s, index) => <div key={s.tabId} className="workspace-tab" data-active={s.sessionId === activeId || undefined}>
      <button role="tab" aria-selected={s.sessionId === activeId} onClick={() => onActivate(s.sessionId)} title={`${s.conn.name} · ${s.conn.username}@${s.conn.host}`}><i data-closed={!!s.closedReason || undefined}/><span>{s.conn.name}{sessions.filter(t => t.conn.id === s.conn.id).length > 1 ? ` #${sessions.slice(0, index + 1).filter(t => t.conn.id === s.conn.id).length}` : ""}</span></button>
      <button title={s.closedReason ? "关闭标签" : "断开（标签保留，可重连）"} aria-label={`${s.conn.name}${s.closedReason ? "关闭标签" : "断开会话"}`} onClick={() => s.closedReason ? onClose(s.sessionId) : onDisconnect(s.sessionId)}><Icon name="close" size={11}/></button>
    </div>)}</div>
    <div className="workspace-tab-actions"><Button variant="ghost" size="icon" title="新终端" aria-label="新终端" onClick={onNew}><Icon name="plus" size={15}/></Button><Button variant="ghost" size="icon" title="分屏" aria-label="分屏" aria-pressed={split} onClick={onSplit}><Icon name="monitor" size={14}/></Button><Button variant="ghost" size="icon" title="搜索所有标签" aria-label="搜索所有标签" onClick={onSearch}><Icon name="search" size={14}/></Button></div>
  </>;
}
