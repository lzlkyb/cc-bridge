import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TerminalPanes } from "../components/tabs/TerminalPanes";
import { TerminalTabsBar } from "../components/tabs/TerminalTabsBar";
import { TerminalSplitControls } from "../components/tabs/TerminalSplitControls";
import { TerminalSidebar } from "../components/tabs/TerminalSidebar";
import { useSshSessions } from "../components/tabs/useSshSessions";
import { useTerminalSplit } from "../components/tabs/useTerminalSplit";
import { useTerminalWorkspace } from "../hooks/useTerminalWorkspace";
import { getTerminal } from "../lib/terminalRegistry";
import { applyTheme } from "../lib/theme";
import { setTerminalMode } from "../lib/terminalAppearance";
import type { SshConnection } from "../lib/types";
import "../index.css";
import "../interaction-refinements.css";
import "../terminal-workspace.css";
import "./terminal-split.css";

const conn = { id: "production", name: "生产服务器", host: "192.0.2.10", username: "deploy", port: 22, authType: "key" } as SshConnection;
const noop = () => {};
function Preview() {
  const area = useRef<HTMLDivElement>(null), seeded = useRef(new Set<string>()), opened = useRef(false);
  const ssh = useSshSessions();
  const active = ssh.sessions.find(s => s.sessionId === ssh.activeId) ?? null;
  const ctl = useTerminalSplit({ ssh, activeSession: active, areaRef: area });
  const workspace = useTerminalWorkspace(ssh.sessions, ssh.activeId, ctl.split);
  const [dark, setDark] = useState(false), [fullscreen, setFullscreen] = useState(false);
  useEffect(() => { void ssh.connect(conn); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (active && !opened.current) { opened.current = true; ctl.toggleSplit(); }
  }, [active, ctl]);
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const s of ssh.sessions) {
        const term = getTerminal(s.sessionId);
        if (!term || seeded.current.has(s.tabId)) continue;
        seeded.current.add(s.tabId);
        term.write(`\x1b]7;file://production/home/deploy/${s.splitOnly ? "logs" : "project"}\x07\x1b]1337;Git=main\x07`);
        const prompt = `\x1b[32mdeploy@production\x1b[0m:\x1b[34m~/project\x1b[0m$ `;
        term.write(["\x1b[90m# 本地交互预览 · 示例输出，未连接真实 SSH\x1b[0m", "", `${prompt}${s.splitOnly ? "tail -f logs/app.log" : "git status"}`, ...(s.splitOnly
          ? Array.from({ length: 18 }, (_, i) => `14:32:${String(i + 10).padStart(2, "0")} \x1b[36mINFO\x1b[0m request completed 200 OK`)
          : ["On branch main", "", "Changes to be committed:", "  \x1b[32mmodified: terminal workspace\x1b[0m", "", `${prompt}npm test`, "", " \x1b[32m✓\x1b[0m workspace interaction checks", " \x1b[32m✓\x1b[0m session history retained", "", prompt])].join("\r\n"));
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [ssh.sessions]);
  const collapse = () => { if (active) ctl.closeSplit(active.tabId); };
  return <div className="split-preview">
    <div className="split-preview-note"><span>分屏交互预览 · 使用正式窗格、工具栏与 xterm；连接为本地示例</span><button onClick={() => { const next = !dark; setDark(next); applyTheme(next ? "dark" : "light"); setTerminalMode(next ? "dark" : "light"); }}>{dark ? "切换亮色" : "切换深色"}</button></div>
    <div className="split-preview-shell">
      <aside className="split-preview-sidebar"><div className="split-preview-brand"><img src="/icon.png" alt=""/>CC Bridge</div><TerminalSidebar embedded connections={[conn]} sessions={ssh.sessions} activeId={ssh.activeId} isLoading={false} collapsed={false} connectingId={ssh.connectingId} confirmingDelete={null} onSetCollapsed={noop} onNew={noop} onConnect={c => { void ssh.connect(c); }} onDisconnect={id => { void ssh.disconnect(id); }} onNewTerminal={c => { void ssh.connect(c, { newTab: true }); }} onActivate={ssh.setActiveId} onOpenFiles={noop} onEdit={noop} onDeleteRequest={noop} onConfirmDelete={noop} onCancelDelete={noop}/></aside>
      <main className={`terminal-workspace split-preview-workspace ${fullscreen ? "split-preview-fullscreen" : ""}`} ref={area}>
        <TerminalTabsBar sessions={ssh.sessions} activeId={ssh.activeId} metaBySession={ssh.metaBySession} onActivate={ssh.setActiveId} onDisconnect={id => { void ssh.disconnect(id); }} onCloseTab={ssh.closeTab} onNewTerminal={() => { void ssh.connect(conn, { newTab: true }); }} onToggleSplit={ctl.toggleSplit} splitActive={!!ctl.split} onToolbarReady={workspace.setToolbarHost}
          splitControls={ctl.split && <TerminalSplitControls split={ctl.split} onDirection={ctl.setDirection} onEqualize={() => ctl.setRatio(50)} onCollapse={collapse}/>}/>
        <TerminalPanes sessions={ssh.sessions} activeId={ssh.activeId} split={ctl.split} toolbarHost={workspace.toolbarHost} focusedTabId={workspace.focusedTabId} onFocusPane={workspace.setFocusedTabId} connections={[conn]} connectingId={ssh.connectingId} emptyState={<div/>} dragSelectEnabled copyOnSelectEnabled fullscreen={fullscreen} onToggleFullscreen={() => setFullscreen(v => !v)} onClosed={(s, reason) => ssh.markClosed(s.sessionId, reason)} onReconnect={s => { void ssh.connect(s.conn, { intoTab: s.tabId, forSplit: !!s.splitOnly }); }} onCloseTab={s => ssh.closeTab(s.sessionId)} onCwd={noop} onMeta={ssh.patchMeta} onOpenFilePath={noop} onPickSplitConn={c => { void ctl.openSplit(c, ctl.split?.dir ?? "h"); }} onCloseSplit={collapse} onToggleDir={ctl.toggleDir} onSplitRatio={ctl.setRatio} onZoomPane={ctl.toggleZoom} onDisconnect={id => { void ssh.disconnect(id); }}/>
      </main>
    </div>
  </div>;
}
applyTheme("light"); setTerminalMode("light");
createRoot(document.getElementById("root")!).render(<Preview/>);
