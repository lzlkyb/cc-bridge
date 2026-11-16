import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { APP_INFO } from "../../lib/about";

export function PreviewShell({ children, activeTab, collapsed, dark, serviceRunning, ruleCount, ruleState, tunnelReady, method, onToggleSidebar, onTheme, onService, onNavigate, notify }: {
  children: ReactNode; activeTab: string; collapsed: boolean; dark: boolean; serviceRunning: boolean;
  ruleCount: number; ruleState: string; tunnelReady: boolean; method: "direct" | "tunnel";
  onToggleSidebar: () => void; onTheme: () => void; onService: () => void;
  onNavigate: (tab: string) => void; notify: (message: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState(false);
  return <div className="fp-app app-boot-fade"><div className="app-shell">
    <aside className="app-side" data-mode={activeTab === "terminal" ? "terminal" : undefined} data-collapsed={collapsed || undefined}>
      <div className="app-side-head"><img src="/icon.png" width={28} height={28} alt="" className="app-side-logo" /><div className="app-side-brand"><span className="app-side-name">{APP_INFO.name}</span><span className="app-side-tagline">{APP_INFO.tagline}</span></div></div>
      <nav className="app-side-nav" aria-label="主导航">
        {[["connect", "连接", "plug"], ["terminal", "终端", "terminal"], ["security", "安全", "shield"], ["log", "日志", "log"], ["ccgui", "对话", "message"]].map(([key, label, icon]) => <button key={key} className="app-side-item" data-active={activeTab === key || undefined} aria-current={activeTab === key ? "page" : undefined} title={label} onClick={() => onNavigate(key)}><Icon name={icon} size={16} className="app-side-icon" /><span className="app-side-label">{label}</span></button>)}
      </nav>
      {activeTab === "terminal" && <div className="fp-server-sidebar">
        <div className="fp-server-heading"><strong>SSH 连接</strong><button className="fp-text-button" onClick={() => notify("本次预览使用“公司”这条示例连接。")}><Icon name="plus" size={14} />新建</button></div>
        <label className="terminal-connection-search-field"><Icon name="search" size={15} /><input value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索服务器" placeholder="搜索名称、主机或用户" /></label>
        <div className="terminal-connection-list-caption"><span>已保存 · 1</span><span>1 个连接在线</span></div>
        {/公司|10\.0\.19|lizuliang/i.test(search) || !search ? <div className="terminal-connection-row" data-active data-status="connected">
          <button className="terminal-connection-pick" onClick={() => onNavigate("terminal")}><span className="terminal-server-symbol"><Icon name="server" size={24} /></span><span className="terminal-connection-text"><span className="terminal-connection-title"><strong>公司</strong><span className="terminal-connection-state">已连接</span></span><span className="terminal-connection-host">10.0.19.194</span></span></button>
          <div className="terminal-connection-user">lizuliang</div>
          <div className="terminal-connection-user fp-sidebar-forward">{ruleCount ? ruleCount + " 条手动转发 · " + ruleState : "尚未配置手动转发"}</div>
          <div className="terminal-connection-meta"><button className="terminal-connection-expand" aria-expanded={sessions} onClick={() => setSessions(!sessions)}>1 个会话<Icon name="chevronRight" size={13} /></button><button className="terminal-connection-more" aria-label="服务器更多操作" onClick={() => notify("服务器连接设置继续在原入口管理。")}><Icon name="more" size={17} /></button></div>
          {sessions && <div className="terminal-connection-sessions"><button data-active onClick={() => onNavigate("terminal")}><Icon name="terminal" size={14} /><span>公司 · 会话 1</span><small>在线</small></button></div>}
        </div> : <p className="fp-search-empty">没有匹配的连接</p>}
      </div>}
      <div className="app-side-foot"><div className="app-side-settings-row"><button className="app-side-item" onClick={() => notify("本次预览只修改端口转发页面。")}><Icon name="settings" size={16} /><span className="app-side-label">设置</span></button><span className="fp-version">v3.1.5</span></div></div>
    </aside>
    <div className="app-main fp-main">
      <header className="app-header app-topbar fp-topbar">
        <button className="fp-icon-button" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} onClick={onToggleSidebar}><Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={21} /></button>
        <button className="fp-security-reminder" onClick={() => notify("顶栏沿用当前软件的安全提醒，具体设置仍在安全页面管理。")}><Icon name="alertTriangle" size={13} />1 项安全提醒</button>
        <button className="fp-current-method" onClick={() => onNavigate("connect")}><span className="fp-dot" /><strong>{method === "direct" ? "IP 直连" : "隧道连接"}</strong><span>{!serviceRunning ? "本机服务已停止" : method === "direct" ? "接入待验证" : tunnelReady ? "已连通" : "已暂停"}</span></button>
        <div className="fp-topbar-actions"><Button variant="outline" size="sm" onClick={onService}><Icon name={serviceRunning ? "pause" : "play"} size={14} />{serviceRunning ? "停止本机服务" : "启动本机服务"}</Button><button className="fp-icon-button" aria-label="查找功能" onClick={() => notify("端口转发入口位于终端的服务器操作中。")}><Icon name="search" size={20} /></button><button className="fp-icon-button" aria-label="切换深浅主题" onClick={onTheme}><Icon name={dark ? "sun" : "moon"} size={20} /></button><span className="fp-window-controls" aria-hidden="true"><Icon name="minimize" size={17} /><Icon name="maximize" size={16} /><Icon name="close" size={18} /></span></div>
      </header>
      <main className="fp-workspace">{children}</main>
    </div>
  </div></div>;
}
