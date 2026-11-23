import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Header } from "../../../components/layout/Header";
import { SideNav, visibleNav } from "../../../components/layout/SideNav";
import { ConnectTab } from "../../../components/tabs/ConnectTab";
import { CommandPalette } from "../../../components/modals/CommandPalette";
import { CurrentConnectionProvider } from "../../../hooks/useCurrentConnection";
import { useStableConnectSnapshot } from "../../../hooks/useStableConnectSnapshot";
import { useConnectionCopy } from "../../../hooks/useConnectionCopy";
import { CurrentConnectionAlert } from "../../../components/layout/CurrentConnectionAlert";
import { currentConnection, CONNECT_GUIDE_ANCHOR } from "../../../lib/connectionAccess";
import { ToastProvider } from "../../../components/ui/toast";
import { applyTheme } from "../../../lib/theme";
import type { StatusResponse } from "../../../lib/types";
import { invoke, resetCheck, recoverCheck, getCheckStatus, scenarios, type Scenario } from "./ProductionBackend";
import "../../../index.css";
import "../../../interaction-refinements.css";
import "../../../appearance.css";
import "../../../connection-access.css";
import "../style.css";

const query = new URLSearchParams(location.search);
applyTheme(query.get("theme") === "dark" ? "dark" : "light");
document.documentElement.dataset.uiStyle = query.get("style") === "classic" ? "classic" : "glass";
const initial = query.get("scenario") as Scenario || "waiting";
resetCheck(initial in scenarios ? initial : "waiting");
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

function CheckPage() {
  const { data: status } = useQuery({ queryKey: ["status"], queryFn: () => invoke<StatusResponse>("get_status") });
  const snapshot = useStableConnectSnapshot(status);
  const [scenario, setScenario] = useState(initial);
  const [revision, setRevision] = useState(0);
  const [ip, setIp] = useState(getCheckStatus().lanIps[0]);
  const [search, setSearch] = useState(false);
  const [collapsed, setCollapsed] = useState(innerWidth < 800);
  const [anchor, setAnchor] = useState<{ anchor: string; nonce: number } | null>(null);
  const access = currentConnection(status, snapshot.data);
  const navigate = useCallback((_tab: string, target?: string) => { setSearch(false); setAnchor({ anchor: target ?? CONNECT_GUIDE_ANCHOR, nonce: Date.now() }); }, []);
  const refresh = useCallback(() => { void client.invalidateQueries({ queryKey: ["status"] }); }, []);
  const change = (next: Scenario) => { resetCheck(next); setScenario(next); setIp(getCheckStatus().lanIps[0]); setRevision(value => value + 1); void client.invalidateQueries(); };
  return <CurrentConnectionProvider access={access}><div className="qc-preview">
    <div className="qc-review-bar"><div className="qc-review-name"><strong>连接页面 · 正式组件验收</strong><span>模拟数据，不连接真实服务器</span></div><div className="qc-review-controls">
      <select aria-label="验收场景" value={scenario} onChange={event => change(event.target.value as Scenario)}>{Object.entries(scenarios).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button onClick={() => navigate("connect")}>定位接入卡</button><button onClick={recoverCheck}>模拟网络恢复</button>
    </div></div>
    <div className="qc-app flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"><div className="app-shell">
      <SideNav activeTab="connect" onNavigate={navigate} navItems={visibleNav(status?.relayEnabled)} unreadCount={0} status={status} collapsed={collapsed}/>
      <div className="app-main flex min-h-0 min-w-0 flex-col"><Header status={status} onChanged={refresh} onNavigate={navigate} onOpenSearch={() => setSearch(true)} collapsed={collapsed} onToggleCollapse={() => setCollapsed(value => !value)}/>
        <main className="app-main-content flex min-h-0 flex-1 flex-col overflow-hidden" data-page="connect"><div className="page-scroll min-h-0 flex-1 overflow-y-auto" data-page-panel><div className="app-content-box">
          <CurrentConnectionAlert status={status} onNavigate={navigate}/>
          <CheckConnect key={revision} status={status} refresh={refresh} ip={ip} setIp={setIp} navigate={navigate} anchor={anchor}/>
        </div></div></main>
      </div>
    </div></div>
    {search && <CommandPalette status={status} navItems={visibleNav(status?.relayEnabled)} onClose={() => setSearch(false)} onNavigate={navigate} onChanged={refresh}/>}
  </div></CurrentConnectionProvider>;
}
function CheckConnect({ status, refresh, ip, setIp, navigate, anchor }: {
  status?: StatusResponse; refresh: () => void; ip: string; setIp: (ip: string) => void;
  navigate: (tab: string, anchor?: string) => void; anchor: { anchor: string; nonce: number } | null;
}) {
  const copy = useConnectionCopy(status);
  return <ConnectTab status={status} onRefresh={refresh} selectedIp={ip} onSelectIp={(next, byUser = true) => { setIp(next); if (byUser) void invoke("set_selected_ip", { ip: next }).then(refresh); }}
    ipResolvedByUser={false} onSedResolved={() => {}} onNavigate={navigate} onCopySed={() => copy.copy("ip-update")} highlightAnchor={anchor}/>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><ToastProvider><CheckPage/></ToastProvider></QueryClientProvider>);
