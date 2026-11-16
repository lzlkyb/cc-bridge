import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { TerminalForwardPanel } from "../../../components/tabs/TerminalForwardPanel";
import { ToastProvider } from "../../../components/ui/toast";
import { Icon } from "../../../components/ui/icon";
import { applyTheme } from "../../../lib/theme";
import type { SshConnectionList } from "../../../lib/types";
import { SCENES, reset, invoke, getConnection, getCalls, failSave, failStart, recoverRead, type Scene } from "./ProductionBackend";
import "../../../index.css";
import "../../../appearance.css";
import "../../../interaction-refinements.css";
import "./check.css";

const query = new URLSearchParams(location.search);
const requested = query.get("scene") || "empty";
const initial = (requested in SCENES ? requested : "empty") as Scene;
reset(initial);
applyTheme(query.get("theme") === "dark" ? "dark" : "light");
document.documentElement.dataset.uiStyle = query.get("style") === "classic" ? "classic" : "glass";
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
Object.assign(window, { forwardProductionCheck: { getCalls, failSave, failStart, recoverRead, reset } });

function CheckPage() {
  const [scene, setScene] = useState(initial);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const connections = useQuery({ queryKey: ["sshConnections"], queryFn: () => invoke<SshConnectionList>("ssh_list_connections") });
  const connection = connections.data?.connections[0] ?? getConnection();
  const change = (next: Scene) => { reset(next); setScene(next); setRevision(value => value + 1); void client.invalidateQueries(); };
  return <div className="forward-production-check">
    <div className="forward-check-tools"><div><strong>端口转发 · 正式页面预览</strong><p>模拟服务器，操作不会影响真实连接</p></div><select aria-label="验收场景" value={scene} onChange={event => change(event.target.value as Scene)}>{Object.entries(SCENES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{notice && <span role="status">{notice}</span>}</div>
    <div className="app-shell forward-check-shell">
      <aside className="forward-check-side"><div><img src="/icon.png" width={28} height={28} alt="" /><strong>CC Bridge</strong></div><p><Icon name="terminal" size={17} />终端</p><div className="forward-check-server"><Icon name="server" size={21} /><span><strong>公司</strong><small>server.example · dev</small></span></div><span className="forward-check-side-note">当前预览：端口转发</span></aside>
      <div className="forward-check-main"><TerminalForwardPanel key={revision} conn={connection} onBack={() => setNotice("已触发返回终端，预览继续保留此页。")} onNavigate={() => setNotice("已选择服务器并定位到接入 Claude Code。")} /></div>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><ToastProvider><CheckPage /></ToastProvider></QueryClientProvider>);
