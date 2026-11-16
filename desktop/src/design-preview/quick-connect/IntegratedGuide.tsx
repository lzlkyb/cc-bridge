import { useEffect, useRef, useState } from "react";
import { ToolGuide } from "../../components/tabs/connect/ToolGuide";
import { AddressPicker } from "../../components/tabs/connect/AddressPicker";
import { OptionCard } from "../../components/tabs/connect/widgets";
import { PermissionCard } from "../../components/tabs/connect/PermissionCard";
import { TokenManager } from "../../components/tabs/TokenManager";
import { SshConnectionDialog } from "../../components/tabs/SshConnectionDialog";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { buildHealthCheck, buildIpSedCommand, buildPermissionGrantCommand, copyText, type McpScope } from "../../lib/utils";
import { toast } from "../../components/ui/toast";
import type { McpClientTool } from "../../lib/mcpClients";
import type { StaticStatus } from "../../lib/types";
import { initialLink, compactLink, scenarioLinks, stepLabels, transition, type Action, type Scenario } from "./model";
import { sharedCommand, setupKey, type ConnectionMethod } from "./integration";
import { previewConnections } from "./mock";
import "../../components/tabs/connect/connect-guide.css";

export function IntegratedGuide({ scenario, status, refresh }: { scenario: Scenario; status: StaticStatus; refresh: () => void }) {
  const [method, setMethod] = useState<ConnectionMethod>(new URLSearchParams(location.search).get("method") === "direct" ? "direct" : "stable");
  const [tool, setTool] = useState<McpClientTool>("claude-code");
  const [connections, setConnections] = useState([...previewConnections]);
  const [selected, setSelected] = useState(connections[0]?.id ?? "");
  const [states, setStates] = useState(() => scenarioLinks(scenario));
  const [managing, setManaging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState<McpScope>((status.scope as McpScope) || "user");
  const [path, setPath] = useState(status.projectPath ?? "");
  const [ip, setIp] = useState(status.lanIps[0]);
  const [multi, setMulti] = useState(false);
  const [includeShell, setIncludeShell] = useState(false);
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState("");
  const [help, setHelp] = useState(false);
  const [applied, setApplied] = useState<Record<string, string>>(() => ({ cloud: scenario === "changed" ? "" : setupKey((status.scope as McpScope) || "user", status.projectPath ?? "", status.token, false) }));
  const fb = useCopyFeedback();
  const region = useRef<HTMLElement>(null);
  const link = states[selected] ?? initialLink();
  const connection = connections.find(c => c.id === selected);
  const stable = method === "stable" && tool === "claude-code";
  const busy = link.phase === "running";
  const reconnecting = link.phase === "reconnecting";
  const ready = link.phase === "ready";
  const effectiveScope = multi ? "user" : scope;
  const key = setupKey(effectiveScope, path, status.token, multi);
  const changed = link.configured && applied[selected] !== key;
  const compact = compactLink(link, managing);
  const command = sharedCommand({ method: stable ? "stable" : "direct", scope: effectiveScope, path, ip, port: stable ? link.port : status.port, token: status.token, multiDevice: multi });
  const permissionCommand = buildPermissionGrantCommand(effectiveScope, path, includeShell);
  const patch = (action: Action) => setStates(old => ({ ...old, [selected]: transition(old[selected] ?? initialLink(), action) }));
  const previousPhase = useRef(link.phase);
  useEffect(() => {
    if (previousPhase.current === "running" && ready) setManaging(false);
    previousPhase.current = link.phase;
  }, [link.phase, ready]);
  useEffect(() => {
    if (!Object.values(states).some(s => s.phase === "running" || s.phase === "reconnecting")) return;
    const timer = setTimeout(() => setStates(old => Object.fromEntries(Object.entries(old).map(([id, state]) => [id, transition(state, { type: "tick", scenario })]))), 850);
    return () => clearTimeout(timer);
  }, [states, scenario]);
  useEffect(() => {
    if (!status.running) setStates(old => Object.fromEntries(Object.entries(old).map(([id, state]) => [id, transition(state, { type: "stop" })])));
  }, [status.running]);
  const start = () => {
    if (!connection) { setMessage("请先添加要连接的服务器。"); return; }
    if (!status.running) { setMessage("本机服务已停止，请先使用顶栏的「启动服务」。"); return; }
    if (effectiveScope === "project" && !path.trim()) { setMessage("一键接入需要指定服务器项目路径，或选择全局模式。"); document.getElementById("unified-project-path")?.focus(); return; }
    if (link.issue === "password" && !secret.trim()) { setManaging(true); setMessage("请输入服务器登录密码后继续。"); return; }
    setMessage(""); setApplied(old => ({ ...old, [selected]: key }));
    if (link.phase === "error") { patch({ type: "repair" }); setSecret(""); }
    else patch({ type: "start", port: link.port });
  };
  const errorTitle = link.issue === "password" ? "请输入服务器登录密码" : link.issue === "missing" ? "服务器尚未安装 Claude Code" : "服务器不允许端口转发";
  const showRepair = link.phase === "error" && (!compact || managing);
  const copyDisabled = stable && (!link.configured || changed || busy);
  const actionLabel = busy ? "正在接入…" : reconnecting ? "正在恢复连接…" : link.phase === "error" ? link.issue === "password" ? "继续接入" : "重新检测" : changed ? "应用接入配置" : link.phase === "stopped" ? "重新接入" : ready ? "已接入" : "一键接入";
  const copyAddressUpdate = async () => {
    const command = buildIpSedCommand(ip, status.port, effectiveScope, path, false, tool, multi ? "demo" : "");
    if (!command) return false;
    let copied = false;
    await copyText(command, () => { copied = true; }, error => toast(`复制失败：${error}`, "error"));
    return copied;
  };

  return <section ref={region} className="qc-unified" aria-label="统一接入配置">
    <ToolGuide host={stable ? "127.0.0.1" : ip} port={stable ? link.port : status.port} token={status.token} transport="http" defaultTool="claude-code"
      onToolChange={setTool} multiDevice={multi} deviceId="demo" deviceName="我的电脑" onToggleMultiDevice={setMulti}
      common={<div className="qc-connection-region">
        {tool === "claude-code" && <div className="qc-method-heading"><h3>连接方式</h3><div className="qc-method-toggle" role="group" aria-label="连接方式"><button aria-pressed={method === "stable"} onClick={() => setMethod("stable")}>隧道连接<span>推荐</span></button><button aria-pressed={method === "direct"} onClick={() => setMethod("direct")}>IP 直连</button></div></div>}
        {stable ? <section className="qc-stable-method" aria-label="隧道连接设置" data-phase={link.phase}>
          {compact ? <div className="qc-inline-status"><div><span className="qc-status-dot"/><div aria-live="polite"><strong>{connection?.name} · {ready ? "隧道连接已开启" : reconnecting ? "正在恢复连接" : link.phase === "error" ? "需要重新登录" : "连接已停止"}</strong><p>{ready ? "VPN 重连无需改地址" : reconnecting ? "正在重新连接服务器，MCP 地址保持不变" : link.phase === "error" ? "登录信息已失效，补充密码后继续连接" : "固定地址和配置已保留"}</p></div></div><div className="qc-inline-actions">{ready && <button className="qc-link" onClick={() => patch({ type: "recheck" })}>重新检测</button>}{link.phase === "error" && <Button size="sm" onClick={() => setManaging(true)}>重新登录</Button>}<button className="qc-link" onClick={() => setManaging(true)} aria-label="管理隧道连接">管理<Icon name="chevronDown" size={13}/></button></div></div> : <>
            <div className="qc-stable-layout">
              <div className="qc-stable-intro"><span className="qc-network-icon"><Icon name="refresh" size={22}/></span><div><h4>VPN 重连，MCP 地址不变</h4><p>网络恢复后自动重连，无需重新配置 Claude Code。</p></div></div>
              <div className="qc-server-field"><div className="qc-server-heading"><label htmlFor="qc-server">服务器</label><button type="button" className="qc-link" disabled={busy} onClick={() => setAdding(true)}><Icon name="plus" size={13}/>添加服务器</button></div>
                {connections.length ? <><div className="qc-server-control"><Icon name="server" size={17}/><select id="qc-server" aria-describedby="qc-server-address" disabled={busy} value={selected} onChange={e => { setSelected(e.target.value); setMessage(""); setSecret(""); setManaging(false); }}>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><Icon name="chevronDown" size={15}/></div><p className="qc-server-address" id="qc-server-address">{connection?.username}@{connection?.host}</p></> : <p className="qc-empty-connection">添加服务器后，即可一键接入。</p>}
              </div>
            </div>
            {link.configured && !busy && <div className="qc-management-actions">{ready && <button type="button" className="qc-link qc-stop" onClick={() => patch({ type: "stop" })}>停止连接</button>}<button type="button" className="qc-link" onClick={() => setManaging(false)}>收起<Icon name="chevronUp" size={13}/></button></div>}
            {busy && <div className="qc-inline-progress" role="status"><Icon name="spinner" size={15} className="animate-spin"/><span>{stepLabels[link.step]}…</span><small>{link.step + 1} / 5</small>{scenario === "occupied" && link.repaired && <small>已自动换用可用端口 {link.port}</small>}</div>}
          </>}
          {showRepair && <div className="qc-inline-repair" role="alert"><b>{errorTitle}</b>{link.issue === "password" ? <form onSubmit={e => { e.preventDefault(); start(); }}><input aria-label="服务器登录密码" type="password" value={secret} autoFocus onChange={e => setSecret(e.target.value)} placeholder="输入服务器登录密码"/><span>仅用于本次连接，填写后点击下方「继续接入」。</span></form> : <><p>{link.issue === "missing" ? "安装完成后点击下方「重新检测」，从当前步骤继续。" : "请管理员允许 SSH 端口转发，再点击下方「重新检测」。"}</p><button className="qc-link" onClick={() => setHelp(!help)}>{help ? "收起说明" : "查看处理说明"}</button>{help && <p>{link.issue === "missing" ? "在服务器上按 Claude Code 官方说明完成安装，再运行 claude --version 确认。" : "请管理员检查 AllowTcpForwarding 和 PermitListen；无需开放公网监听地址。"}<br/>设计预览：重新检测将演示问题解决后的流程。</p>}</> }</div>}
          {link.configured && managing && <p className="qc-fixed-address">固定接入地址 <code>http://127.0.0.1:{link.port}/mcp</code><span>网络恢复后复用此地址</span></p>}
        </section> : <AddressPicker ips={status.lanIps} selected={ip} onSelect={setIp} healthCheck={buildHealthCheck(ip, status.port)} port={status.port} onRefresh={refresh} onCopySed={tool === "generic" ? undefined : copyAddressUpdate}/>} 
      </div>}
    >
      <div className="connect-guide">
        <fieldset disabled={busy && stable} className="qc-scope-fieldset"><div className="connect-section-heading"><h3>接入模式</h3><span>{multi ? "多设备接入固定使用全局模式" : "选择配置的生效范围"}</span></div>{multi ? <p className="connect-mode-note">全局模式 · 每台电脑使用独立条目，所有项目均可使用。</p> : <div className="connect-choice-grid"><OptionCard selected={scope === "project"} title="项目级" badge="推荐" desc="仅指定项目生效" onClick={() => setScope("project")}/><OptionCard selected={scope === "user"} title="全局模式" desc="一次配置，所有项目都能使用" onClick={() => setScope("user")}/></div>}</fieldset>
        <section className="connect-command" aria-labelledby="unified-command-heading"><div className="connect-command-heading"><div><div className="connect-section-heading"><h3 id="unified-command-heading">接入命令</h3><span className="connect-protocol">HTTP</span></div><p>{stable ? ready && !changed ? "接入检查已通过，重新打开服务器上的 Claude Code 即可使用。" : "一键建立隧道连接，并按上方接入模式配置 Claude Code。" : `SSH 登录远程服务器后，在${effectiveScope === "project" ? "项目" : "任意"}目录中执行以下命令。`}</p></div><div className="qc-command-actions"><Button size="sm" variant={stable ? "outline" : "default"} disabled={copyDisabled} onClick={() => fb.copy("connect", command)} title={copyDisabled ? "完成接入后，可复制实际生效的命令" : undefined}><Icon name={fb.isCopied("connect") ? "check" : "copy"} size={14}/>{fb.isCopied("connect") ? "已复制" : stable ? "复制命令" : "复制连接命令"}</Button>{stable && <>{busy && <button className="qc-link" onClick={() => patch({ type: "stop" })}>取消</button>}<Button size="sm" isLoading={busy} loadingText="正在接入…" disabled={(ready && !changed) || reconnecting} onClick={start}><Icon name={ready && !changed ? "check" : "plug"} size={14}/>{actionLabel}</Button></>}</div></div>
          {effectiveScope === "project" && <div className="connect-path"><label htmlFor="unified-project-path">远程项目路径 <span>{stable ? "一键接入时必填" : "可选"}</span></label><input id="unified-project-path" disabled={stable && busy} value={path} onChange={e => setPath(e.target.value)} placeholder="/home/ubuntu/my-project"/><p>{stable ? "配置写入该服务器项目，共用此处的路径设置。" : "留空时，请先在远程终端进入项目目录。"}</p></div>}
          {message && <p className="qc-validation" role="alert">{message}</p>}
          {stable && changed && <p className="qc-validation" role="status">接入配置已更改，点击「应用接入配置」后生效。</p>}
          <code className="connect-main-code">{command}</code><p className="connect-config-note">配置将写入 <code>{effectiveScope === "project" ? ".mcp.json" : "~/.claude.json"}</code>{stable ? link.configured ? "；网络变化后无需修改这个接入地址。" : "；首次接入自动确定固定端口，完成后可复制实际命令。" : `；执行后在${effectiveScope === "project" ? "该项目" : "任意项目"}中启动 Claude Code。`}</p>
        </section>
        <div className="connect-support-grid"><TokenManager status={{ ...status, scope: effectiveScope }} onRefresh={refresh} projectPath={path}/><PermissionCard scope={effectiveScope} projectPath={path} includeShellTools={includeShell} setIncludeShellTools={setIncludeShell} permissionCommand={permissionCommand} permCopied={fb.isCopied("permission")} handlePermCopy={() => fb.copy("permission", permissionCommand)}/></div>
      </div>
    </ToolGuide>
    <SshConnectionDialog open={adding} initial={null} connections={connections} onClose={() => setAdding(false)} onSaved={() => { setConnections([...previewConnections]); setSelected(previewConnections[previewConnections.length - 1].id); setMessage(""); }}/>
  </section>;
}
