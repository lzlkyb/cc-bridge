import { useEffect, useId, useRef } from "react";
import type { StaticStatus } from "../../../lib/types";
import type { StableConnectState } from "../../../hooks/useStableConnect";
import type { StableAccessState } from "../../../hooks/useStableAccess";
import { stableFixedUrl, stableScopeLabel, stableTargetTitle } from "../../../lib/stableAccess";
import { useCurrentConnection } from "../../../hooks/useCurrentConnection";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { StableAccessSettings } from "./StableAccessSettings";
import { StableProjectPicker } from "./StableProjectPicker";
import { StableConnectionTargets } from "./StableConnectionTargets";
import { StableLogin } from "./StableLogin";
import { StableScopeSelector } from "./StableScopeSelector";
import "./stable-access.css";

export function StableAccessGuide({ state, access, status, onRefresh, tlsEnabled = false }: {
  state: StableConnectState; access: StableAccessState; status?: StaticStatus; onRefresh: () => void; tlsEnabled?: boolean;
}) {
  const id = useId();
  const region = useRef<HTMLDivElement>(null);
  const current = useCurrentConnection(status);
  const { target, checking, picking, failed, result } = access;
  const supported = !tlsEnabled && (status?.transport ?? "http") === "http";
  const confirmedPort = state.record?.configured || (state.record?.step ?? 0) >= 3 ? state.record?.port : undefined;
  const address = confirmedPort ? stableFixedUrl(confirmedPort) : "";
  const configuredTarget = state.record?.target;
  const configuredScope = configuredTarget?.scope ?? state.record?.scope ?? "project";
  const configuredPath = configuredTarget?.projectPath ?? state.record?.projectPath;
  const unchanged = !access.scopeChanged && state.ready && !!target && configuredTarget?.id === target.id && target.url === address && target.tokenMatches;
  const label = access.scopeEditing ? "应用范围更改" : unchanged ? "已使用隧道连接" : state.record?.configured && configuredTarget?.id === target?.id ? "应用接入配置" : target ? "改用隧道连接" : "一键接入";
  const needsSecret = access.needsSecret || state.record?.needsSecret && !access.loginVerified;
  const issue = access.message || state.error || (state.record?.phase === "error" && (!state.record.needsSecret || needsSecret) ? state.record.message ?? "接入未完成，请重新检查。" : "");
  useEffect(() => {
    if (!picking) return;
    const frame = requestAnimationFrame(() => region.current?.querySelector(".sc-picker")?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [picking, access.picker]);
  const nextStep = state.showNextStep && <div className="connect-next-step" role="status"><Icon name="check" size={20}/><div><strong>隧道连接配置完成</strong><p>请重新打开服务器上的 Claude Code。{state.record?.scope === "project" && `在「${state.record.target ? stableTargetTitle(state.record.target) : state.record.projectPath}」项目中打开即可。`}</p></div><button type="button" className="stable-link sc-muted-link" onClick={() => state.update({ nextStepConnectionId: "" })}>知道了</button></div>;
  return <div ref={region} className="sc-flow sc-guide" aria-label="隧道连接接入流程">
    {state.compact ? <>
      {nextStep}
      {!state.showNextStep && current?.channelReady && <p className="connection-client-wait" role="status"><Icon name="clock" size={14}/>当前客户端待验证：重新打开服务器上的 Claude Code，用 /mcp 查看接入。</p>}
      <div className="sc-scope-summary"><span>生效范围</span><strong>{stableScopeLabel(configuredScope)}{configuredScope !== "user" && configuredPath && ` · ${configuredTarget ? stableTargetTitle(configuredTarget) : configuredPath}`}</strong><button type="button" className="stable-link" disabled={state.busy || state.loading} onClick={access.openScope}>更改范围<Icon name="chevronDown" size={13}/></button></div>
      {!state.ready && !state.reconnecting && <div className="sc-action-row"><p>{state.record?.configMatches ? "固定地址和配置已保留，恢复连接即可继续。" : "本机接入配置有变化，请检查并更新原有接入。"}</p><Button size="sm" disabled={!status?.running || state.busy} onClick={() => state.record?.configMatches ? void state.start() : state.update({ managing: true })}>{state.record?.configMatches ? "重新接入" : "检查并更新配置"}</Button></div>}
    </> : <>
      {checking ? <div className="sc-checking" role="status"><Icon name="spinner" size={17} className="animate-spin"/><div><strong>正在检查服务器上的接入…</strong><p>{access.scopeEditing ? "检查原接入和新范围的配置，稍等片刻。" : access.scoped && access.project ? `只检查你选择的项目：${access.project.path}` : "检查已有配置和最近使用的项目，稍等片刻。"}</p></div></div> : failed && !picking ? <div className="sc-check-failed" role="alert"><Icon name="info" size={18}/><div><strong>{needsSecret ? "需要登录服务器后检查" : "暂时没读到完整的接入配置"}</strong><p>{issue || "可以重新检查，或选择一个项目后再检查。"}</p>{needsSecret ? <StableLogin state={state} onSubmit={access.retry} busy={checking}/> : <div><button type="button" className="stable-link" onClick={access.retry}><Icon name="refresh" size={13}/>重新检查</button><button type="button" className="stable-link" onClick={access.openProjects}>选择一个项目再检查<Icon name="arrowRight" size={13}/></button></div>}</div></div> : !picking && result?.complete && <div className="sc-target-summary" aria-live="polite"><span className={`sc-target-mark ${target ? "sc-found" : ""}`}><Icon name={target ? "check" : "plug"} size={17}/></span><div><h3>{access.scopeEditing && target ? `更改「${stableTargetTitle(target)}」的使用范围` : target ? `已找到「${stableTargetTitle(target)}」的原有接入` : access.scoped ? "这个项目还没有接入桥" : "这台服务器还没有接入桥"}</h3><p>{access.scopeEditing ? "先选择新的范围，点击应用后迁移原接入。" : target ? "改用隧道连接，沿用原来的接入名称和生效范围。" : "完成一次配置，就可以在服务器上的 Claude Code 使用。"}</p>{target && <div className="sc-target-meta"><span>{stableScopeLabel(target.scope)}</span><code>{target.name}</code>{target.projectPath && <span className="sc-project-path">{target.projectPath}</span>}{!access.scopeEditing && <button type="button" className="stable-link" disabled={state.busy} onClick={access.openScope}>更改范围</button>}</div>}</div>{target && !access.scopeEditing && <button type="button" className="stable-link sc-target-change" disabled={state.busy} onClick={access.openTargets}>更换接入<Icon name="chevronDown" size={13}/></button>}</div>}
      {access.picker === "entries" && <StableConnectionTargets entries={result?.targets ?? []} onChoose={access.chooseTarget} onOtherProject={access.openProjects} onClose={target ? access.closePicker : undefined}/>}
      {result?.complete && (!target || access.scopeEditing) && !picking && !checking && <StableScopeSelector access={access} busy={state.busy}/>}
      {access.picker === "projects" && <StableProjectPicker key={state.selectedId} state={state} status={status} discovery={result} onChoose={access.chooseProject} onClose={access.closePicker}/>}
      {access.setup && !picking && (access.scopeEditing && target?.url === address && target?.tokenMatches ? <div className="sc-completed-address"><span>固定接入地址不变</span><code>{address}</code></div> : <section className="sc-address-change" aria-labelledby={id}><div className="sc-address-heading"><h3 id={id}>{target ? "将原有接入改为固定地址" : "固定接入地址"}</h3></div><div className="sc-addresses"><div><span>{target ? "原接入地址" : "首次接入"}</span>{target ? <code>{target.url}</code> : <p>还没有配置接入地址</p>}</div><Icon name="arrowRight" size={18}/><div><span>固定接入地址</span>{address ? <code>{address}</code> : <p>配置时自动确认，完成后显示</p>}</div></div><p className="sc-address-note">固定地址保存在服务器上，VPN 断开并恢复后继续使用。</p>{target && !target.tokenMatches && <p className="sc-token-note"><Icon name="key" size={14}/>原 Token 与本机不同，本次会一并更新。</p>}</section>)}
      {!!issue && !failed && !checking && !picking && <div className="stable-inline-repair" role="alert"><b>{issue}</b>{needsSecret ? <StableLogin state={state} onSubmit={access.retry} busy={state.busy}/> : <button type="button" className="stable-link" onClick={access.retry}>重新检查接入</button>}</div>}
      {!picking && <div className="sc-action-row"><p>{checking ? "检查完成后即可继续。" : failed ? "读取成功后才能继续配置。" : access.scopeEditing ? access.scopeChanged ? "应用后使用新的范围" : "当前范围未更改" : target ? `升级「${stableTargetTitle(target)}」的原有接入` : access.scope === "project" ? access.project ? `将接入「${access.project.name}」` : "选择项目后即可继续。" : "将接入所有项目"}</p><div className="stable-command-actions">{access.scopeEditing && !state.busy && <Button size="sm" variant="outline" onClick={access.cancelScope}>取消更改</Button>}{state.busy && <Button size="sm" variant="outline" disabled={state.automation.cancelDisabled} onClick={state.automation.onCancel}>{state.ui.cancelling ? "正在取消…" : "取消"}</Button>}<Button size="sm" disabled={!access.setup || !status?.running || state.busy || state.loading || !state.enabled || !supported || !!needsSecret || unchanged || access.scopeEditing && !access.scopeChanged} isLoading={state.busy} loadingText={state.automation.label} onClick={access.apply}><Icon name="plug" size={14}/>{checking ? "检查后继续" : label}</Button></div></div>}
    </>}
    {!status?.running && <p className="sc-service-note" role="alert">本机服务已停止，请先在顶栏启动服务。</p>}
    {!supported && <p className="sc-service-note" role="alert">{tlsEnabled ? "当前已启用 HTTPS，隧道连接暂不支持自动配置证书信任。" : "隧道连接的自动接入需要 HTTP 协议。"}请使用现有 IP 直连接入步骤，或在设置中调整后继续。</p>}
    {!picking && !access.scopeEditing && <StableAccessSettings state={state} access={access} status={status} onRefresh={onRefresh}/>}
  </div>;
}
