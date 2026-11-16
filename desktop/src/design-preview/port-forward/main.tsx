import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { ForwardPage } from "./ForwardPage";
import { PreviewShell } from "./PreviewShell";
import { SCENARIOS, type Scenario } from "./model";
import reference from "./reference.png";
import "../../index.css";
import "../../appearance.css";
import "../../terminal-workspace.css";
import "./style.css";

const query = new URLSearchParams(location.search);
const requested = query.get("scenario") || "running";
const initialScenario = (requested in SCENARIOS ? requested : "running") as Scenario;
const capture = query.has("capture");

function App() {
  const [scenario, setScenario] = useState(initialScenario);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState("new");
  const [tab, setTab] = useState("terminal");
  const [dark, setDark] = useState(query.get("theme") === "dark");
  const [material, setMaterial] = useState(query.get("style") === "classic" ? "classic" : "glass");
  const [collapsed, setCollapsed] = useState(innerWidth < 900);
  const [serviceRunning, setServiceRunning] = useState(true);
  const [tunnelReady, setTunnelReady] = useState(false);
  const [method, setMethod] = useState<"direct" | "tunnel">("direct");
  const [summary, setSummary] = useState({ count: 1, state: "运行中" });
  const [message, setMessage] = useState("");
  const toastTimer = useRef<number>();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.uiStyle = material;
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark, material]);
  useEffect(() => () => { window.clearTimeout(toastTimer.current); }, []);
  useEffect(() => {
    const resize = () => { if (innerWidth < 900) setCollapsed(true); };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const notify = useCallback((next: string) => {
    window.clearTimeout(toastTimer.current);
    setMessage(next);
    toastTimer.current = window.setTimeout(() => setMessage(""), 3600);
  }, []);
  const onSummary = useCallback((count: number, state: string) => setSummary({ count, state }), []);
  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify("使用地址已复制。请在规则标注的设备上使用。");
      return true;
    } catch {
      const input = document.createElement("textarea");
      input.value = value; input.className = "fp-copy-fallback";
      document.body.append(input); input.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch { copied = false; }
      input.remove();
      notify(copied ? "使用地址已复制。" : "复制未完成，可以选中地址手动复制。");
      return copied;
    }
  }, [notify]);
  const changeScenario = (next: Scenario) => {
    setScenario(next); setRevision(previous => previous + 1); setTab("terminal"); setView("new"); setMessage("");
  };
  const reset = () => {
    setRevision(previous => previous + 1); setTab("terminal"); setServiceRunning(true);
    setTunnelReady(false); setMethod("direct"); setMessage("");
  };
  const navigate = (next: string) => {
    if (next === "terminal" || next === "connect") setTab(next);
    else notify("这份设计稿聚焦端口转发，其他页面沿用现有入口。");
  };
  const toggleTunnel = () => {
    setTunnelReady(!tunnelReady); setMethod("tunnel");
    notify(tunnelReady ? "示例隧道已暂停，固定地址和配置保留。" : "示例隧道已恢复，端口转发页的托管状态已同步。");
  };
  return <div className="fp-preview" data-capture={capture || undefined}>
    {!capture && <header className="fp-review-bar">
      <div className="fp-review-title"><strong>端口转发 · 交互设计稿</strong><span>可点击操作，连接与状态均为示例</span></div>
      <div className="fp-review-controls">
        <div className="fp-review-tabs" role="group" aria-label="界面对照"><button aria-pressed={view === "new"} onClick={() => setView("new")}>新设计</button><button aria-pressed={view === "original"} onClick={() => setView("original")}>原界面</button></div>
        <select aria-label="演示场景" value={scenario} onChange={event => changeScenario(event.target.value as Scenario)}>{Object.entries(SCENARIOS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <button className="fp-review-button" onClick={() => setMaterial(material === "glass" ? "classic" : "glass")}><Icon name="palette" size={15} />{material === "glass" ? "玻璃风格" : "经典风格"}</button>
        <button className="fp-review-button" onClick={reset}><Icon name="refresh" size={14} />重置</button>
      </div>
    </header>}
    <div className="fp-reference" hidden={view !== "original"}><p>原界面 · 用户提供的参考截图</p><img src={reference} alt="原端口转发页面：按两个方向分别列出技术参数输入框。" /></div>
    <div className="fp-preview-content" hidden={view !== "new"}>
      <PreviewShell activeTab={tab} collapsed={collapsed} dark={dark} serviceRunning={serviceRunning} ruleCount={summary.count} ruleState={summary.state} tunnelReady={tunnelReady} method={method} onToggleSidebar={() => setCollapsed(!collapsed)} onTheme={() => setDark(!dark)} onService={() => { setServiceRunning(!serviceRunning); notify(serviceRunning ? "示例本机服务已停止。" : "示例本机服务已启动。"); }} onNavigate={navigate} notify={notify}>
        <div className="fp-page-viewport" hidden={tab !== "terminal"}><ForwardPage key={scenario + revision} scenario={scenario} tunnelReady={tunnelReady} onManage={() => setTab("connect")} notify={notify} onSummary={onSummary} onCopy={copy} /></div>
        <section className="fp-connect-viewport" hidden={tab !== "connect"}>
          <button className="fp-text-button fp-return" onClick={() => setTab("terminal")}><Icon name="arrowLeft" size={16} />返回端口转发</button>
          <div className="fp-connect-card">
            <div className="fp-connect-head"><span className="fp-purpose-icon"><Icon name="plug" size={23} /></span><div><h1>接入 Claude Code</h1><p>服务器使用固定地址访问本机 CC Bridge。</p></div><span className="fp-connect-label">隧道连接 · 推荐</span></div>
            <div className="fp-connect-info"><span>已保存的接入</span><strong>公司 · 项目级</strong><span>10.0.19.194:22 · lizuliang</span></div>
            <div className="fp-connect-status"><span className="fp-phase" data-phase={tunnelReady ? "running" : "stopped"}><span />{tunnelReady ? "隧道已连通" : "隧道已暂停"}</span><p>{tunnelReady ? "断网重连后继续使用原 MCP 地址。" : "恢复隧道即可继续使用，原地址和项目配置保留。"}</p></div>
            <div className="fp-use-address"><div><span>在服务器上的 Claude Code 使用</span><code>http://127.0.0.1:7823/mcp</code></div><Button variant="outline" onClick={() => void copy("http://127.0.0.1:7823/mcp")}><Icon name="copy" size={15} />复制接入地址</Button></div>
            <div className="fp-connect-actions"><Button onClick={toggleTunnel}><Icon name={tunnelReady ? "pause" : "play"} size={15} />{tunnelReady ? "暂停隧道" : "恢复隧道"}</Button><span>固定端口 7823 · 在此统一管理</span></div>
          </div>
          <p className="fp-connect-caption">此处演示“管理接入”的跳转和状态联动；实际接入流程沿用现有连接页。</p>
        </section>
      </PreviewShell>
    </div>
    <div className="fp-toast" role="status" hidden={!message}><Icon name="info" size={17} /><span>{message}</span><button className="fp-icon-button" aria-label="关闭提示" onClick={() => setMessage("")}><Icon name="close" size={15} /></button></div>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
