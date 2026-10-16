import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon, type IconName } from "../components/ui/icon";
import { buildClientSnippet, CLIENT_LABELS, CLIENT_VERIFY, type McpClientTool } from "../lib/mcpClients";
import { computeChain } from "../lib/serviceChain";
import "./preview.css";

const clients: McpClientTool[] = ["claude-code", "codex", "workbuddy", "generic"];
const days = [38, 62, 49, 78, 57, 85, 68];
const activities = [
  ["读取文件", "src / components / App.tsx", "read_file", "24 ms", "14:32:08"],
  ["搜索内容", "src / lib", "search_files", "86 ms", "14:31:56"],
  ["列出目录", "D: / workspace / cc-bridge", "list_directory", "12 ms", "14:31:42"],
];

function App() {
  const [light, setLight] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [scenario, setScenario] = useState("running");
  const [client, setClient] = useState<McpClientTool>("claude-code");
  const [host, setHost] = useState("192.0.2.10");
  const [guideOpen, setGuideOpen] = useState(true);
  const [notice, setNotice] = useState("");
  const running = scenario !== "stopped";
  const empty = scenario === "first";
  // Reuse production semantics: local reachability must not imply remote access.
  const chain = computeChain({ running, startupError: null, remoteReachable: true, platform: "windows", firewallPortOpen: scenario !== "blocked", firewallAvailable: true, totalRequests: empty ? 0 : 1284, lastIncreaseAt: empty ? null : 100000, now: 105000, port: 7823 });
  const snippet = buildClientSnippet(client, { host, port: 7823, token: "DEMO_TOKEN_REPLACE_ME", transport: "http", tls: false });
  const showInfo = (text: string) => setNotice(text);
  const copy = async () => {
    try { await navigator.clipboard.writeText(snippet.code); showInfo("已复制示例配置，请替换示例地址和 Token 后使用。"); }
    catch { showInfo("浏览器未允许复制，请选中配置内容手动复制。"); }
  };
  const toolButton = (icon: IconName, label: string, action: () => void) => <button className="icon-button" title={label} aria-label={label} onClick={action}><Icon name={icon}/></button>;
  return <div className="preview" data-theme={light ? "light" : "dark"}>
    <div className="preview-bar"><span><b>设计预览</b><span className="preview-caption">A 工作台气质 · B 字体与布局</span></span><label>示例状态 <select aria-label="示例状态" value={scenario} onChange={e => setScenario(e.target.value)}><option value="running">正常运行</option><option value="first">首次接入</option><option value="blocked">防火墙拦截</option><option value="stopped">服务已停止</option></select></label></div>
    <div className="shell" data-collapsed={collapsed}>
      <aside className="sidebar">
        <div className="brand"><img src="/icon.png" alt=""/><div><strong>CC Bridge</strong><span>本地与 AI，自在连接</span></div></div>
        <nav aria-label="工作区"><button className="nav-item selected" aria-label="连接" aria-current="page"><Icon name="plug"/><span>连接</span><kbd>1</kbd></button>{([["terminal", "终端"], ["shield", "安全"], ["log", "日志"]] as [IconName,string][]).map(([icon,label],i)=><button key={label} className="nav-item" title={label} onClick={()=>showInfo(`${label}页沿用现有功能；本轮设计预览范围为外壳与连接页。`)}><Icon name={icon}/><span>{label}</span><kbd>{i+2}</kbd></button>)}</nav>
        <div className="sidebar-bottom"><div className="workspace-note"><Icon name="monitor"/><div>本机工作区<span>Windows · MCP 服务</span></div></div><button className="nav-item" title="设置" onClick={()=>showInfo("设置页将在下一轮按同一视觉规范精修。")}><Icon name="settings"/><span>设置</span></button><div className="sidebar-status"><i className={running ? "dot" : "dot muted"}/><span>{running ? "本机服务运行中" : "服务已停止"}</span></div></div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="topbar-left">{toolButton("chevronLeft", collapsed ? "展开导航" : "收起导航", ()=>setCollapsed(!collapsed))}<span>工作区</span><span className="slash">/</span><strong>连接</strong></div><div className="topbar-right"><button className="search-button" aria-label="搜索命令" onClick={()=>showInfo("正式应用已有 Ctrl+K 命令面板；设计稿保留此入口。")}><Icon name="search" size={14}/><span>搜索命令</span><kbd>Ctrl K</kbd></button>{toolButton(light ? "moon" : "sun", light ? "切换深色主题" : "切换浅色主题", ()=>setLight(!light))}<span className="topbar-divider"/><span className="window-marks" aria-hidden="true"><Icon name="minimize" size={14}/><Icon name="maximize" size={12}/><Icon name="close" size={14}/></span></div></header>
        <main>
          <div className="page-heading"><div><h1>连接工作台</h1><p>管理接入，了解每一次调用。</p></div><span className="demo-label"><i/>示例数据 · 未连接真实服务</span></div>
          <section className="service-panel" aria-label="服务与链路状态">
            <div className="service-summary"><span className={`service-symbol ${!running ? "offline" : scenario === "blocked" ? "warning" : ""}`}><Icon name={scenario === "blocked" ? "alertTriangle" : "plug"} size={22}/></span><div><div className="service-title"><h2>{!running ? "服务已停止" : scenario === "blocked" ? "远程接入受阻" : empty ? "等待首次接入" : "服务运行正常"}</h2><span className="badge neutral">MCP</span></div><p>{running ? "已运行 2 小时 34 分钟" : "启动服务后，AI 工具才能访问本机"}</p></div><div className="service-actions"><button className="button" disabled={!running} onClick={()=>showInfo("重启效果仅供设计演示，未执行实际服务操作。")}><Icon name="refresh" size={14}/>重启</button><button className={`button ${running ? "" : "primary"}`} onClick={()=>setScenario(running ? "stopped" : "running")}><Icon name={running ? "pause" : "play"} size={14}/>{running ? "停止服务" : "启动服务"}</button></div></div>
            <div className="chain">{chain.segments.map((segment,i)=><div className="chain-step" key={segment.key}><span className={`chain-icon ${segment.tone}`}><Icon name={segment.key === "service" ? "monitor" : segment.key === "firewall" ? "shield" : "terminal"} size={17}/></span><div><strong>{segment.name}</strong><span>{segment.detail}</span></div>{i<chain.segments.length-1 && <span className="chain-line"><Icon name="arrowRight" size={13}/></span>}</div>)}</div>
            {(scenario === "blocked" || empty) && <div className="state-message"><Icon name={empty ? "info" : "alertTriangle"} size={15}/>{empty ? "尚无远程调用。完成下方接入配置后，在 AI 工具中发起一次调用。" : "防火墙未放行此端口。请在正式应用的防火墙设置中检查入站规则。"}</div>}
          </section>
          <section className="connect-panel panel"><div className="section-heading"><div className="section-title"><Icon name="terminal" size={18}/><h2>接入 AI 工具</h2></div><button className="text-button" aria-expanded={guideOpen} onClick={()=>setGuideOpen(!guideOpen)}>{guideOpen ? "收起配置" : "展开配置"}<Icon name="chevronDown" size={14} className={guideOpen ? "rotate" : ""}/></button></div>
            <div className="client-tabs" role="group" aria-label="选择 AI 工具">{clients.map(c=><button key={c} aria-pressed={client===c} className={client===c ? "active" : ""} onClick={()=>setClient(c)}><Icon name={c === "claude-code" ? "terminal" : c === "generic" ? "plug" : "terminal"} size={15}/>{CLIENT_LABELS[c]}</button>)}</div>
            {guideOpen && <div className="guide-content"><div className="config-meta"><label>连接地址<select aria-label="连接地址" value={host} onChange={e=>setHost(e.target.value)}><option value="192.0.2.10">192.0.2.10 : 7823 · 示例内网</option><option value="198.51.100.20">198.51.100.20 : 7823 · 示例 VPN</option></select></label><span className="auth-label"><Icon name="key" size={13}/>Bearer 认证</span></div><div className="code-block"><div className="code-heading"><span>{snippet.target}</span><button className="copy-button" onClick={copy}><Icon name="copy" size={13}/>复制配置</button></div><pre><code>{snippet.code}</code></pre></div><div className="guide-foot"><span><Icon name="info" size={14}/>HTTP 仅用于可信内网或 VPN；跨公网请开启 HTTPS。</span><button className="text-button" onClick={()=>showInfo(CLIENT_VERIFY[client])}>验证接入<Icon name="arrowRight" size={14}/></button></div></div>}
          </section>
          <div className="section-heading metrics-heading"><h2>运行概览</h2><span>本次运行<span className="small-separator">·</span>5 秒采样</span></div>
          <section className="metrics" aria-label="运行指标">{[
            ["请求速率", "24", "次 / 分", "限流 120 次 / 60 秒", "activity"],
            ["P95 延迟", "86", "毫秒", "平均 32 毫秒", "clock"],
            ["调用增量", "+2", "次 / 5 秒", "累计 1,284 次 · 0 次失败", "log"],
            ["活跃命令", "0", "个", "当前无后台命令", "terminal"],
          ].map(([label,value,unit,sub,icon])=><div className="metric" key={label}><div className="metric-label">{label}<Icon name={icon as IconName} size={15}/></div><div className="metric-value">{!running ? "—" : empty ? "0" : value}<small>{unit}</small></div><p>{!running ? "服务停止，实时指标暂停" : empty ? "暂无调用数据" : sub}</p></div>)}</section>
          <div className="bottom-grid"><section className="panel safety-panel"><div className="section-heading"><div className="section-title"><Icon name="shield" size={17}/><h2>健康与安全</h2></div><span className="badge good">基础防护已开启</span></div><div className="health-summary"><strong>{!running || empty ? "—" : "100"}<small>{!running || empty ? "" : "%"}</small></strong><span>{!running ? "服务未运行" : empty ? "暂无调用，待评估" : "调用成功率"}<small>{empty ? "等待首次调用" : "0 次限流命中 · 0 次越权拒绝"}</small></span></div><div className="protection-grid">{["路径白名单 · 3 个目录", "审计日志", "自动写入备份", "请求限流"].map(s=><span key={s}><Icon name="check" size={13}/>{s}</span>)}</div></section><section className="panel usage-panel"><div className="section-heading"><div className="section-title"><Icon name="activity" size={17}/><h2>Token 用量</h2><span className="badge neutral">估算</span></div><span>近 7 天</span></div><div className="usage-content"><div className="usage-number"><strong>{empty ? "0" : "48.2k"}</strong><span>今日 tokens</span><p>{empty ? "暂无调用记录" : "输入 12.8k · 输出 35.4k"}</p></div><div className="bars" aria-label="近七日估算 Token 用量示例">{days.map((n,i)=><div className="bar-column" key={i}><div className={i === 6 ? "bar today" : "bar"} style={{height: empty ? 2 : n}} title={`${i+10} 日：${Math.round(n/68*48200).toLocaleString()} tokens（示例）`}/><span>{i===6 ? "今天" : `${i+10}日`}</span></div>)}</div></div></section></div>
          <section className="panel activity-panel"><div className="section-heading"><div className="section-title"><Icon name="log" size={17}/><h2>最近活动</h2></div><span>最近 3 条调用</span></div>{empty ? <p className="empty-activity">尚无活动。AI 工具的首次调用会显示在这里。</p> : <div className="activity-list">{activities.map(([label,path,tool,latency,time])=><div className="activity-row" key={time}><span className="activity-check"><Icon name="check" size={13}/></span><span className="activity-name">{label}<small>{path}</small></span><code>{tool}</code><span>{latency}</span><time>{time}</time></div>)}</div>}</section>
          <footer className="page-footer">CC Bridge<span>本地文件 · 可控访问 · 全程审计</span></footer>
        </main>
      </div>
    </div>
    {notice && <div className="toast" role="status"><Icon name="info" size={17}/><span>{notice}</span>{toolButton("close", "关闭提示", ()=>setNotice(""))}</div>}
  </div>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<App/>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());

