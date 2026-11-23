import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SideNav, visibleNav } from "../../../components/layout/SideNav";
import { TitleBarControls } from "../../../components/layout/TitleBarControls";
import { ConnectTab } from "../../../components/tabs/ConnectTab";
import { Button } from "../../../components/ui/button";
import { Icon } from "../../../components/ui/icon";
import { Modal } from "../../../components/ui/Modal";
import { DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { toast } from "../../../components/ui/toast";
import { getStoredTheme, toggleTheme } from "../../../lib/theme";
import { LinkageProvider, initialLinkageScenario, seedLinkagePreview, useLinkage } from "./context";
import { linkageScenarios, scopeText, type LinkageScenario } from "./model";
import { status as previewStatus } from "../mock";
import "./linkage.css";

function LinkedHeader({ collapsed, onCollapse }: { collapsed: boolean; onCollapse: () => void }) {
  const link = useLinkage();
  const [dark, setDark] = useState(getStoredTheme() === "dark");
  useEffect(() => {
    const listener = (event: Event) => setDark((event as CustomEvent<string>).detail === "dark");
    window.addEventListener("themechange", listener); return () => window.removeEventListener("themechange", listener);
  }, []);
  return <header className="app-header app-topbar flex shrink-0 items-center gap-2 border-b px-3 ll-topbar">
    <Button variant="ghost" size="icon" onClick={onCollapse} aria-label={collapsed ? "展开工作区导航" : "收起工作区导航"}><Icon name="chevronLeft" size={22} className={collapsed ? "rotate-180" : ""}/></Button>
    <button type="button" className="ll-topbar-status" data-tone={link.summary.tone} onClick={() => link.focusGuide()} aria-label={`当前接入：${link.summary.methodLabel}，${link.summary.short}`}><span className="ll-dot"/><strong>{link.summary.methodLabel}</strong><span>{link.summary.short}</span><Icon name="chevronRight" size={13}/></button>
    <div className="flex min-w-0 flex-1"/>
    <div className="flex shrink-0 items-center gap-2"><Button variant={link.status.running ? "outline" : "default"} size="sm" isLoading={link.serviceBusy} loadingText="处理中…" onClick={() => void link.toggleService()} title="启停本机服务，影响全部接入"><Icon name={link.status.running ? "pause" : "play"} size={14}/>{link.status.running ? "停止服务" : "启动服务"}</Button><Button variant="ghost" size="sm" aria-label="搜索（Ctrl+K）" onClick={() => link.setSearchOpen(true)}><Icon name="search" size={18}/></Button><Button variant="ghost" size="icon" aria-label={dark ? "切换浅色" : "切换深色"} onClick={() => toggleTheme()}><Icon name={dark ? "sun" : "moon"} size={18}/></Button><div className="ll-window-controls"><TitleBarControls/></div></div>
  </header>;
}

function useConnectionCommands() {
  const link = useLinkage();
  const { summary } = link;
  const openSettings = () => {
    link.focusGuide();
    requestAnimationFrame(() => {
      const details = link.guideAnchor.current?.querySelector<HTMLDetailsElement>(".sc-advanced");
      if (details) details.open = true;
      link.guideAnchor.current?.querySelector(".connect-token")?.scrollIntoView({ block: "nearest" });
    });
  };
  return [
    { key: "view", icon: "plug", label: "查看当前接入", detail: `${summary.methodLabel} · ${summary.short}`, run: () => link.focusGuide() },
    { key: "address", icon: "copy", label: "复制接入地址", detail: summary.address || "完成隧道配置后显示固定地址", disabled: !summary.canCopyAddress, run: () => void link.copy("address") },
    { key: "command", icon: "terminal", label: "复制接入命令", detail: summary.canCopyCommand ? `${scopeText(summary.scope)}${summary.projectPath ? ` · ${summary.projectPath}` : ""}` : summary.changed ? "更新原接入后可复制生效命令" : "完成一键接入后可复制", disabled: !summary.canCopyCommand, run: () => void link.copy("command") },
    ...(!summary.stable ? [{ key: "ip", icon: "refresh", label: "复制 IP 替换命令", detail: "更新原地址，保留原项目与接入名称", run: () => void link.copy("ip") }] : []),
    ...(!["ip-changed", "paused", "service-stopped"].includes(summary.state) && (summary.stable || !["setup", "changed"].includes(summary.state)) ? [{ key: "check", icon: "shield", label: summary.action, detail: summary.detail, run: link.primary }] : []),
    { key: "token", icon: "key", label: "访问令牌与权限", detail: "在接入 Claude Code 卡内管理", run: openSettings },
    ...(summary.stable && summary.configured ? [{ key: "pause", icon: link.record?.enabled ? "pause" : "play", label: link.record?.enabled ? "暂停当前隧道" : "恢复当前隧道", detail: "固定地址和接入配置保留", run: link.record?.enabled ? link.pause : link.primary }] : []),
    { key: "service", icon: link.status.running ? "power" : "play", label: link.status.running ? "停止本机服务" : "启动本机服务", detail: "影响本机全部接入", disabled: link.serviceBusy, run: () => void link.toggleService() },
  ];
}

function QuickEntryPreviews() {
  const link = useLinkage();
  const [term, setTerm] = useState("");
  const commands = useConnectionCommands();
  const matching = commands.filter(command => !term || `${command.label} ${command.detail} ${link.summary.methodLabel}`.toLowerCase().includes(term.toLowerCase()));
  useEffect(() => { if (!link.searchOpen) setTerm(""); }, [link.searchOpen]);
  return <>
    <Modal open={link.searchOpen} onClose={() => link.setSearchOpen(false)} ariaLabel="命令面板" zIndex={100} className="w-full max-w-lg rounded-lg modal-surface p-5 ll-command-palette"><DialogHeader><DialogTitle>搜索页面与功能</DialogTitle><Button variant="ghost" size="icon" aria-label="关闭命令面板" onClick={() => link.setSearchOpen(false)}><Icon name="close" size={16}/></Button></DialogHeader>
      <input className="qc-search-input" autoFocus aria-label="搜索功能" value={term} onChange={event => setTerm(event.target.value)} placeholder="搜索：接入、地址、Token…"/>
      <div className="ll-palette-context"><span className="ll-dot"/><strong>{link.summary.methodLabel}</strong><span>{link.summary.short}</span></div>
      <div className="ll-palette-commands">{matching.map(command => <button type="button" className="ll-command-item" key={command.key} disabled={command.disabled} onClick={command.run}><Icon name={link.copied === command.key ? "check" : command.icon} size={17}/><span><strong>{link.copied === command.key ? "已复制" : command.label}</strong><small>{command.detail}</small></span><Icon name="arrowRight" size={13}/></button>)}{!matching.length && <p className="ll-no-results">没有找到相关功能，试试“接入”或“地址”。</p>}</div><p className="ll-palette-footnote">复制成功只表示已复制，接入状态由当前目标的验证结果确认。</p>
    </Modal>
    {link.trayOpen && <div className="ll-tray-overlay" onClick={() => link.setTrayOpen(false)}><section className="ll-tray-preview" role="dialog" aria-label="托盘菜单预览" onClick={event => event.stopPropagation()}><div className="ll-tray-title"><img src="/icon.png" alt=""/><strong>CC Bridge</strong><Button variant="ghost" size="icon" aria-label="关闭托盘预览" onClick={() => link.setTrayOpen(false)}><Icon name="close" size={14}/></Button></div><p className="ll-tray-service"><span className="ll-dot"/>本机服务{link.status.running ? "运行中" : "已停止"}</p><div className="ll-tray-context" data-tone={link.summary.tone}><strong>{link.summary.methodLabel} · {link.summary.short}</strong><code>{link.summary.address || "尚未配置固定地址"}</code></div><div className="ll-tray-commands">{commands.filter(command => command.key !== "token").map(command => <button type="button" key={command.key} disabled={command.disabled} onClick={command.run}><Icon name={link.copied === command.key ? "check" : command.icon} size={15}/><span>{link.copied === command.key ? "已复制" : command.label}</span></button>)}</div><p className="ll-tray-footnote">托盘与当前接入使用同一目标</p></section></div>}
  </>;
}

function PreviewSurface({ preset, changePreset }: { preset: LinkageScenario; changePreset: (next: LinkageScenario) => void }) {
  const link = useLinkage();
  const [collapsed, setCollapsed] = useState(innerWidth < 800);
  const [material, setMaterial] = useState(document.documentElement.dataset.uiStyle ?? "glass");
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); link.setSearchOpen(true); }
      if (event.key === "Escape") link.setTrayOpen(false);
    };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [link]);
  const navigate = (tab: string) => {
    if (tab === "connect") link.focusGuide();
    else if (tab === "service") { const details = link.guideAnchor.current?.querySelector<HTMLDetailsElement>(".ll-local-details"); if (details) details.open = !details.open; }
    else toast("这里演示连接页联动，其他功能继续使用原有入口。", "info");
  };
  return <div className="qc-preview ll-preview">
    <div className="qc-review-bar ll-review-bar"><div className="qc-review-name"><strong>连接页面 · 全入口联动设计稿</strong><span>交互预览 · 示例数据</span></div><div className="qc-review-controls">
      <select aria-label="演示场景" value={preset} onChange={event => changePreset(event.target.value as LinkageScenario)}>{Object.entries(linkageScenarios).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      {link.summary.state === "recovery" ? <button type="button" onClick={link.recoverNetwork}><Icon name="refresh" size={14}/>模拟网络恢复</button> : <button type="button" disabled={!link.summary.channelReady || link.summary.stable && (!link.summary.configured || link.summary.changed)} onClick={link.simulateCall}><Icon name="activity" size={14}/>模拟客户端调用</button>}
      <button type="button" aria-expanded={link.trayOpen} onClick={() => link.setTrayOpen(!link.trayOpen)}><Icon name="monitor" size={14}/>托盘预览</button>
      <button type="button" onClick={() => link.focusGuide()}><Icon name="plug" size={14}/>定位接入卡</button>
      <button type="button" aria-label="切换界面材质" onClick={() => { const next = material === "glass" ? "classic" : "glass"; setMaterial(next); document.documentElement.dataset.uiStyle = next; }}><Icon name="palette" size={14}/>{material === "glass" ? "柔光玻璃" : "经典实色"}</button>
      <button type="button" aria-label="重置当前演示场景" onClick={() => changePreset(preset)}><Icon name="refresh" size={14}/>重置</button>
    </div></div>
    <div className="app-boot-fade qc-app flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"><div className="app-shell">
      <SideNav activeTab="connect" onNavigate={navigate} navItems={visibleNav(link.status?.relayEnabled)} unreadCount={0} status={link.status} collapsed={collapsed}/>
      <div className="app-main flex min-h-0 min-w-0 flex-col"><LinkedHeader collapsed={collapsed} onCollapse={() => setCollapsed(old => !old)}/><main className="app-main-content flex min-h-0 flex-1 flex-col overflow-hidden" data-page="connect"><div className="page-scroll min-h-0 flex-1 overflow-y-auto" data-page-panel><div className="app-content-box"><p className="ll-statistics-scope">右侧统计范围：本机全部接入</p><div ref={link.guideAnchor} className="qc-guide-anchor"><ConnectTab status={link.status} onRefresh={link.refresh} selectedIp={link.ip} onSelectIp={link.selectIp} ipResolvedByUser={false} onSedResolved={() => {}} onNavigate={navigate} onCopySed={() => link.copy("ip")}/></div></div></div></main></div>
    </div></div><QuickEntryPreviews/>
  </div>;
}
export function LinkagePreview() {
  const [preset, setPreset] = useState(initialLinkageScenario);
  const [revision, setRevision] = useState(0);
  const client = useQueryClient();
  const changePreset = (next: LinkageScenario) => {
    void client.cancelQueries();
    client.removeQueries({ queryKey: ["stable-connect"] }); client.removeQueries({ queryKey: ["sshConnections"] });
    seedLinkagePreview(next);
    client.setQueryData(["status"], { ...previewStatus });
    setPreset(next); setRevision(old => old + 1);
  };
  return <LinkageProvider key={revision} preset={preset}><PreviewSurface preset={preset} changePreset={changePreset}/></LinkageProvider>;
}
