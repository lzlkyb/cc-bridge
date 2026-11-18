import { useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { matchesRunning, sameForward, stableRuntimeId, useTunnelStatus } from "../../lib/sshTunnelStore";
import type { ForwardKind, ForwardRule, SshConnection } from "../../lib/types";
import { ForwardSection } from "./ForwardSection";
import { ForwardEditor } from "./ForwardEditor";
import { ForwardRuleRow } from "./ForwardRuleRow";
import { ForwardStartupSettings } from "./ForwardStartupSettings";
import { useForwardDraft } from "./useForwardDraft";
import { useForwardActions } from "./useForwardActions";
import { useForwardContext } from "../../hooks/useForwardContext";
import { manualForwardDraft, manualForwardStatus } from "../../lib/forwardOwnership";
import { FORWARD_PURPOSES, forwardConflict, forwardRule, forwardValues, newForwardValues, type ForwardValues } from "../../lib/forwardPresentation";
import { ManagedForwardStatus } from "./ManagedForwardStatus";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ForwardRecovery } from "./ForwardRecovery";
import "./forward-panel.css";

const STATES = { connecting: "建立中", up: "运行中", reconnecting: "重连中", error: "需处理", stopped: "未开启" };
type PanelProps = { conn: SshConnection; onBack: () => void; onNavigate?: (tab: string, anchor?: string) => void };
type Editor = { id?: string; values: ForwardValues };

export function TerminalForwardPanel(props: PanelProps) {
  // Switching servers must discard this panel's unsaved fields and one-time credentials.
  return <ForwardPanel key={props.conn.id} {...props} />;
}

/** The background tunnel owns runtime state; editors own only unsaved input. */
function ForwardPanel({ conn, onBack, onNavigate }: PanelProps) {
  const context = useForwardContext(conn.id);
  const tunnelStatus = useTunnelStatus(conn.id);
  const managedStatus = useTunnelStatus(stableRuntimeId(conn.id));
  const status = manualForwardStatus(tunnelStatus ?? context.data?.manualStatus ?? undefined, context.data);
  const d = useForwardDraft(conn);
  const actions = useForwardActions(conn, context, d);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [picking, setPicking] = useState(false);
  const [help, setHelp] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState<(() => void) | null>(null);
  const draft = manualForwardDraft(context.data ? d.rules : [], context.data);
  const running = !!status && !["error", "stopped"].includes(status.state);
  // 同服务器两条独立 SSH 通道并存：手动转发与 Claude Code 托管隧道各起一条 ssh
  // 进程（各登录、各占一份 MaxSessions）。共享服务器限制并发登录时其中一条会
  // 间歇失败，用户从报错里看不出是这个原因——在这里讲明白。
  const dualChannel =
    running &&
    !!managedStatus &&
    !["error", "stopped"].includes(managedStatus.state);
  const hasEnabled = draft.manualRules.some(rule => rule.enabled);
  const needsApply = running && !matchesRunning(draft.manualRules, status!);
  const conflict = draft.manualRules.some(rule => forwardConflict(rule, draft.manualRules, context.data));
  const state = context.error || conflict || status?.rules.some(rule => rule.state === "failed") ? "需处理"
    : status?.state === "up" && status.rules.some(rule => rule.state === "pending") ? "监听待确认" : STATES[status?.state ?? "stopped"];
  const removed = running ? status!.rules.filter(live => !draft.manualRules.some(rule => rule.id === live.rule.id)).map(live => live.rule) : [];
  const visible = [...draft.manualRules, ...removed];
  const disabled = actions.busy || !actions.ready;
  const primary = needsApply ? "应用更改" : hasEnabled && !running ? status?.state === "error" ? "重试开启" : "开启转发" : "新增转发";
  const affected = status?.state === "up" ? status.rules.filter(entry => entry.state === "listening") : [];
  const withRestartConfirmation = (action: () => void) => {
    if (affected.length) setConfirmRestart(() => action);
    else action();
  };
  const choose = (kind: ForwardKind) => { setPicking(false); setEditor({ values: newForwardValues(kind) }); };
  const edit = (rule: ForwardRule) => { setPicking(false); setEditor({ id: rule.id, values: forwardValues(rule) }); };
  const submit = async (values: ForwardValues, apply: boolean) => {
    const id = editor?.id || crypto.randomUUID();
    const result = await actions.saveRule(forwardRule(id, values), !!editor?.id, apply);
    if (result?.saved) setEditor(result.applied ? null : { id, values });
  };
  const mainAction = () => {
    if (primary === "新增转发") { setEditor(null); setPicking(true); }
    else withRestartConfirmation(() => void actions.start());
  };
  const applyEditor = (values: ForwardValues, apply: boolean) => {
    const saved = d.rules.find(rule => rule.id === editor?.id);
    const next = forwardRule(editor?.id ?? "new", values);
    const metadataOnly = saved && saved.enabled === next.enabled && sameForward(saved, next) && !needsApply
      && status?.rules.every(entry => entry.state === "listening");
    const action = () => void submit(values, apply);
    if (apply && !metadataOnly) withRestartConfirmation(action);
    else action();
  };
  const removeRule = (rule: ForwardRule) => {
    const apply = running && !!status?.rules.some(entry => entry.rule.id === rule.id);
    const action = () => void actions.remove(rule.id, apply);
    if (apply) withRestartConfirmation(action);
    else action();
  };
  return <section className="terminal-forward-panel absolute inset-0 z-10 flex flex-col overflow-hidden bg-card" aria-label="端口转发">
    <header className="fp-page-head">
      <button type="button" className="fp-icon-button" aria-label="返回终端" disabled={actions.busy} onClick={onBack}><Icon name="arrowLeft" size={18} /></button>
      <div className="fp-page-title"><h1>端口转发 <span>· {conn.name || conn.host}</span></h1><p>{conn.username}@{conn.host}:{conn.port}</p></div>
      <span className="fp-page-phase" data-state={state}>{draft.manualRules.length ? draft.manualRules.length + " 条手动转发 · " + state : removed.length ? "删除待应用" : context.error ? "暂时无法读取" : actions.ready ? "尚未配置" : "正在核对"}</span>
      <div className="fp-page-actions">
        {status && status.state !== "stopped" && <Button type="button" variant="outline" disabled={actions.busy} isLoading={actions.operation === "stop"} loadingText="正在停止…" onClick={() => void actions.stop()}><Icon name="power" size={14} />停止转发</Button>}
        {!editor && <Button type="button" disabled={disabled || primary !== "新增转发" && !!conflict} isLoading={actions.operation === "start"} loadingText="正在建立转发…" onClick={mainAction}><Icon name={needsApply ? "check" : primary === "新增转发" ? "plus" : "play"} size={15} />{primary}</Button>}
      </div>
    </header>
    {context.data && <ManagedForwardStatus context={context.data} onNavigate={onNavigate} />}
    {dualChannel && <p className="fp-page-note" role="note"><Icon name="info" size={14} />这台服务器同时运行 Claude Code 隧道与手动转发（两条独立 SSH 连接）。若服务器限制并发登录，其中一条可能间歇失败。</p>}
    <div className="fp-page-body">
      {status && <ForwardRecovery status={status}/>}
      {context.isPending && <><p role="status" className="fp-read-state">正在核对隧道与手动转发…</p><div className="fp-read-skeleton" aria-hidden="true" /></>}
      {context.error && <div role="alert" className="fp-read-state">暂时无法读取转发关联状态<Button type="button" size="sm" variant="outline" onClick={() => void context.refetch()}>重新读取</Button></div>}
      {status?.state === "error" && status.needsJumpSecret && <div className="fp-read-state" role="alert"><p>跳板机登录失败。请在终端侧栏编辑跳板机，更新密码或密钥口令后再重试。</p><Button type="button" size="sm" variant="outline" onClick={onBack}>返回终端</Button></div>}
      {status?.state === "error" && status.needsSecret && !status.needsJumpSecret && <form className="fp-login" onSubmit={event => { event.preventDefault(); void actions.start(undefined, actions.secret); }}>
        <label htmlFor="fp-login-secret">输入{conn.authType === "key" ? "密钥口令" : "登录密码"}后开启手动转发</label>
        <input id="fp-login-secret" type="password" autoFocus autoComplete="off" disabled={disabled} value={actions.secret} onChange={event => actions.setSecret(event.target.value)} />
        <Button type="submit" disabled={disabled || !actions.secret} isLoading={actions.operation === "start"}>输入并开启</Button><p>仅用于本次转发及断线重连，停止后清除，不保存到连接配置。</p>
      </form>}
      {status?.state === "error" && !status.needsSecret && !status.rules.some(rule => rule.state === "failed") && status.message && <details className="fp-connection-error"><summary>手动转发未连接 · 查看原因</summary><p>{status.message}</p><p>检查网络和服务器登录信息后，点击“重试开启”。</p></details>}
      {!context.isPending && <div className="fp-body-intro"><div><h2>{editor ? editor.id ? "编辑转发" : "添加转发" : picking || !visible.length ? visible.length ? "选择转发用途" : "添加你的第一条转发" : "已配置的手动转发"}</h2><p>{editor ? "只需填写必要信息，高级参数可以稍后调整。" : "让两台设备之间的服务，像在本机一样使用。"}</p></div><button type="button" className="fp-text-button" aria-expanded={help} onClick={() => setHelp(!help)}><Icon name="info" size={15} />使用说明</button></div>}
      {help && <div className="fp-help"><strong>先看服务在哪里，再看你要在哪里使用它。</strong><p>服务在服务器上，就选“在本机访问服务器服务”；服务在本机上，就选“在服务器访问本机服务”。开启后，复制规则里显示的地址，在标注的那台设备上使用。</p>{!!context.data?.managed.length && <p>Claude Code 的固定地址接入，请使用上方“查看接入”。</p>}</div>}
      {actions.ready && (picking || !visible.length) && !editor && <ForwardSection onChoose={choose} />}
      {editor && <><div className="fp-steps"><span className="fp-step-done"><Icon name="check" size={13} />选择用途</span><Icon name="chevronRight" size={13} /><span className="fp-step-current">填写信息</span><Icon name="chevronRight" size={13} /><span>开启并使用</span>{!editor.id && <button type="button" className="fp-text-button" disabled={disabled} onClick={() => { setEditor(null); setPicking(true); }}>换个用途</button>}</div><ForwardEditor key={editor.id || editor.values.kind} values={editor.values} rules={d.rules} context={context.data} editingId={editor.id} running={running} busy={actions.operation === "save" || actions.operation === "start"} disabled={disabled} loadingText={actions.operation === "save" ? "正在保存配置…" : "正在建立转发…"} onChange={values => setEditor({ ...editor, values })} onCancel={() => setEditor(null)} onSubmit={applyEditor} /></>}
      {!!visible.length && <div className="fp-rules-list" aria-label="手动转发规则">{(picking || editor) && visible.some(rule => rule.id !== editor?.id) && <h3 className="fp-existing-caption">已有转发继续在这里管理</h3>}{visible.filter(rule => rule.id !== editor?.id).map(rule => <ForwardRuleRow key={rule.id} rule={rule} status={status} removed={removed.some(item => item.id === rule.id)} conflict={forwardConflict(rule, draft.manualRules, context.data)} busy={disabled} onEdit={() => edit(rule)} onApply={() => withRestartConfirmation(() => void actions.start())} onStart={() => withRestartConfirmation(() => void actions.start(rule))} onRemove={() => removeRule(rule)} />)}</div>}
      {actions.ready && <p className="fp-background-hint"><Icon name="info" size={14} />{running ? "已开启的转发在后台运行，离开页面或关闭终端会话仍可继续使用。关闭 SSH 功能或退出软件时停止。" : "配置会保留，开启转发后再到指定设备上使用地址。"}</p>}
    </div>
    <ForwardStartupSettings value={d.auto} disabled={disabled} saving={actions.operation === "auto"} onChange={value => void actions.changeAuto(value)} />
    {confirmRestart && <ConfirmDialog title="重新建立手动转发？" confirmLabel="确认并继续"
      description="继续会短暂中断这台服务器上正在使用的手动转发。应用失败时会尝试恢复原来的规则。"
      onCancel={() => setConfirmRestart(null)} onConfirm={() => { setConfirmRestart(null); confirmRestart(); }}>
      <ul className="list-disc pl-5 text-sm text-muted-foreground">{affected.slice(0, 4).map(({rule}) => <li key={rule.id}>{rule.note || FORWARD_PURPOSES[rule.kind].short} · {rule.listenPort || "自动分配端口"}</li>)}{affected.length > 4 && <li>另有 {affected.length - 4} 条</li>}</ul>
      {affected.some(({rule}) => rule.listenPort === 0) && <p className="mt-2 text-sm text-muted-foreground">服务器自动分配的端口可能变化。</p>}
    </ConfirmDialog>}
  </section>;
}
