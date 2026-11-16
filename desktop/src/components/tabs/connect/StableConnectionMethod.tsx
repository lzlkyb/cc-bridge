import { useId } from "react";
import type { StableConnectState } from "../../../hooks/useStableConnect";
import { stableSteps, stableProgressIndex, stableProgressLabels } from "../../../lib/stableConnect";
import { SshConnectionDialog } from "../SshConnectionDialog";
import { Icon } from "../../ui/icon";
import type { StaticStatus } from "../../../lib/types";
import { useCurrentConnection } from "../../../hooks/useCurrentConnection";
import { useServiceControl } from "../../../hooks/useServiceControl";
import "./stable-connect.css";

export function ConnectionMethodToggle({ state }: { state: StableConnectState }) {
  const current = useCurrentConnection();
  return <><div className="stable-method-heading"><h3>连接方式</h3><div className="stable-method-toggle" role="group" aria-label="连接方式">
    <button type="button" disabled={state.busy || state.ui.selecting || state.loading} aria-pressed={state.method === "stable"} onClick={() => void state.select("stable")}>隧道连接<span>推荐</span></button>
    <button type="button" disabled={state.busy || state.ui.selecting || state.loading} aria-pressed={state.method === "direct"} onClick={() => void state.select("direct")}>IP 直连</button>
  </div>{state.loading && <span className="text-xs text-muted-foreground" role="status">正在读取连接配置…</span>}</div>{current?.selectionPending && <p className="connection-selection-note" role="status"><Icon name="info" size={14}/>已选择{current.method === "stable" ? "隧道连接" : "IP 直连"}，完成接入后才会应用到服务器。</p>}</>;
}

export function StableConnectionMethod({ state, status, onNavigate, picking = false, hideRepair = false }: { state: StableConnectState; status?: StaticStatus; onNavigate?: (tab: string, anchor?: string) => void; picking?: boolean; hideRepair?: boolean }) {
  const id = useId();
  const { record, connection, ui, ready, busy, compact, reconnecting } = state;
  const needsSecret = !!record?.needsSecret;
  const phase = record?.phase ?? "idle";
  const summary = useCurrentConnection(status);
  const current = summary?.method === "stable" ? summary : undefined;
  const service = useServiceControl(status);
  const primary = () => {
    if (current?.state === "service-stopped") { void service.run("start"); return; }
    if (["service-error", "unsupported"].includes(current?.state ?? "")) { onNavigate?.("settings", "set-network"); return; }
    if (["changed", "login", "error", "recovery"].includes(current?.state ?? "")) { state.update({ managing: true }); return; }
    void state.start();
  };
  const issueText = record?.message?.split(/\r?\n|--- 输出 ---/)[0].trim() || "接入未完成";
  const activeStep = stableProgressIndex(record?.step ?? 0);
  const caption = current ? current.state === "waiting" ? "隧道已连通" : current.short : ready ? "隧道已连通" : phase === "ready" ? state.serviceRunning ? "配置待更新" : "本机服务已停止" : reconnecting ? "等待网络恢复" : phase === "error" ? needsSecret ? "需要重新登录" : "接入未完成" : "已暂停";
  return <section className="stable-method" aria-label="隧道连接设置" data-phase={phase} data-config-pending={phase === "ready" && !ready && state.serviceRunning} data-service-running={state.serviceRunning}>
    {compact ? <div className="stable-inline-status"><div><span className="stable-status-dot" data-tone={current?.tone}/><div aria-live="polite"><strong>{connection?.name ?? "服务器"} · {caption}</strong><p>{current ? current.state === "waiting" ? "VPN 重连，无需修改 MCP 地址" : current.detail : state.showNextStep ? "请重新打开服务器上的 Claude Code，加载新的接入配置" : ready ? "VPN 重连无需改地址" : reconnecting ? "网络恢复后自动重连，MCP 地址保持不变" : phase === "error" ? issueText : "固定地址和配置已保留，恢复隧道后继续"}</p></div></div>
      <div className="stable-inline-actions"><button type="button" className="stable-link" disabled={busy || service.busy} onClick={primary}>{current?.action ?? (ready ? "检查接入" : "恢复隧道")}</button><button type="button" className="stable-link" onClick={() => state.update({ managing: true })} aria-label="管理隧道连接">管理<Icon name="chevronDown" size={13}/></button></div>
    </div> : <>
      {picking && state.connections.length ? <div className="sc-picker-server"><Icon name="server" size={17}/><label htmlFor={`${id}-server`}>服务器</label><select id={`${id}-server`} disabled={busy || ui.selecting} value={state.selectedId} onChange={e => void state.select("stable", e.target.value)}>{state.connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><span>{connection?.username}@{connection?.host}</span><button type="button" className="stable-link" disabled={busy} onClick={() => state.update({ dialog: true, editing: false })}><Icon name="plus" size={13}/>添加服务器</button></div> : <div className="stable-layout">
        <div className="stable-intro"><span className="stable-network-icon"><Icon name="refresh" size={22}/></span><div><h4>VPN 重连，MCP 地址不变</h4><p>网络恢复后自动重连，无需重新配置 Claude Code。</p></div></div>
        <div className="stable-server-field"><div className="stable-server-heading"><label htmlFor={`${id}-server`}>{hideRepair ? "Claude Code 所在服务器" : "服务器"}</label><button type="button" className="stable-link" disabled={busy} onClick={() => state.update({ dialog: true, editing: false })}><Icon name="plus" size={13}/>添加服务器</button></div>
          {state.connections.length ? <><div className="stable-server-control"><Icon name="server" size={17}/><select id={`${id}-server`} aria-describedby={`${id}-server-address`} disabled={busy || ui.selecting} value={state.selectedId} onChange={e => void state.select("stable", e.target.value)}>{state.connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><Icon name="chevronDown" size={15}/></div><p className="stable-server-address" id={`${id}-server-address`}>{connection?.username}@{connection?.host}</p></> : <p className="stable-empty-connection">添加服务器后，即可一键接入。</p>}
        </div>
      </div>}
      {(record?.configured || record?.enabled) && !busy && <div className="stable-management-actions">{record.enabled && <button type="button" className="stable-link stable-stop" onClick={() => void state.stop()}>暂停当前隧道</button>}{record.configured && <button type="button" className="stable-link" onClick={() => state.update({ managing: false })}>收起<Icon name="chevronUp" size={13}/></button>}</div>}
      {busy && <div className="stable-inline-progress"><ol className="stable-progress-steps" aria-label="接入进度">{stableProgressLabels.map((label, index) => <li key={label} data-state={index < activeStep ? "done" : index === activeStep ? "current" : "waiting"} aria-current={index === activeStep ? "step" : undefined}><span className="stable-progress-mark">{index < activeStep ? <Icon name="check" size={12}/> : index + 1}</span><span>{label}</span></li>)}</ol><p role="status"><Icon name="spinner" size={14} className="animate-spin"/>{stableSteps[Math.min(record?.step ?? 0, 4)]}…</p></div>}
    </>}
    {!state.enabled && !state.loading && <p className="stable-validation">请先在设置中开启 SSH。{onNavigate && <button type="button" className="stable-link" onClick={() => onNavigate("settings")}>前往设置</button>}</p>}
    {phase === "error" && !compact && !hideRepair && <div className="stable-inline-repair" role="alert"><b>{needsSecret ? "请输入服务器密码或密钥口令" : issueText}</b><p>{needsSecret ? "填写后点击「继续接入」。登录信息仅用于本次应用运行期间的连接与重连。" : "处理上述原因后，点击「重新检测」继续。"}</p>{needsSecret && <form onSubmit={e => { e.preventDefault(); void state.start(); }}><input aria-label={connection?.authType === "key" ? "密钥口令" : "服务器登录密码"} type="password" autoComplete="off" value={(connection?.authType === "key" ? ui.credentials.passphrase : ui.credentials.password) ?? ""} onChange={e => state.update({ credentials: connection?.authType === "key" ? { passphrase: e.target.value } : { password: e.target.value } })} placeholder={connection?.authType === "key" ? "输入密钥口令" : "输入服务器登录密码"}/></form>}{record?.message && record.message.trim() !== issueText && <details className="stable-error-details"><summary>查看错误详情</summary><pre>{record.message}</pre></details>}</div>}
    {record?.configured && ui.managing && !hideRepair && <p className="stable-fixed-address">固定接入地址 <code>http://127.0.0.1:{record.port}/mcp</code><span>网络恢复后复用此地址</span></p>}
    {phase === "error" && !compact && !hideRepair && connection && <button type="button" className="stable-link" onClick={() => state.update({ dialog: true, editing: true })}>编辑登录信息</button>}
    {state.error && !hideRepair && <button type="button" className="stable-link" onClick={state.retry}>重新读取连接状态</button>}
    <SshConnectionDialog open={ui.dialog} initial={ui.editing ? connection ?? null : null} connections={state.connections} onClose={() => state.update({ dialog: false })} onSaved={(server, credentials) => void state.saved(server, credentials)}/>
  </section>;
}
