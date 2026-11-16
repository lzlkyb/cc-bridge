import { useState } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { matchesRunning, useTunnelStatus } from "../../lib/sshTunnelStore";
import type { ForwardKind, ForwardRule, SshConnection } from "../../lib/types";
import { ForwardSection } from "./ForwardSection";
import { ForwardEditor } from "./ForwardEditor";
import { ForwardRuleRow } from "./ForwardRuleRow";
import { ForwardStartupSettings } from "./ForwardStartupSettings";
import { useForwardDraft } from "./useForwardDraft";
import { useForwardActions } from "./useForwardActions";
import { useForwardContext } from "../../hooks/useForwardContext";
import { manualForwardDraft, manualForwardStatus } from "../../lib/forwardOwnership";
import { forwardConflict, forwardRule, forwardValues, newForwardValues, type ForwardValues } from "../../lib/forwardPresentation";
import { ManagedForwardStatus } from "./ManagedForwardStatus";
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
  const status = context.data ? manualForwardStatus(tunnelStatus ?? context.data.manualStatus ?? undefined, context.data) : undefined;
  const d = useForwardDraft(conn);
  const actions = useForwardActions(conn, context, d);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [picking, setPicking] = useState(false);
  const [help, setHelp] = useState(false);
  const draft = manualForwardDraft(context.data ? d.rules : [], context.data);
  const running = !!status && !["error", "stopped"].includes(status.state);
  const hasEnabled = draft.manualRules.some(rule => rule.enabled);
  const needsApply = running && !matchesRunning(draft.manualRules, status!);
  const conflict = draft.manualRules.some(rule => forwardConflict(rule, draft.manualRules, context.data));
  const state = context.error || conflict || status?.rules.some(rule => rule.state === "failed") ? "需处理" : STATES[status?.state ?? "stopped"];
  const removed = running ? status!.rules.filter(live => !draft.manualRules.some(rule => rule.id === live.rule.id)).map(live => live.rule) : [];
  const visible = [...draft.manualRules, ...removed];
  const disabled = actions.busy || !actions.ready;
  const primary = needsApply ? "应用更改" : hasEnabled && !running ? status?.state === "error" ? "重试开启" : "开启转发" : "新增转发";
  const choose = (kind: ForwardKind) => { setPicking(false); setEditor({ values: newForwardValues(kind) }); };
  const edit = (rule: ForwardRule) => { setPicking(false); setEditor({ id: rule.id, values: forwardValues(rule) }); };
  const submit = async (values: ForwardValues, apply: boolean) => {
    const id = editor?.id || crypto.randomUUID();
    const result = await actions.saveRule(forwardRule(id, values), !!editor?.id, apply);
    if (result?.saved) setEditor(result.applied ? null : { id, values });
  };
  const mainAction = () => {
    if (primary === "新增转发") { setEditor(null); setPicking(true); }
    else void actions.start();
  };
  return <section className="terminal-forward-panel absolute inset-0 z-10 flex flex-col overflow-hidden bg-card" aria-label="端口转发">
    <header className="fp-page-head">
      <button type="button" className="fp-icon-button" aria-label="返回终端" disabled={actions.busy} onClick={onBack}><Icon name="arrowLeft" size={18} /></button>
      <div className="fp-page-title"><h1>端口转发 <span>· {conn.name || conn.host}</span></h1><p>{conn.username}@{conn.host}:{conn.port}</p></div>
      <span className="fp-page-phase" data-state={state}>{draft.manualRules.length ? draft.manualRules.length + " 条手动转发 · " + state : removed.length ? "删除待应用" : context.error ? "暂时无法读取" : actions.ready ? "尚未配置" : "正在核对"}</span>
      <div className="fp-page-actions">
        {status && status.state !== "stopped" && <Button type="button" variant="outline" disabled={disabled || !!editor} isLoading={actions.operation === "stop"} loadingText="正在停止…" onClick={() => void actions.stop()}><Icon name="power" size={14} />停止转发</Button>}
        {!editor && <Button type="button" disabled={disabled || primary !== "新增转发" && !!conflict} isLoading={actions.operation === "start"} loadingText="正在建立转发…" onClick={mainAction}><Icon name={needsApply ? "check" : primary === "新增转发" ? "plus" : "play"} size={15} />{primary}</Button>}
      </div>
    </header>
    {context.data && <ManagedForwardStatus context={context.data} onNavigate={onNavigate} />}
    <div className="fp-page-body">
      {context.isPending && <><p role="status" className="fp-read-state">正在核对隧道与手动转发…</p><div className="fp-read-skeleton" aria-hidden="true" /></>}
      {context.error && <div role="alert" className="fp-read-state">暂时无法读取转发关联状态<Button type="button" size="sm" variant="outline" onClick={() => void context.refetch()}>重新读取</Button></div>}
      {status?.state === "error" && status.needsSecret && <form className="fp-login" onSubmit={event => { event.preventDefault(); void actions.start(undefined, actions.secret); }}>
        <label htmlFor="fp-login-secret">输入{conn.authType === "key" ? "密钥口令" : "登录密码"}后开启手动转发</label>
        <input id="fp-login-secret" type="password" autoFocus autoComplete="off" disabled={disabled} value={actions.secret} onChange={event => actions.setSecret(event.target.value)} />
        <Button type="submit" disabled={disabled || !actions.secret} isLoading={actions.operation === "start"}>输入并开启</Button><p>仅用于本次转发及断线重连，停止后清除，不保存到连接配置。</p>
      </form>}
      {status?.state === "error" && !status.needsSecret && !status.rules.some(rule => rule.state === "failed") && status.message && <details className="fp-connection-error"><summary>手动转发未连接 · 查看原因</summary><p>{status.message}</p><p>检查网络和服务器登录信息后，点击“重试开启”。</p></details>}
      {!context.isPending && <div className="fp-body-intro"><div><h2>{editor ? editor.id ? "编辑转发" : "添加转发" : picking || !visible.length ? visible.length ? "选择转发用途" : "添加你的第一条转发" : "已配置的手动转发"}</h2><p>{editor ? "只需填写必要信息，高级参数可以稍后调整。" : "让两台设备之间的服务，像在本机一样使用。"}</p></div><button type="button" className="fp-text-button" aria-expanded={help} onClick={() => setHelp(!help)}><Icon name="info" size={15} />使用说明</button></div>}
      {help && <div className="fp-help"><strong>先看服务在哪里，再看你要在哪里使用它。</strong><p>服务在服务器上，就选“在本机访问服务器服务”；服务在本机上，就选“在服务器访问本机服务”。开启后，复制规则里显示的地址，在标注的那台设备上使用。</p>{!!context.data?.managed.length && <p>Claude Code 的固定地址接入，请使用上方“管理接入”。</p>}</div>}
      {actions.ready && (picking || !visible.length) && !editor && <ForwardSection onChoose={choose} />}
      {editor && <><div className="fp-steps"><span className="fp-step-done"><Icon name="check" size={13} />选择用途</span><Icon name="chevronRight" size={13} /><span className="fp-step-current">填写信息</span><Icon name="chevronRight" size={13} /><span>开启并使用</span>{!editor.id && <button type="button" className="fp-text-button" disabled={disabled} onClick={() => { setEditor(null); setPicking(true); }}>换个用途</button>}</div><ForwardEditor key={editor.id || editor.values.kind} values={editor.values} rules={d.rules} context={context.data} editingId={editor.id} running={running} busy={actions.operation === "save" || actions.operation === "start"} disabled={disabled} loadingText={actions.operation === "save" ? "正在保存配置…" : "正在建立转发…"} onChange={values => setEditor({ ...editor, values })} onCancel={() => setEditor(null)} onSubmit={(values, apply) => void submit(values, apply)} /></>}
      {!!visible.length && <div className="fp-rules-list" aria-label="手动转发规则">{(picking || editor) && visible.some(rule => rule.id !== editor?.id) && <h3 className="fp-existing-caption">已有转发继续在这里管理</h3>}{visible.filter(rule => rule.id !== editor?.id).map(rule => <ForwardRuleRow key={rule.id} rule={rule} status={status} removed={removed.some(item => item.id === rule.id)} conflict={forwardConflict(rule, draft.manualRules, context.data)} busy={disabled} onEdit={() => edit(rule)} onApply={() => void actions.start()} onStart={() => void actions.start(rule)} onRemove={() => void actions.remove(rule.id, running && !!status?.rules.some(live => live.rule.id === rule.id))} />)}</div>}
      {actions.ready && <p className="fp-background-hint"><Icon name="info" size={14} />{running ? "已开启的转发在后台运行，离开页面或关闭终端会话仍可继续使用。关闭 SSH 功能或退出软件时停止。" : "配置会保留，开启转发后再到指定设备上使用地址。"}</p>}
    </div>
    <ForwardStartupSettings value={d.auto} disabled={disabled} saving={actions.operation === "auto"} onChange={value => void actions.changeAuto(value)} />
  </section>;
}
