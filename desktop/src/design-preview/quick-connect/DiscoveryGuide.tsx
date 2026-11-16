import { useEffect, useReducer, useRef, useState } from "react";
import { ToolGuide } from "../../components/tabs/connect/ToolGuide";
import { TokenManager } from "../../components/tabs/TokenManager";
import { PermissionCard } from "../../components/tabs/connect/PermissionCard";
import { SshConnectionDialog } from "../../components/tabs/SshConnectionDialog";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { buildPermissionGrantCommand } from "../../lib/utils";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import type { StaticStatus } from "../../lib/types";
import type { McpClientTool } from "../../lib/mcpClients";
import { ProjectPicker } from "./ProjectPicker";
import { ConnectionTargets } from "./ConnectionTargets";
import { previewConnections } from "./mock";
import { actionLabel, connectionPlan, discoveryReducer, initialDiscovery, progressLabels, scopeLabel, selectedEntry, visibleEntries, type DiscoveryScenario, type Project } from "./discovery";
import "../../components/tabs/connect/connect-guide.css";
import "../../components/tabs/connect/stable-connect.css";
import "./discovery.css";

export function DiscoveryGuide({ scenario, status, refresh, onChooseDirect, onToolChange }: {
  scenario: DiscoveryScenario; status: StaticStatus; refresh: () => void;
  onChooseDirect?: (serverId: string) => void | Promise<void>; onToolChange?: (tool: McpClientTool) => void | Promise<void>;
}) {
  const [ui, setUi] = useState({
    servers: [...previewConnections], serverId: previewConnections[0]?.id ?? "",
    adding: false, picker: null as "projects" | "entries" | null, includeShell: false, nextStep: true,
  });
  const [state, dispatch] = useReducer(discoveryReducer, initialDiscovery(scenario, ui.serverId));
  const token = useRef(status.token);
  const region = useRef<HTMLElement>(null);
  const fb = useCopyFeedback();
  const patch = (next: Partial<typeof ui>) => setUi(old => ({ ...old, ...next }));
  const busy = state.phase === "applying";
  const checking = state.phase === "checking";
  const complete = state.phase === "complete";
  const server = ui.servers.find(s => s.id === ui.serverId);
  const entry = selectedEntry(state);
  const plan = state.pending ?? state.result ?? connectionPlan(state, status.port);
  const scope = entry?.scope === "user" ? "user" : entry ? "project" : state.scope;
  const projectPath = entry?.projectPath ?? state.project?.path ?? "";
  const picking = !!ui.picker || state.phase === "choose";
  const chooseProject = (project: Project) => { dispatch({ type: "project", project }); patch({ picker: null }); };
  const changeServer = (serverId: string) => { patch({ serverId, picker: null, nextStep: true }); dispatch({ type: "server", serverId, scenario }); };
  useEffect(() => {
    if (state.phase !== "checking" && state.phase !== "applying") return;
    const timer = setTimeout(() => dispatch({ type: "tick" }), state.phase === "checking" ? 600 : 800);
    return () => clearTimeout(timer);
  }, [state.phase, state.step, state.scanPath, ui.serverId]);
  useEffect(() => {
    if (token.current === status.token) return;
    token.current = status.token; dispatch({ type: "token" });
  }, [status.token]);
  useEffect(() => {
    if (!picking) return;
    const frame = requestAnimationFrame(() => region.current?.querySelector(".sc-picker")?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [picking, ui.picker]);
  const configure = () => { dispatch({ type: "configure" }); patch({ nextStep: true }); };

  return <section ref={region} className="qc-unified sc-guide" aria-label="隧道连接接入升级设计">
    <ToolGuide host="127.0.0.1" port={status.port} token={status.token} transport="http" selectedTool="claude-code" onToolChange={onToolChange} disabled={busy} hideMultiDeviceToggle
      common={<div className="qc-connection-region">
        <div className="qc-method-heading"><h3>连接方式</h3><div className="qc-method-toggle" role="group" aria-label="连接方式"><button disabled={busy} aria-pressed={true}>隧道连接<span>推荐</span></button><button disabled={busy} aria-pressed={false} onClick={() => void onChooseDirect?.(ui.serverId)}>IP 直连</button></div></div>
        <section className="qc-stable-method" aria-label="连接服务器设置">
          {complete ? <div className="qc-inline-status"><div><span className="qc-status-dot"/><div><strong>{server?.name} · 隧道连接已配置</strong><p>VPN 重连，继续使用固定地址</p></div></div><button className="qc-link" onClick={configure}>管理连接<Icon name="chevronDown" size={13}/></button></div> : picking ? <div className="sc-picker-server"><Icon name="server" size={17}/><label htmlFor="sc-picker-server">服务器</label><select id="sc-picker-server" value={ui.serverId} onChange={e => changeServer(e.target.value)}>{ui.servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select><span>{server?.username}@{server?.host}</span><button className="qc-link" onClick={() => patch({ adding: true })}><Icon name="plus" size={13}/>添加服务器</button></div> : <div className="qc-stable-layout">
            <div className="qc-stable-intro"><span className="qc-network-icon"><Icon name="refresh" size={22}/></span><div><h4>VPN 重连，MCP 地址不变</h4><p>网络恢复后自动重连，无需反复修改 Claude Code 地址。</p></div></div>
            <div className="qc-server-field"><div className="qc-server-heading"><label htmlFor="sc-server">Claude Code 所在服务器</label><button className="qc-link" disabled={busy} onClick={() => patch({ adding: true })}><Icon name="plus" size={13}/>添加服务器</button></div><div className="qc-server-control"><Icon name="server" size={17}/><select id="sc-server" value={ui.serverId} disabled={busy} aria-describedby="sc-server-address" onChange={e => changeServer(e.target.value)}>{ui.servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select><Icon name="chevronDown" size={15}/></div><p className="qc-server-address" id="sc-server-address">{server?.username}@{server?.host}</p></div>
          </div>}
        </section>
      </div>}
    >
      <div className="sc-flow">
        {checking ? <div className="sc-checking" role="status"><Icon name="spinner" size={17} className="animate-spin"/><div><strong>正在检查服务器上的接入…</strong><p>{state.scanPath ? `只检查你选择的项目：${state.scanPath}` : "检查已有配置和最近使用的项目，稍等片刻。"}</p></div></div> : state.phase === "failed" && !picking ? <div className="sc-check-failed" role="alert"><Icon name="info" size={18}/><div><strong>暂时没读到服务器的接入配置</strong><p>可以重新检查，或选择一个项目后再检查。</p><div><button className="qc-link" onClick={() => dispatch({ type: "retry" })}><Icon name="refresh" size={13}/>重新检查</button><button className="qc-link" onClick={() => patch({ picker: "projects" })}>选择一个项目再检查<Icon name="arrowRight" size={13}/></button></div></div></div> : !complete && !picking && state.phase !== "failed" && <div className="sc-target-summary" aria-live="polite">
          <span className={`sc-target-mark ${entry ? "sc-found" : ""}`}><Icon name={entry ? "check" : "plug"} size={17}/></span><div><h3>{entry ? `已找到「${entry.title}」的原有接入` : "这台服务器还没有接入桥"}</h3><p>{entry ? "改用隧道连接，沿用原来的接入名称和生效范围。" : "完成一次配置，就可以在服务器上的 Claude Code 使用。"}</p>{entry && <div className="sc-target-meta"><span>{scopeLabel(entry.scope)}</span><code>{entry.name}</code>{entry.projectPath && <span className="sc-project-path">{entry.projectPath}</span>}</div>}</div>{entry && !busy && <button className="qc-link sc-target-change" onClick={() => patch({ picker: "entries" })}>更换接入<Icon name="chevronDown" size={13}/></button>}
        </div>}

        {(state.phase === "choose" || ui.picker === "entries") && <ConnectionTargets entries={visibleEntries(state)} onChoose={id => { dispatch({ type: "select", id }); patch({ picker: null }); }} onClose={state.phase === "choose" ? undefined : () => patch({ picker: null })}/>}
        {state.phase === "empty" && !picking && <fieldset className="sc-scope" disabled={busy}><legend>在哪里使用桥？</legend><div role="group" aria-label="接入生效范围"><button aria-pressed={state.scope === "user"} onClick={() => { dispatch({ type: "scope", scope: "user" }); patch({ picker: null }); }}><Icon name="globe" size={17}/><span><b>所有项目都可用<em>推荐</em></b><small>配置一次，不用选择文件夹</small></span><Icon name={state.scope === "user" ? "check" : "chevronRight"} size={15}/></button><button aria-pressed={state.scope === "project"} onClick={() => { dispatch({ type: "scope", scope: "project" }); patch({ picker: "projects" }); }}><Icon name="folder" size={17}/><span><b>只在一个项目使用</b><small>从服务器上选择项目文件夹</small></span><Icon name={state.scope === "project" ? "check" : "chevronRight"} size={15}/></button></div>{state.scope === "project" && <button className="sc-selected-project" onClick={() => patch({ picker: "projects" })}><Icon name="folder" size={17}/><span><b>{state.project?.name ?? "请选择服务器上的项目"}</b>{state.project && <small>{state.project.path}</small>}</span><span>{state.project ? "更换项目" : "选择项目"}<Icon name="chevronDown" size={13}/></span></button>}</fieldset>}
        {ui.picker === "projects" && <ProjectPicker projects={state.projects} entries={state.entries} currentPath={state.currentPath} onChoose={chooseProject} onClose={() => patch({ picker: null })}/>}

        {plan && !complete && !picking && <section className="sc-address-change" aria-labelledby="sc-address-heading"><div className="sc-address-heading"><h3 id="sc-address-heading">{plan.action === "setup" ? "固定接入地址" : "将原有接入改为固定地址"}</h3></div><div className="sc-addresses"><div><span>{plan.before ? "原 IP 地址" : "首次接入"}</span>{plan.before ? <code>{plan.before}</code> : <p>还没有配置接入地址</p>}</div><Icon name="arrowRight" size={18}/><div><span>固定接入地址</span><code>{plan.after}</code></div></div><p className="sc-address-note">固定地址保存在服务器上，VPN 断开并恢复后继续使用。</p>{plan.tokenUpdate && <p className="sc-token-note"><Icon name="key" size={14}/>原 Token 已变化，本次会一并更新。</p>}</section>}

        {busy && state.pending && <div className="stable-inline-progress sc-progress" role="status"><ol className="stable-progress-steps" aria-label="接入进度">{progressLabels(state.pending).map((label, index) => <li key={label} data-state={index < state.step ? "done" : index === state.step ? "current" : "waiting"}><span className="stable-progress-mark">{index < state.step ? <Icon name="check" size={12}/> : index + 1}</span>{label}</li>)}</ol><p><Icon name="spinner" size={13} className="animate-spin"/>{progressLabels(state.pending)[state.step]}…</p></div>}
        {complete && state.result && <>
          {ui.nextStep && <div className="connect-next-step" role="status"><Icon name="check" size={20}/><div><strong>{state.result.action === "upgrade" ? "已改用隧道连接" : "隧道连接配置完成"}</strong><p>请重新打开服务器上的 Claude Code。{state.result.entry.scope !== "user" && `在「${state.result.entry.title}」项目中打开即可。`}</p></div><button className="qc-link sc-muted-link" onClick={() => patch({ nextStep: false })}>知道了</button></div>}
          <div className="sc-completed-address"><span>当前接入地址</span><code>{state.result.after}</code><button className="qc-link" onClick={() => fb.copy("address", state.result!.after)}><Icon name={fb.isCopied("address") ? "check" : "copy"} size={13}/>{fb.isCopied("address") ? "已复制" : "复制"}</button></div>
        </>}
        {!complete && !picking && <div className="sc-action-row"><p>{checking ? "检查完成后，会自动判断是升级还是首次接入。" : state.phase === "failed" ? "读取成功后才能继续配置。" : state.scope === "project" && !state.project && !entry ? "选择项目后即可继续。" : plan?.action === "setup" ? `将接入${state.scope === "user" ? "所有项目" : `「${state.project?.name}」`}` : `升级「${entry?.title}」的原有接入`}</p><Button size="sm" disabled={!plan || !plan.changed || !status.running || busy} isLoading={busy} loadingText="正在配置…" onClick={() => dispatch({ type: "apply", port: status.port })}><Icon name="plug" size={14}/>{actionLabel(plan)}</Button></div>}
        {!status.running && <p className="sc-service-note" role="alert">本机服务已停止，请先在顶栏启动服务。</p>}
        {!picking && <details className="connect-advanced sc-advanced"><summary>更多设置<span>接入详情、Token 与权限</span></summary><div className="connect-advanced-content"><dl className="sc-config-details"><div><dt>接入名称</dt><dd><code>{entry?.name ?? "cc-bridge"}</code></dd></div><div><dt>生效范围</dt><dd>{scopeLabel(entry?.scope ?? state.scope)}</dd></div><div><dt>配置位置</dt><dd><code>{entry?.configFile ?? (state.project ? `${state.project.path}/.mcp.json` : "~/.claude.json")}</code>{entry?.scope === "local" && <small>沿用旧版项目条目，保留原有配置位置。</small>}</dd></div></dl>{entry && !busy && <button className="qc-link sc-other-project" onClick={() => { dispatch({ type: "other-project" }); patch({ picker: "projects" }); }}>接入其他项目<Icon name="arrowRight" size={13}/></button>}<fieldset disabled={busy} className="connect-support-grid"><TokenManager status={{ ...status, scope }} onRefresh={refresh} projectPath={projectPath}/><PermissionCard scope={scope} projectPath={projectPath} includeShellTools={ui.includeShell} setIncludeShellTools={includeShell => patch({ includeShell })} permissionCommand={buildPermissionGrantCommand(scope, projectPath, ui.includeShell)} permCopied={fb.isCopied("permission")} handlePermCopy={() => fb.copy("permission", buildPermissionGrantCommand(scope, projectPath, ui.includeShell))}/></fieldset></div></details>}
      </div>
    </ToolGuide>
    <SshConnectionDialog open={ui.adding} initial={null} connections={ui.servers} onClose={() => patch({ adding: false })} onSaved={() => { const servers = [...previewConnections]; const serverId = servers.slice(-1)[0]?.id ?? ui.serverId; patch({ servers, serverId, adding: false, picker: null }); dispatch({ type: "server", serverId, scenario }); }}/>
  </section>;
}
