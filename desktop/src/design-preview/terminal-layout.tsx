import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../components/ui/icon";
import { Button } from "../components/ui/button";
import { TerminalSidebar } from "../components/tabs/TerminalSidebar";
import { TerminalTabsBar } from "../components/tabs/TerminalTabsBar";
import { SshTerminalToolbar } from "../components/tabs/SshTerminalToolbar";
import { TerminalStatusBar } from "../components/tabs/TerminalStatusBar";
import { SshCommandBlocksPanel } from "../components/tabs/SshCommandBlocksPanel";
import type { SshSessionRef } from "../components/tabs/TerminalConnectionItem";
import { useCmdPanelOpen, setCmdPanelOpen } from "../lib/terminalPanelStore";
import { APP_INFO } from "../lib/about";
import { applyTheme } from "../lib/theme";
import { useThemeMode } from "../hooks/useThemeMode";
import { useTerminalThemeMode } from "../hooks/useTerminalAppearance";
import { useTerminalPreset } from "../hooks/useTerminalPreset";
import { terminalTheme } from "../lib/terminalTheme";
import type { SshConnection } from "../lib/types";
import { TerminalSample } from "./terminal-sample";
import { WorkspaceSidebar, WorkspaceTabs } from "./terminal-workspace";
import { TerminalGlobalSearch } from "../components/tabs/TerminalGlobalSearch";
import "../index.css";
import "./terminal-layout.css";

const query = new URLSearchParams(location.search);
if (query.has("capture")) document.documentElement.dataset.capture = "true";
applyTheme(query.get("theme") === "dark" ? "dark" : "light");
const connections: SshConnection[] = [
  ["prod", "生产服务器", "192.0.2.10", "deploy"],
  ["test", "测试环境", "192.0.2.20", "dev"],
  ["dev", "开发服务器", "192.0.2.30", "dev"],
  ["backup", "备用节点", "192.0.2.40", "root"],
].map(([id, name, host, username]) => ({ id, name, host, username, port: 22, authType: "password", rememberPassword: false, encryptedPassword: "", keyPath: "", rememberPassphrase: false, encryptedPassphrase: "", proxyJumpId: "" }));
const initialSessions: SshSessionRef[] = [connections[0], connections[1]].map((conn, i) => ({ tabId: `tab-${i}`, sessionId: `demo-${i}`, conn, closedReason: null }));
const nav: [string, string, IconName][] = [["connect", "连接", "plug"], ["terminal", "终端", "terminal"], ["security", "安全", "shield"], ["log", "日志", "log"]];

function App() {
  const [layout, setLayout] = useState(query.get("layout") ?? "workspace");
  const candidate = layout !== "current";
  const workspace = layout === "workspace";
  const [collapsed, setCollapsed] = useState(query.get("layout") === "compact");
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [focusedPane, setFocusedPane] = useState<"primary" | "secondary">("primary");
  const [globalSearch, setGlobalSearch] = useState(false);
  const [sshCollapsed, setSshCollapsed] = useState(false);
  const [split, setSplit] = useState(query.get("split") === "1");
  const [fullscreen, setFullscreen] = useState(false);
  const [sessions, setSessions] = useState(initialSessions);
  const [activeId, setActiveId] = useState("demo-0");
  const [notice, setNotice] = useState("");
  const [size, setSize] = useState("1280×840");
  const [scale, setScale] = useState(1);
  const stage = useRef<HTMLDivElement>(null);
  const mode = useThemeMode();
  const [width, height] = size.split("×").map(Number);
  const active = sessions.find(s => s.sessionId === activeId) ?? sessions[0];
  const notify = (text: string) => setNotice(text);
  useEffect(() => {
    const node = stage.current!;
    const observer = new ResizeObserver(() => setScale(Math.min(1, (node.clientWidth - (query.has("capture") ? 0 : 32)) / width, (node.clientHeight - (query.has("capture") ? 0 : 24)) / height)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [width, height]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 3500); return () => clearTimeout(timer); }, [notice]);
  const connect = (conn: SshConnection, fresh = false) => {
    setFocusedPane("primary");
    const existing = !fresh && sessions.find(s => s.conn.id === conn.id && !s.closedReason);
    if (existing) { setActiveId(existing.sessionId); return; }
    const id = `demo-${Date.now()}`;
    setSessions(list => [...list, { tabId: id, sessionId: id, conn, closedReason: null }]);
    setActiveId(id);
  };
  const chooseLayout = (next: string) => { setLayout(next); setCollapsed(next === "compact"); };
  const disconnect = (id: string) => setSessions(list => list.map(s => s.sessionId === id ? { ...s, closedReason: "设计预览：会话已断开" } : s));
  const closeTab = (id: string) => { const remaining = sessions.filter(s => s.sessionId !== id); setSessions(remaining); if (activeId === id && remaining[0]) setActiveId(remaining[0].sessionId); };
  const toggleSplit = () => { setSplit(!split); setFocusedPane("primary"); };
  return <div className="real-preview">
    <header className="review-controls">
      <div className="review-heading"><strong>终端布局设计稿</strong><span>真实组件 · 示例数据</span></div>
      <div className="review-group" aria-label="布局方案">
        <button aria-pressed={layout === "current"} onClick={() => chooseLayout("current")}>当前布局</button>
        <button aria-pressed={layout === "compact"} onClick={() => chooseLayout("compact")}>上一版微调</button>
        <button aria-pressed={workspace} onClick={() => chooseLayout("workspace")}>工作区重排</button>
      </div>
      <div className="review-group" aria-label="界面主题">
        <button aria-pressed={mode === "light"} onClick={() => applyTheme("light")}>亮色</button>
        <button aria-pressed={mode === "dark"} onClick={() => applyTheme("dark")}>深色</button>
      </div>
      <select aria-label="设计窗口尺寸" value={size} onChange={e => setSize(e.target.value)}><option>1280×840</option><option>1440×900</option></select>
    </header>
    <div ref={stage} className="review-stage">
      <div className="review-frame-space" style={{ width: width * scale, height: height * scale }}>
        <div className={`review-app ${candidate ? "candidate" : "incumbent"} ${workspace ? "workspace" : ""} ${fullscreen ? "preview-fullscreen" : ""}`} style={{ width, height, transform: `scale(${scale})` }}>
          <div className="app-shell">
            {workspace ? <WorkspaceSidebar connections={connections} sessions={sessions} activeId={activeId} collapsed={collapsed} onConnect={connect} onNewTerminal={conn => connect(conn, true)} onDisconnect={disconnect} notify={notify}/> : <aside className="app-side" data-collapsed={collapsed || undefined}>
              <div className="app-side-head"><img src="/icon.png" className="app-side-logo" alt="CC Bridge" width={28} height={28}/><div className="app-side-brand"><span className="app-side-name">{APP_INFO.name}</span><span className="app-side-tagline">{APP_INFO.tagline}</span></div></div>
              <nav className="app-side-nav" aria-label="工作区">{nav.map(([key, label, icon]) => <button key={key} className="app-side-item" data-active={key === "terminal" || undefined} title={label} aria-current={key === "terminal" ? "page" : undefined} onClick={() => key !== "terminal" && notify(`此设计稿只展示终端页；${label}页保持现有实现。`)}><Icon name={icon} size={16} className="app-side-icon"/><span className="app-side-label">{label}</span></button>)}</nav>
              <div className="app-side-foot"><div className="app-side-settings-row"><button className="app-side-item" title="设置" onClick={() => notify("设置页保持现有实现。终端配色可从终端工具栏的外观菜单预览。") }><Icon name="settings" size={16}/><span className="app-side-label">设置</span></button>{!collapsed && <span className="review-version">v2.10.0</span>}</div></div>
            </aside>}
            <div className="app-main flex min-h-0 min-w-0 flex-col">
              <header className="app-header app-topbar flex shrink-0 items-center gap-2 border-b px-3">
                <Button variant="ghost" size="icon" aria-label={collapsed ? "展开工作区导航" : "收起工作区导航"} title={collapsed ? "展开工作区导航" : "收起工作区导航"} onClick={() => setCollapsed(!collapsed)}><Icon name="chevronLeft" size={16} className={collapsed ? "rotate-180" : ""}/></Button>
                {workspace && <div className="workspace-location"><span>终端</span><span>/</span><strong>{active?.conn.name ?? "SSH 工作区"}</strong></div>}
                <div className="min-w-0 flex-1 self-stretch"/>
                <div className="flex shrink-0 items-center gap-2"><Button variant="outline" size="sm" onClick={() => notify("示例状态：此按钮不会停止真实服务。") }><Icon name="pause" size={14}/>停止服务</Button><Button variant="ghost" size="sm" title="搜索页面与设置（Ctrl+K）" onClick={() => notify("正式应用的 Ctrl+K 命令面板保持不变。") }><Icon name="search" size={14}/></Button><Button variant="ghost" size="icon" aria-label={mode === "light" ? "切换深色" : "切换浅色"} onClick={() => applyTheme(mode === "light" ? "dark" : "light")}><Icon name={mode === "light" ? "moon" : "sun"} size={18}/></Button><div className="flex items-center gap-0.5">{(["minimize", "maximize", "close"] as IconName[]).map(icon => <button key={icon} title={icon === "close" ? "关闭窗口" : icon === "minimize" ? "最小化" : "最大化"} className="review-window-control" onClick={() => notify("设计稿窗口控件仅展示样式。") }><Icon name={icon} size={icon === "maximize" ? 14 : 16}/></button>)}</div></div>
              </header>
              <main className="review-content min-h-0 min-w-0 flex-1 overflow-hidden px-5 pb-5">
                <div className="review-terminal flex h-full min-h-0 overflow-hidden rounded-xl border border-border bg-card">
                  {!workspace && <TerminalSidebar connections={connections} sessions={sessions} activeId={activeId} isLoading={false} collapsed={sshCollapsed} connectingId={null} confirmingDelete={null} onSetCollapsed={setSshCollapsed} onNew={() => notify("新建连接弹窗沿用现有表单；此稿不保存配置。") } onConnect={connect} onDisconnect={disconnect} onNewTerminal={conn => connect(conn, true)} onActivate={setActiveId} onOpenFiles={() => notify("文件管理沿用现有整区覆盖面板，本稿不新增右侧文件抽屉。") } onEdit={() => notify("编辑连接沿用现有弹窗。") } onDeleteRequest={() => notify("此稿不删除真实连接。") } onConfirmDelete={() => {}} onCancelDelete={() => {}}/>}
                  <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="终端工作区">
                    {workspace ? <div className="workspace-unified-header"><WorkspaceTabs sessions={sessions} activeId={activeId} onActivate={id => { setActiveId(id); setFocusedPane("primary"); }} onDisconnect={disconnect} onClose={closeTab} onNew={() => active && connect(active.conn, true)} split={split} onSplit={toggleSplit} onSearch={() => setGlobalSearch(true)}/><div className="workspace-toolbar-host" ref={setToolbarHost} aria-label="当前窗格操作"/></div> : <TerminalTabsBar sessions={sessions} activeId={activeId} metaBySession={{}} onActivate={setActiveId} onDisconnect={disconnect} onCloseTab={closeTab} onNewTerminal={active ? () => connect(active.conn, true) : null} onToggleSplit={toggleSplit} splitActive={split}/>}
                    <div className={`review-panes ${split ? "has-split" : ""}`}>
                      {active ? <SessionPane session={active} candidate={candidate} workspace={workspace} toolbarHost={toolbarHost} paneHeader={workspace && split} focused={!split || focusedPane === "primary"} onFocus={() => setFocusedPane("primary")} fullscreen={fullscreen} toggleFullscreen={() => setFullscreen(!fullscreen)} notify={notify}/> : <div className="review-empty">从左侧选择一个连接，打开示例终端。</div>}
                      {split && <SessionPane session={initialSessions[1]} candidate={candidate} workspace={workspace} toolbarHost={toolbarHost} paneHeader={workspace} focused={focusedPane === "secondary"} onFocus={() => setFocusedPane("secondary")} secondary fullscreen={fullscreen} toggleFullscreen={() => setFullscreen(!fullscreen)} notify={notify} closeSplit={toggleSplit}/>}
                    </div>
                  </section>
                </div>
              </main>
            </div>
          </div>
          {notice && <div className="review-notice" role="status">{notice}</div>}
          {globalSearch && <TerminalGlobalSearch sessions={sessions} onActivate={setActiveId} onClose={() => setGlobalSearch(false)}/>}
        </div>
      </div>
    </div>
    <footer className="review-foot"><span>{workspace ? "重排：双侧栏合一 · 标签与操作合为单行 · 终端铺满 · 分屏共用工具栏" : candidate ? "微调：导航折叠 · 内容边距收窄 · 状态栏下移" : "当前：200px 导航 + 240px 连接栏 · 三层终端顶区"}</span><span>{size} · 缩放 {Math.round(scale * 100)}% · 未连接真实 SSH</span></footer>
  </div>;
}

function SessionPane({ session, candidate, workspace, toolbarHost, paneHeader, focused, onFocus, secondary = false, fullscreen, toggleFullscreen, notify, closeSplit }: { session: SshSessionRef; candidate: boolean; workspace: boolean; toolbarHost: HTMLDivElement | null; paneHeader: boolean; focused: boolean; onFocus: () => void; secondary?: boolean; fullscreen: boolean; toggleFullscreen: () => void; notify: (text: string) => void; closeSplit?: () => void }) {
  const [selectMode, setSelectMode] = useState(false);
  const [find, setFind] = useState(false);
  const [findText, setFindText] = useState("");
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const { mode, preset } = useSampleAppearance();
  const cmdOpen = useCmdPanelOpen();
  const closed = !!session.closedReason;
  const toolbar = <div className="review-session-toolbar"><SshTerminalToolbar conn={session.conn} closed={closed} focused selectMode={selectMode} shiftActive={false} dragSelecting={false} inputErr={null} fullscreen={fullscreen} onCopy={() => { void navigator.clipboard?.writeText(termRef.current?.getSelection() ?? ""); notify("已复制示例终端选区。"); }} onCopyScreen={() => notify("示例终端可选中、复制；不读取真实会话。") } onPaste={() => notify("此稿没有远端输入通道。") } onPasteImage={() => notify("此稿不上传文件。") } imgBusy={false} onRepaint={() => termRef.current?.refresh(0, termRef.current.rows - 1)} onSearch={() => setFind(!find)} onToggleSelectMode={() => setSelectMode(!selectMode)} onClear={() => termRef.current?.clear()} onToggleFullscreen={toggleFullscreen} onExport={() => notify("导出终端内容沿用现有实现。") }/></div>;
  return <div className={`review-pane ${secondary ? "secondary-pane" : ""}`} data-focused={focused || undefined} onPointerDown={onFocus} onFocusCapture={onFocus} style={{ background: terminalTheme(mode, preset).background }}>
    {(paneHeader || secondary) && <div className="review-pane-head"><Icon name="server" size={12}/><span>{session.conn.name}</span>{workspace && <small>{session.conn.username}@{session.conn.host}</small>}{workspace && focused && <span className="workspace-pane-focus">当前操作</span>}{secondary && <button title="关闭分屏" onClick={closeSplit}><Icon name="close" size={12}/></button>}</div>}
    {workspace ? toolbarHost && focused && createPortal(toolbar, toolbarHost) : toolbar}
    <div className={`review-status ${candidate ? "at-bottom" : ""}`}><Status session={session}/></div>
    {closed && <div className="review-disconnected">已断开 · 历史输出保留，此处展示断开态样式</div>}
    <div className="review-canvas"><TerminalSample session={session} termRef={termRef}/>{find && <div className="review-find"><input aria-label="查找终端内容" placeholder="查找终端内容" value={findText} onChange={e => setFindText(e.target.value)}/><span>{findText ? "示例查找" : ""}</span><button title="关闭查找" onClick={() => setFind(false)}><Icon name="close" size={14}/></button></div>}{cmdOpen && !secondary && <SshCommandBlocksPanel termRef={termRef} name={session.conn.name} closed={closed} onClose={() => setCmdPanelOpen(false)}/>}</div>
  </div>;
}

function Status({ session }: { session: SshSessionRef }) {
  const { mode, preset } = useSampleAppearance();
  return <TerminalStatusBar sessionId={session.sessionId} conn={session.conn} preset={preset} mode={mode} status={{ cwd: "/home/deploy/workspace/cc-bridge", branch: "main", exitCode: 0, lastCmdMs: 1342 }} state="ready" closed={!!session.closedReason}/>;
}
function useSampleAppearance() { return { mode: useTerminalThemeMode(), preset: useTerminalPreset() }; }

createRoot(document.getElementById("root")!).render(<App/>);
