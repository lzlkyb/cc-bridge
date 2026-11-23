import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SideNav, visibleNav } from "../../components/layout/SideNav";
import { Header } from "../../components/layout/Header";
import { ConnectTab } from "../../components/tabs/ConnectTab";
import { ConnectBento } from "../../components/tabs/ConnectBento";
import { Icon } from "../../components/ui/icon";
import { Modal } from "../../components/ui/Modal";
import { DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { ToastProvider, toast } from "../../components/ui/toast";
import { applyTheme } from "../../lib/theme";
import { buildIpSedCommand, copyText, type McpScope } from "../../lib/utils";
import { IntegratedGuide } from "./IntegratedGuide";
import { ProposalConnectPage } from "./ProposalConnectPage";
import { discoveryScenarios, type DiscoveryScenario } from "./discovery";
import { status as sampleStatus, resetPreviewConnections } from "./mock";
import { productionPreviewQuery } from "./production-fixture";
import { LinkagePreview } from "./linkage/LinkagePreview";
import { initialLinkageScenario, seedLinkagePreview } from "./linkage/context";
import type { Scenario } from "./model";
import "../../index.css";
import "../../interaction-refinements.css";
import "../../appearance.css";
import "./style.css";

const query = productionPreviewQuery();
applyTheme(query.get("theme") === "dark" ? "dark" : "light");
document.documentElement.dataset.uiStyle = query.get("style") === "classic" ? "classic" : "glass";
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 60_000 } } });
client.setQueryData(["status"], sampleStatus);
const scenarios: Record<Scenario, string> = {
  normal: "首次配置 · 已有服务器", first: "首次配置 · 添加服务器", returning: "日常使用 · 隧道连接正常", recovery: "断网 · 等待网络恢复", paused: "已暂停 · 配置保留", changed: "配置变更 · 待应用",
  interrupted: "连接异常 · 需要登录", password: "首次接入 · 需要密码", missing: "尚未安装 Claude Code", occupied: "自动修复 · 端口占用", denied: "服务器禁止转发",
};
const requested = query.get("scenario") ?? "normal";
const initialScenario = (requested in scenarios ? requested : "normal") as Scenario;
const initialDiscoveryScenario = (requested in discoveryScenarios ? requested : "existing-project") as DiscoveryScenario;
type PreviewView = "proposal" | "implemented" | "original";
const initialView: PreviewView = query.has("current") || query.get("view") === "original" ? "original" : query.get("view") === "implemented" || requested in scenarios && query.has("scenario") ? "implemented" : "proposal";
resetPreviewConnections(initialView !== "proposal" && initialScenario === "first", initialView === "proposal" ? "normal" : initialScenario);

function App() {
  const [view, setView] = useState<PreviewView>(initialView);
  const [scenario, setScenario] = useState(initialScenario);
  const [discoveryScenario, setDiscoveryScenario] = useState(initialDiscoveryScenario);
  const [revision, setRevision] = useState(0);
  const [style, setStyle] = useState(document.documentElement.dataset.uiStyle);
  const [collapsed, setCollapsed] = useState(innerWidth < 800);
  const [status, setStatus] = useState({ ...sampleStatus });
  const [ip, setIp] = useState(sampleStatus.lanIps[0]);
  const [search, setSearch] = useState(false);
  const [term, setTerm] = useState("");
  const guide = useRef<HTMLDivElement>(null);
  document.documentElement.dataset.quickConnect = String(view !== "original");
  const refresh = () => { setStatus({ ...sampleStatus }); client.setQueryData(["status"], { ...sampleStatus }); };
  const copyIpUpdate = async () => { let copied = false; await copyText(buildIpSedCommand(ip, status.port, status.scope as McpScope, status.projectPath ?? ""), () => { copied = true; }); return copied; };
  const scrollToGuide = () => ([...guide.current?.querySelectorAll('[aria-label="连接方式"]') ?? []].find(el => el.getClientRects().length)?.closest(".card-primary") ?? guide.current)?.scrollIntoView({ block: "start" });
  const focusGuide = () => { setSearch(false); requestAnimationFrame(scrollToGuide); };
  const reset = (legacy: Scenario = "normal") => {
    resetPreviewConnections(legacy === "first", legacy);
    client.removeQueries({ queryKey: ["sshConnections"] }); client.removeQueries({ queryKey: ["stable-connect"] });
    Object.assign(sampleStatus, { scope: "user", projectPath: "", running: true, connectClient: "claude-code" }); setStatus({ ...sampleStatus }); client.setQueryData(["status"], { ...sampleStatus });
    setRevision(v => v + 1);
  };
  const changeScenario = (next: Scenario) => {
    reset(next); setScenario(next);
  };
  const changeDiscoveryScenario = (next: DiscoveryScenario) => { reset(); setDiscoveryScenario(next); };
  const changeView = (next: PreviewView) => { reset(next === "proposal" ? "normal" : scenario); setView(next); };
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearch(true); } };
    window.addEventListener("keydown", fn); return () => window.removeEventListener("keydown", fn);
  }, []);
  useEffect(() => {
    if (!query.has("focus")) return;
    const frame = requestAnimationFrame(scrollToGuide);
    return () => cancelAnimationFrame(frame);
  }, []);
  const navigate = (tab: string) => {
    if (tab === "connect") focusGuide();
    else toast("设计稿仅演示接入卡；此功能继续使用正式应用原有入口。", "info");
  };
  return <div className="qc-preview">
    <div className="qc-review-bar"><div className="qc-review-name"><strong>{query.has("configuredScope") ? "隧道连接 · 使用范围设计稿" : "隧道连接 · 接入升级设计稿"}</strong><span>示例数据，不连接真实服务器</span></div><div className="qc-review-controls">
      {!query.has("configuredScope") && <div className="qc-segment" aria-label="界面对照"><button aria-pressed={view === "proposal"} onClick={() => changeView("proposal")}>新设计</button><button aria-pressed={view === "implemented"} onClick={() => changeView("implemented")}>当前界面</button><button aria-pressed={view === "original"} onClick={() => changeView("original")}>原设计</button></div>}
      <select aria-label="演示场景" value={view === "proposal" ? discoveryScenario : scenario} onChange={e => view === "proposal" ? changeDiscoveryScenario(e.target.value as DiscoveryScenario) : changeScenario(e.target.value as Scenario)}>{Object.entries(view === "proposal" ? discoveryScenarios : scenarios).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button onClick={focusGuide}><Icon name="plug" size={14}/>定位接入卡</button>
      <button aria-label="切换界面材质" onClick={() => { const next = style === "glass" ? "classic" : "glass"; setStyle(next); document.documentElement.dataset.uiStyle = next; }}><Icon name="palette" size={14}/>{style === "glass" ? "柔光玻璃" : "经典实色"}</button>
      <button onClick={() => view === "proposal" ? changeDiscoveryScenario(discoveryScenario) : changeScenario(scenario)}><Icon name="refresh" size={14}/>重置</button>
    </div></div>
    <div className="app-boot-fade qc-app flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"><div className="app-shell">
      <SideNav activeTab="connect" onNavigate={navigate} navItems={visibleNav(status.relayEnabled)} unreadCount={0} status={status} collapsed={collapsed}/>
      <div className="app-main flex min-h-0 min-w-0 flex-col"><Header status={status} onChanged={refresh} onNavigate={navigate} onOpenSearch={() => setSearch(true)} collapsed={collapsed} onToggleCollapse={() => setCollapsed(v => !v)}/>
        <main className="app-main-content flex min-h-0 flex-1 flex-col overflow-hidden" data-page="connect"><div className="page-scroll min-h-0 flex-1 overflow-y-auto" data-page-panel><div className="app-content-box">
          {view === "proposal" ? <ProposalConnectPage scenario={discoveryScenario} revision={revision} status={status} ip={ip} onSelectIp={setIp} refresh={refresh} onNavigate={navigate} onCopySed={copyIpUpdate} anchor={guide}/> : view === "implemented" ? <div ref={guide} className="qc-guide-anchor"><ConnectTab key={revision} status={status} onRefresh={refresh} selectedIp={ip} onSelectIp={setIp} ipResolvedByUser={false} onSedResolved={() => {}} onNavigate={navigate} onCopySed={copyIpUpdate}/></div> : <ConnectBento status={status} displayHost={ip} port={status.port} onChanged={refresh} onNavigate={navigate} guide={<div ref={guide} className="qc-guide-anchor"><IntegratedGuide key={revision} scenario={scenario} status={status} refresh={refresh}/></div>}/>}
        </div></div></main>
      </div>
    </div></div>
    <Modal open={search} onClose={() => setSearch(false)} ariaLabel="搜索页面与功能" zIndex={100} className="w-full max-w-lg rounded-lg modal-surface p-6"><DialogHeader><DialogTitle>搜索页面与功能</DialogTitle><button aria-label="关闭搜索" className="qc-link" onClick={() => setSearch(false)}><Icon name="close" size={17}/></button></DialogHeader><input className="qc-search-input" autoFocus aria-label="搜索功能" value={term} onChange={e => setTerm(e.target.value)} placeholder="试试：VPN、地址变化、端口转发"/>{!term || /VPN|地址|隧道|稳定|端口|转发|接入|ssh/i.test(term) ? <button className="qc-search-result" onClick={focusGuide}><Icon name="plug" size={19}/><span><b>接入 Claude Code · 隧道连接</b><small>VPN 重新连接，也不用修改 MCP 地址</small></span><Icon name="arrowRight" size={16}/></button> : <p className="text-xs text-muted-foreground mt-4">没有匹配项，试试“VPN”。</p>}</Modal>
  </div>;
}
const linkage = query.get("view") === "linkage";
if (linkage) { seedLinkagePreview(initialLinkageScenario()); client.setQueryData(["status"], { ...sampleStatus }); }
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><ToastProvider>{linkage ? <LinkagePreview/> : <App/>}</ToastProvider></QueryClientProvider>);
