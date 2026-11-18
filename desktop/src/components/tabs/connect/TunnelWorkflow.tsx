import { useEffect, useId, useRef, useState } from "react";
import type { StableConnectState } from "../../../hooks/useStableConnect";
import type { StaticStatus } from "../../../lib/types";
import { useStableAccess } from "../../../hooks/useStableAccess";
import { useCurrentConnection } from "../../../hooks/useCurrentConnection";
import { useServiceControl } from "../../../hooks/useServiceControl";
import { CurrentAccessAddress } from "./CurrentAccessAddress";
import { StableAccessSettings } from "./StableAccessSettings";
import { StableConnectionTargets } from "./StableConnectionTargets";
import { StableLogin } from "./StableLogin";
import { StableProjectPicker } from "./StableProjectPicker";
import { StableScopeSelector } from "./StableScopeSelector";
import { StableManualFix } from "./StableManualFix";
import { SshConnectionDialog } from "../SshConnectionDialog";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { stableProgressIndex, stableProgressLabels, stableSteps } from "../../../lib/stableConnect";
import { stableConfirmedPort, stableFixedUrl, stableProjectName, stableScopeLabel, type StableProject } from "../../../lib/stableAccess";
import "./stable-access.css";
import "./tunnel-flow.css";

const stepNames = ["服务器", "接入目标", "应用配置", "验证"];
type Page = 1 | 2 | 3 | 4 | "daily";
type Flow = "first" | "migration" | "repair" | "scope" | "another";
const initialControls = { details: false, pause: false, cancelled: false, loginOpen: false, projectChoice: undefined as StableProject | undefined };

export function TunnelWorkflow({ state, status, onRefresh, tlsEnabled, onNavigate }: {
  state: StableConnectState; status?: StaticStatus; onRefresh: () => void; tlsEnabled: boolean;
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const [page, setPage] = useState<Page>();
  const [flowOverride, setFlow] = useState<Flow>();
  const [verified, setVerified] = useState("");
  const [controls, setControls] = useState(initialControls);
  const { details, pause, cancelled, loginOpen, projectChoice } = controls;
  const updateControls = (patch: Partial<typeof controls>) => setControls(previous => ({ ...previous, ...patch }));
  const chooseProject = (projectChoice?: StableProject) => updateControls({ projectChoice });
  const heading = useRef<HTMLHeadingElement>(null);
  const serverField = useId();
  const cardTitle = useId();
  const fromDirect = state.ui.fromDirect;
  const flow = flowOverride ?? (fromDirect ? "migration" : "first");
  const active = page ?? (state.record?.configured && state.selectedConnectionId && state.connection ? "daily" : flow === "migration" && state.selectedConnectionId && state.connection ? 2 : 1);
  const supported = !tlsEnabled && (status?.transport ?? "http") === "http";
  const access = useStableAccess(state, status, active !== 1 && !!state.selectedConnectionId && supported && state.enabled, tlsEnabled);
  const current = useCurrentConnection(status);
  const service = useServiceControl(status, onRefresh);
  const target = state.record?.target;
  const projectPath = target?.projectPath ?? state.record?.projectPath;
  const receipt = JSON.stringify([state.selectedId, target?.id, target?.fingerprint, target?.url, state.record?.scope, state.record?.projectPath, status?.token]);
  const used = verified === receipt && state.ready;
  // 端口只认「已写进服务器配置」或「已走到应用配置步」的证据，不用本机服务端口顶替。
  const confirmedPort = stableConfirmedPort(state.record);
  const address = confirmedPort ? stableFixedUrl(confirmedPort) : "";
  const observedTarget = access.result?.targets.find(item => item.id === target?.id);
  const remoteTarget = observedTarget ?? target;
  const missingTarget = !!target && !!access.result?.complete && !observedTarget && access.result.files.some(file => file.configFile === target.configFile);
  const addressDrift = !!(address && remoteTarget?.url && remoteTarget.url !== address);
  const repairNeeded = addressDrift || missingTarget || remoteTarget?.tokenMatches === false || state.record?.configMatches === false || current?.state === "changed";
  const authNeeded = access.needsSecret || (state.record?.needsSecret && !access.loginVerified);
  const applying = state.busy;
  const at = stableProgressIndex(state.record?.step ?? 0);
  const issue = access.message || state.error || (state.record?.phase === "error" ? state.record.message : "");
  const setStep = (next: Page) => { setPage(next); updateControls({ details: false, pause: false, loginOpen: false, projectChoice: undefined }); };
  useEffect(() => { if (page !== undefined) heading.current?.focus({ preventScroll: true }); }, [page]);
  const needsShortReview = active === 2 && !cancelled && !access.picking && !!access.target && !!access.setup && !authNeeded
    && (flow === "migration" || flow === "repair" || flow === "first" && !state.record?.configured);
  useEffect(() => {
    if (!needsShortReview) return;
    if (flow === "first") setFlow("migration");
    setPage(3);
  }, [needsShortReview, flow]);
  const firstStep = () => { access.cancelScope(); updateControls({ cancelled: false }); setFlow("first"); setStep(1); };
  const beginScope = () => { setFlow("scope"); setStep(2); access.openScope(); };
  const beginRepair = () => {
    updateControls({ cancelled: false });
    setFlow("repair"); setStep(2);
    state.update({ managing: true, verify: false });
    access.inspectOriginal();
  };
  const checkServer = async () => {
    if (!state.connections.length) { state.update({ dialog: true, editing: false }); return; }
    if (!state.connection) return;
    if (state.record?.configured && state.selectedConnectionId === state.selectedId) { setStep("daily"); return; }
    if (state.selectedConnectionId !== state.selectedId && !await state.select("stable", state.selectedId)) return;
    setStep(2);
  };
  const leaveShortcut = () => {
    if (flow === "migration" && fromDirect) { void state.select("direct"); return; }
    if (state.record?.configured) { access.cancelScope(); updateControls({ cancelled: false }); setStep("daily"); return; }
    firstStep();
  };
  const apply = async () => {
    if (!access.setup || flow === "repair" && (!access.target || !!target && target.id !== access.target.id)) return;
    updateControls({ cancelled: false });
    if (await access.apply()) setStep(4);
  };
  const cancelApply = () => {
    if ((state.record?.step ?? 0) >= 3) updateControls({ cancelled: true });
    state.automation.onCancel();
  };
  const title = (name: string, hint?: string) => <div className="tunnel-flow-title">
    <h3 id={cardTitle} tabIndex={-1} ref={heading}>{name}</h3>
    {hint && <p>{hint}</p>}
  </div>;
  const note = (text: string) => <p className="tunnel-flow-note" role="status"><Icon name="info" size={15}/>{text}</p>;
  const terminalButton = onNavigate && <Button onClick={() => onNavigate("terminal")}><Icon name="terminal" size={16}/>前往终端</Button>;
  const settingsButton = onNavigate && <Button onClick={() => onNavigate(state.enabled ? "settings" : "terminal", state.enabled ? "set-network" : undefined)}><Icon name={state.enabled ? "settings" : "terminal"} size={15}/>{state.enabled ? "查看网络设置" : "前往终端启用 SSH"}</Button>;
  const changeFile = access.result?.files.find(file => file.scope === access.scope && file.projectPath === (access.setup?.projectPath ?? ""))?.configFile
    ?? (access.scope === "user" ? "~/.claude.json" : access.project?.path ? `${access.project.path}/.mcp.json` : "由所选接入确定");
  const actualFile = access.scopeEditing ? changeFile : access.target?.configFile ?? changeFile;
  const applyLabel = access.scopeEditing ? "应用范围更改" : flow === "repair" ? "更新现有接入" : access.target ? "切换到隧道" : "创建隧道接入";
  // 与后端真正写进配置的条目名同源：多设备时是 `cc-bridge-<deviceId>`，
  // 草稿里 setup 还没生成时要退回已保存的 multiDevice，否则会在核对页显示成 `cc-bridge`。
  const multiDeviceEntry = access.setup?.multiDevice ?? state.record?.multiDevice ?? false;
  const entryName = multiDeviceEntry && status?.deviceId ? `cc-bridge-${status.deviceId}` : "cc-bridge";
  const retry = flow === "repair" ? access.inspectOriginal : access.retry;
  const inspectAgain = () => { updateControls({ cancelled: false }); retry(); setStep(2); };
  const chooseAnotherProject = () => {
    setFlow("another"); setStep(2); access.openProjects();
    if (!access.result && !access.checking) access.observe();
  };
  const resume = () => void state.start().then(success => { if (success) updateControls({ loginOpen: false }); });
  const checkAccess = async () => { if (await state.start()) { setFlow("repair"); setStep(4); } };

  if (state.loading) return <p className="tunnel-flow-note" role="status">正在读取隧道接入状态…</p>;
  return <section className="tunnel-flow" data-page={active} aria-labelledby={cardTitle}>
    {active !== "daily" && (!state.record?.configured || active === 4) && flow === "first" && <ol className="tunnel-flow-steps" aria-label="隧道接入步骤">
      {stepNames.map((name, index) => <li key={name} aria-current={active === index + 1 ? "step" : undefined} data-complete={active > index + 1}>
        <span>{active > index + 1 ? <Icon name="check" size={13}/> : index + 1}</span>{name}
      </li>)}
    </ol>}

    <div className="tunnel-flow-body">
    {active === 1 && <>
      {title("选择 Claude Code 所在服务器", "检查服务器上的已有接入和最近项目。")}
      <div className="tunnel-flow-server">
        {!!state.connections.length && <div className="stable-server-field"><label htmlFor={serverField}>已保存的服务器</label><div className="stable-server-control">
          <Icon name="server" size={17}/><select id={serverField} value={state.selectedId} disabled={state.ui.selecting} onChange={event => void state.select("stable", event.target.value)}>{state.connections.map(server => <option key={server.id} value={server.id}>{server.name || server.host}</option>)}</select><Icon name="chevronDown" size={15}/>
        </div><p className="stable-server-address">{state.connection?.username}@{state.connection?.host}</p></div>}
        {state.connections.length ? <Button variant="outline" disabled={state.busy || !state.enabled} onClick={() => state.update({ dialog: true, editing: false })}><Icon name="plus" size={16}/>添加服务器</Button> : note("添加 SSH 连接后即可继续。")}
      </div>
      {state.error && note(state.error)}
    </>}

    {active === 2 && <>
      {title(access.picker === "projects" ? "选择项目文件夹" : access.scopeEditing ? "选择新的使用范围" : flow === "repair" ? "检查原有接入" : flow === "migration" ? "检查服务器上的原有接入" : "选择 Claude Code 接入目标",
        access.picker === "projects" ? `${state.connection?.name ?? ""} · 选择服务器上的项目文件夹。` :
          access.scopeEditing ? "沿用原名称和固定地址，将条目移到新的使用范围。" : state.connection?.name)}
      {access.checking && note("正在检查服务器上的接入…")}
      {authNeeded && !access.checking && <StableLogin state={state} onSubmit={retry}/>}
      {access.failed && !authNeeded && <div className="tunnel-flow-stack">{note(issue || "检查结果不完整。")}{!access.picking && <div className="tunnel-flow-inline"><Button onClick={retry}><Icon name="refresh" size={15}/>重新检查</Button>{flow !== "repair" && <Button variant="outline" onClick={access.openProjects}><Icon name="folder" size={15}/>检查指定项目</Button>}</div>}</div>}
      {access.picker === "entries" && !access.failed && <StableConnectionTargets entries={access.result?.targets ?? []} onChoose={access.chooseTarget} onOtherProject={flow === "repair" ? undefined : access.openProjects} onClose={access.target ? access.closePicker : undefined}/>}
      {access.picker === "projects" && <StableProjectPicker key={state.selectedId} state={state} status={status} discovery={access.result} onChoose={project => { chooseProject(undefined); access.chooseProject(project); }} onClose={access.closePicker} recentSelection={{ path: projectChoice?.path, select: chooseProject }}/>}
      {!access.picking && !access.checking && !access.failed && access.result?.complete && <>
        {flow === "migration" && !access.target ? note("此服务器未找到已有 Claude Code 接入。请选择原接入所在服务器，或继续首次配置。") :
          ((flow === "first" || flow === "another") && !access.target || access.scopeEditing) && <StableScopeSelector access={access} busy={state.busy}/>}
        {flow === "repair" && !access.target && note("没有认出原条目。请核对服务器和配置文件，确认目标后再更新。")}
        {access.target && !access.scopeEditing && flow !== "repair" && <div className="tunnel-flow-box tunnel-flow-summary-row"><div><strong>{access.target.name} · {stableScopeLabel(access.target.scope)}</strong><p>{access.target.projectPath || "服务器上的所有项目"}</p><code>{access.target.url}</code></div><Button variant="outline" onClick={access.openTargets}><Icon name="folder" size={15}/>更换接入</Button></div>}
      </>}
      {flow === "first" && access.scope === "user" && !access.target && !access.failed && !access.picking && access.result?.complete &&
        <StableAccessSettings state={state} access={access} status={status} onRefresh={onRefresh}/>}
    </>}

    {active === 3 && <>
      {title(applying ? "正在应用配置" : flow === "migration" ? "将原有接入切换到隧道" : flow === "repair" ? "更新原有接入" : "核对隧道接入配置",
        applying ? stableSteps[Math.min(state.record?.step ?? 0, 4)] : flow === "migration" || flow === "repair" ?
          "沿用原服务器、条目名称、项目与配置位置。确认后更新接入地址或所需凭据。" : flow === "another" ?
            "完成后接入卡管理所选项目，服务器上的原条目会保留。" : "核对实际要改动的服务器、条目与配置位置。")}
      {applying ? <ol className="tunnel-flow-progress" aria-label="应用进度">{stableProgressLabels.map((name, index) => <li key={name} data-complete={index < at}><Icon name={index < at ? "check" : index === at ? "spinner" : "clock"} size={16} className={index === at ? "animate-spin" : undefined}/><span>{name}</span><small>{index < at ? "已完成" : index === at ? "进行中" : "等待中"}</small></li>)}</ol> :
        <dl className="tunnel-flow-data">
          <div><dt>服务器</dt><dd>{state.connection?.name}</dd></div><div><dt>接入名称</dt><dd><code>{access.target?.name ?? entryName}</code></dd></div>
          <div><dt>使用范围</dt><dd>{stableScopeLabel(access.target && !access.scopeEditing ? access.target.scope : access.scope)} {access.setup?.projectPath && <code>{access.setup.projectPath}</code>}</dd></div>
          {access.scopeEditing && <div><dt>原配置位置</dt><dd><code>{access.target?.configFile}</code></dd></div>}
          <div><dt>{access.scopeEditing ? "新配置位置" : "配置位置"}</dt><dd><code>{actualFile}</code></dd></div>
          {access.target && !access.scopeEditing && <div><dt>原接入地址</dt><dd><code>{access.target.url}</code></dd></div>}
          <div><dt>固定地址</dt><dd>{address ? <code>{address}</code> : "服务器监听成功后显示"}</dd></div>
        </dl>}
      {!applying && cancelled && note("本次配置已取消。请重新检查服务器配置后再应用。")}
      {!applying && !cancelled && issue && note(issue)}
      {!applying && access.target?.tokenMatches === false && note("服务器上的 Token 与本机不同，本次会一并更新。")}
      {!applying && !access.scopeEditing && confirmedPort && (access.target ?? target) && <StableManualFix tunnelPort={confirmedPort} directUrl={(access.target ?? target)?.url}/>}
    </>}

    {active === 4 && <>
      {title("在 Claude Code 中验证", state.ready && !repairNeeded ? "隧道已连通，配置已写入。" : "请先确认隧道状态，再在 Claude Code 中验证。")}
      <CurrentAccessAddress status={status}/>
      <ol className="tunnel-flow-verify-list">
        <li>在{state.connection?.name ? `「${state.connection.name}」` : "所选服务器"}{projectPath ? `的「${stableProjectName(projectPath)}」项目` : ""}重新打开 Claude Code。{projectPath && <code> {projectPath}</code>}</li>
        <li>输入 <code>/mcp</code>，确认 <code>{target?.name ?? "cc-bridge"}</code> 显示已连接。</li>
      </ol>
    </>}

    {active === "daily" && <>
      {title(addressDrift ? "服务器上的接入地址需要更新" : missingTarget ? "原有接入需要核对" : current?.short === "接入待验证" && used ? "隧道已连通" : current?.title || "隧道连接",
        addressDrift ? "将原条目的地址恢复为此隧道的固定地址。" : missingTarget ? "在原配置文件中未找到此条目。" : used ? "你已确认 Claude Code 接入。" : current?.detail)}
      {state.connection && <div className="tunnel-flow-box tunnel-flow-summary-row"><div><strong>{state.connection.name}</strong><p className="tunnel-flow-scope">生效范围 · {stableScopeLabel(target?.scope ?? state.record?.scope ?? "project")}{projectPath && <> · {stableProjectName(projectPath)} <code>{projectPath}</code></>}</p></div></div>}
      <CurrentAccessAddress status={status}/>
      {addressDrift && note(`服务器当前配置为 ${remoteTarget?.url}，应使用固定地址 ${address}。`)}
      {addressDrift && confirmedPort && <StableManualFix tunnelPort={confirmedPort} directUrl={remoteTarget?.url}/>}
      {access.checking && note("正在核对服务器上的接入…")}
      {access.failed && !authNeeded && <div className="tunnel-flow-inline">{note("暂时没能核对服务器上的接入，当前显示的是上次记录的配置。")}<Button variant="outline" onClick={access.observe}><Icon name="refresh" size={15}/>重新检查</Button></div>}
      {loginOpen && authNeeded && <StableLogin state={state} busy={state.busy || access.checking} onSubmit={state.record?.needsSecret ? resume : access.observe}/>}
      {details && note(state.record?.message || "正在按原固定端口重试，网络恢复后会更新连接状态。")}
      {state.error && note(state.error)}
      {state.record?.phase === "error" && !authNeeded && !state.error && state.record.message && note(state.record.message)}
      {pause && <div className="tunnel-flow-box"><p>暂停后，这台服务器的 Claude Code 将暂时无法通过此隧道接入。</p><div className="tunnel-flow-inline"><Button variant="destructive" size="sm" onClick={() => { void state.stop(); updateControls({ pause: false }); }}>确认暂停</Button><Button variant="outline" size="sm" onClick={() => updateControls({ pause: false })}>取消</Button></div></div>}
      <StableAccessSettings state={state} access={{ ...access, openProjects: chooseAnotherProject }} status={status} onRefresh={onRefresh} onStableUpdate={beginRepair}/>
    </>}
    {!state.enabled && note("请先在终端页启用 SSH。")}
    {!supported && note(tlsEnabled ? "当前已启用 HTTPS，隧道接入需要使用 HTTP。" : "隧道接入需要使用 HTTP，当前服务使用 SSE。")}
    {state.error && <Button variant="outline" size="sm" onClick={state.retry}><Icon name="refresh" size={15}/>重新读取连接状态</Button>}
    </div>

    <div className="tunnel-flow-footer">
      <div className="tunnel-flow-inline">
        {active === 2 && <Button variant="ghost" onClick={access.picking && access.picker === "projects" ? () => { chooseProject(undefined); access.closePicker(); } : flow !== "first" ? leaveShortcut : firstStep}><Icon name="arrowLeft" size={15}/>{access.picker === "projects" ? "返回接入目标" : flow === "migration" && fromDirect ? "返回 IP 直连" : flow !== "first" ? "取消" : "上一步"}</Button>}
        {active === 3 && !applying && <Button variant="ghost" onClick={flow === "repair" || flow === "migration" ? leaveShortcut : () => setStep(2)}><Icon name="arrowLeft" size={15}/>{flow === "repair" || flow === "migration" ? "取消" : "上一步"}</Button>}
        {active === 4 && <Button variant="ghost" onClick={() => setStep("daily")}>稍后验证</Button>}
        {active === "daily" && <details className="tunnel-flow-more"><summary>更多操作 <Icon name="chevronDown" size={14}/></summary><div className="tunnel-flow-inline"><Button variant="outline" size="sm" disabled={state.busy} onClick={firstStep}>切换服务器</Button><Button variant="outline" size="sm" disabled={state.busy} onClick={() => state.update({ dialog: true, editing: true })}>编辑登录信息</Button>{state.record?.enabled && <Button size="sm" variant="outline" disabled={state.busy} onClick={() => updateControls({pause:true})}>暂停隧道</Button>}</div></details>}
      </div>
      <div className="tunnel-flow-inline tunnel-flow-next">
        {active === 1 && ((!state.enabled || !supported) && settingsButton ? settingsButton : <Button disabled={state.ui.selecting || state.busy || !state.enabled || !supported || state.connections.length > 0 && !state.connection} onClick={() => void checkServer()}><Icon name={state.record?.configured ? "arrowLeft" : state.connections.length ? "search" : "plus"} size={16}/>{state.record?.configured ? "返回当前接入" : state.connections.length ? "检查此服务器" : "添加服务器"}</Button>)}
        {active === 2 && access.picker === "projects" && <Button className="tunnel-flow-select-project" disabled={!projectChoice} onClick={() => { if (projectChoice) access.chooseProject(projectChoice); chooseProject(undefined); }}><Icon name="check" size={15}/>使用所选项目</Button>}
        {active === 2 && (supported && state.enabled ? !access.picking && !access.failed && !authNeeded && (flow === "first" || flow === "scope" || flow === "another") && <Button disabled={!access.setup || access.scopeEditing && !access.scopeChanged} isLoading={access.checking} loadingText="正在检查…" onClick={() => setStep(3)}>核对接入配置<Icon name="arrowRight" size={16}/></Button> : settingsButton)}
        {active === 2 && flow === "migration" && !access.picking && !access.checking && !access.target && access.result?.complete && <>
          <Button variant="outline" onClick={() => setStep(1)}>更换服务器</Button><Button onClick={() => { setFlow("first"); setStep(2); }}>继续首次配置</Button>
        </>}
        {active === 3 && (applying ? <Button variant="outline" disabled={state.automation.cancelDisabled} onClick={cancelApply}>{state.ui.cancelling ? "正在取消…" : "取消本次配置"}</Button> :
          cancelled ? <Button onClick={inspectAgain}>重新检查服务器配置</Button> :
            (!supported || !state.enabled) && settingsButton ? settingsButton :
            !status?.running ? <Button isLoading={service.busy} onClick={() => void service.run("start")}>启动本机服务</Button> :
            <>{flow === "migration" && access.result && access.result.targets.length > 1 && <Button variant="outline" onClick={() => { access.openTargets(); setStep(2); }}>更换接入</Button>}{authNeeded ? <Button onClick={inspectAgain}><Icon name="key" size={15}/>重新登录</Button> :
              <Button disabled={!access.setup || !supported || !state.enabled || flow === "repair" && (!access.target || !!target && target.id !== access.target.id)} onClick={() => void apply()}><Icon name="plug" size={16}/>{applyLabel}</Button>}</>)}
        {active === 4 && <><Button variant="outline" disabled={!state.ready || repairNeeded} onClick={() => { setVerified(receipt); setStep("daily"); }}><Icon name="check" size={15}/>我已在 Claude Code 验证</Button>{terminalButton}</>}
        {active === "daily" && <>
          {!!target && <Button variant="outline" disabled={!state.ready || state.reconnecting || repairNeeded} onClick={beginScope}><Icon name="sliders" size={15}/>更改范围</Button>}
          {!state.enabled || !supported ? settingsButton :
            !status?.running ? <Button isLoading={service.busy} onClick={() => void service.run("start")}>启动本机服务</Button> :
            authNeeded ? !loginOpen && <Button onClick={() => updateControls({ loginOpen: true })}><Icon name="key" size={15}/>重新登录</Button> :
              state.reconnecting ? <Button onClick={() => updateControls({ details: !details })}><Icon name="refresh" size={15}/>{details ? "收起重连详情" : "查看重连详情"}</Button> :
                repairNeeded ? <Button onClick={beginRepair}><Icon name="refresh" size={15}/>{addressDrift ? "更新原接入地址" : "核对并更新配置"}</Button> :
                  state.record?.phase === "stopped" || state.record?.phase === "error" || state.busy ? <Button isLoading={state.busy} loadingText="正在恢复…" onClick={resume}>{state.record?.phase === "stopped" ? "恢复隧道" : "重试连接"}</Button> :
                    used ? terminalButton : <><Button variant="outline" disabled={!state.ready || access.checking} onClick={() => void checkAccess()}><Icon name="refresh" size={15}/>检查接入</Button><Button disabled={!state.ready} onClick={() => { setFlow("repair"); setStep(4); }}>查看验证步骤<Icon name="arrowRight" size={15}/></Button></>}
        </>}
      </div>
    </div>
    <SshConnectionDialog open={state.ui.dialog} initial={state.ui.editing ? state.connection ?? null : null} connections={state.connections} onClose={() => state.update({dialog:false})} onSaved={(server, creds) => void state.saved(server, creds)}/>
  </section>;
}
