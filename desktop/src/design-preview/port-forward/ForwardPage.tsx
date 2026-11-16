import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { AUTO_OPTIONS, emptyValues, initialRules, usageAddress, type AutoMode, type Purpose, type Rule, type Scenario, type Values } from "./model";
import { ForwardForm, PurposePicker } from "./ForwardForm";
import { ForwardRuleCard } from "./ForwardRuleCard";

export function ForwardPage({ scenario, tunnelReady, onManage, notify, onSummary, onCopy }: {
  scenario: Scenario; tunnelReady: boolean; onManage: () => void; notify: (message: string) => void;
  onSummary: (count: number, state: string) => void; onCopy: (value: string) => Promise<boolean>;
}) {
  const [rules, setRules] = useState<Rule[]>(() => initialRules(scenario));
  const [editor, setEditor] = useState<{ id?: string; values: Values } | null>(() => scenario === "local" || scenario === "remote" ? { values: emptyValues(scenario) } : null);
  const [picking, setPicking] = useState(false);
  const [auto, setAuto] = useState<AutoMode>("ask");
  const [autoOpen, setAutoOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number>();
  const connecting = rules.some(rule => rule.phase === "connecting");
  const live = rules.some(rule => rule.phase === "running");
  const waiting = rules.some(rule => rule.phase === "reconnecting");
  const failed = rules.some(rule => rule.phase === "error");
  const pending = rules.some(rule => rule.pending);
  const selectedAuto = AUTO_OPTIONS.find(option => option.value === auto)!;
  const state = connecting ? "建立中" : waiting ? "重连中" : failed ? "需处理" : live ? "运行中" : "未开启";
  useEffect(() => onSummary(rules.length, state), [rules.length, state, onSummary]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const choose = (purpose: Purpose) => { setPicking(false); setEditor({ values: emptyValues(purpose) }); };
  const complete = (next: Rule[], message: string, ids = next.map(rule => rule.id)) => {
    setBusy(true);
    setRules(next.map(rule => ids.includes(rule.id) ? { ...rule, phase: "connecting" } : rule));
    timer.current = window.setTimeout(() => {
      setRules(next.map(rule => ids.includes(rule.id) ? { ...rule, phase: "running" } : rule));
      setBusy(false); setEditor(null); setPicking(false); notify(message);
    }, 850);
  };
  const save = (values: Values, apply: boolean) => {
    const existing = rules.find(rule => rule.id === editor?.id);
    const id = existing?.id || "forward-" + crypto.randomUUID();
    if (!apply) {
      if (existing && (existing.phase === "running" || existing.phase === "reconnecting")) {
        setRules(previous => previous.map(rule => rule.id === id ? { ...rule, pending: { ...values } } : rule));
        notify("配置已保存，当前地址保持不变。点击“应用更改”后生效。");
      } else {
        const saved: Rule = { id, values: { ...values }, phase: "stopped" };
        setRules(previous => existing ? previous.map(rule => rule.id === id ? saved : rule) : [...previous, saved]);
        notify("转发配置已保存，可以随时开启。");
      }
      setEditor(null); return;
    }
    const saved: Rule = { id, values: { ...values }, phase: "running" };
    const next = existing ? rules.map(rule => rule.id === id ? saved : rule) : [...rules, saved];
    complete(next, "转发已开启。在" + (values.purpose === "remote" ? "服务器" : "本机") + "上使用 " + usageAddress(values) + "。", [id]);
  };
  const applyChanges = (ids = rules.filter(rule => rule.pending).map(rule => rule.id)) => complete(rules.map(rule => ids.includes(rule.id) ? { ...rule, values: rule.pending || rule.values, pending: undefined } : rule), "更改已应用，使用地址已更新。", ids);
  const stop = () => { setRules(previous => previous.map(rule => ({ ...rule, phase: "stopped" }))); notify("手动转发已停止，配置已保留。Claude Code 隧道仍由接入卡管理。"); };
  const edit = (rule: Rule) => { setPicking(false); setEditor({ id: rule.id, values: { ...(rule.pending || rule.values) } }); };
  const pick = () => { setEditor(null); setPicking(true); };
  const primary = pending ? "应用更改" : rules.length && !live && !waiting && !failed ? "开启转发" : "新增转发";
  return <section className="fp-page">
    <header className="fp-page-head">
      <button className="fp-icon-button fp-back" aria-label="返回终端" onClick={() => { setEditor(null); setPicking(false); notify("当前正在预览端口转发页面，终端会话保持原有入口。"); }}><Icon name="arrowLeft" size={18} /></button>
      <div className="fp-page-title"><h1>端口转发 <span>· 公司</span></h1><p>lizuliang@10.0.19.194:22</p></div>
      <span className="fp-page-phase" data-state={state}>{rules.length ? rules.length + " 条手动转发 · " + state : "尚未配置"}</span>
      <div className="fp-page-actions">
        {(live || waiting || failed) && <Button variant="outline" disabled={busy || !!editor} onClick={stop}><Icon name="power" size={14} />停止转发</Button>}
        {!editor && <Button disabled={busy} isLoading={busy} loadingText="正在建立转发…" onClick={() => pending ? applyChanges() : primary === "开启转发" ? complete(rules, "手动转发已开启。") : pick()}><Icon name={pending ? "check" : primary === "开启转发" ? "play" : "plus"} size={15} />{primary}</Button>}
      </div>
    </header>
    <div className="fp-managed-row"><Icon name="plug" size={17} /><strong>Claude Code 隧道</strong><span className="fp-managed-phase">{tunnelReady ? "已连通" : "已暂停"}</span><span className="fp-managed-meta">固定端口 7823 · 接入卡自动管理</span><button className="fp-text-button" onClick={onManage}>管理接入<Icon name="arrowRight" size={14} /></button></div>
    <div className="fp-page-body">
      <div className="fp-body-intro"><div><h2>{editor ? editor.id ? "编辑转发" : "添加转发" : picking || !rules.length ? rules.length ? "选择转发用途" : "添加你的第一条转发" : "已配置的手动转发"}</h2><p>{editor ? "只需填写必要信息，高级参数可以稍后调整。" : "让两台设备之间的服务，像在本机一样使用。"}</p></div><button className="fp-text-button" aria-expanded={help} onClick={() => setHelp(!help)}><Icon name="info" size={15} />使用说明</button></div>
      {help && <div className="fp-help"><strong>先看服务在哪里，再看你要在哪里使用它。</strong><p>服务在服务器上，就选“在本机访问服务器服务”；服务在本机上，就选“在服务器访问本机服务”。开启后，复制规则里显示的地址，在标注的那台设备上使用。</p><p>Claude Code 的固定地址接入，请使用上方“管理接入”。</p></div>}
      {(picking || !rules.length) && !editor && <PurposePicker onChoose={choose} />}
      {editor && <><div className="fp-steps"><span className="fp-step-done"><Icon name="check" size={13} />选择用途</span><Icon name="chevronRight" size={13} /><span className="fp-step-current">填写信息</span><Icon name="chevronRight" size={13} /><span>开启并使用</span>{!editor.id && <button className="fp-text-button" disabled={busy} onClick={() => { setEditor(null); setPicking(true); }}>换个用途</button>}</div><ForwardForm key={editor.id || editor.values.purpose} values={editor.values} rules={rules} editingId={editor.id} running={!!editor.id && rules.some(rule => rule.id === editor.id && (rule.phase === "running" || rule.phase === "reconnecting"))} busy={busy} onChange={values => setEditor({ ...editor, values })} onCancel={() => setEditor(null)} onSubmit={save} /></>}
      {!!rules.length && <div className="fp-rules-list" aria-label="手动转发规则">{(picking || editor) && rules.some(rule => rule.id !== editor?.id) && <h3 className="fp-existing-caption">已有转发继续在这里管理</h3>}{rules.filter(rule => rule.id !== editor?.id).map(rule => <ForwardRuleCard key={rule.id} rule={rule} busy={busy} onEdit={() => edit(rule)} onApply={() => applyChanges([rule.id])} onStart={() => complete(rules, "手动转发已重新开启。", [rule.id])} onRemove={() => { setRules(previous => previous.filter(item => item.id !== rule.id)); notify("这条手动转发已删除。"); }} onCopy={onCopy} />)}</div>}
      <p className="fp-background-hint"><Icon name="info" size={14} />{live || waiting ? "已开启的转发在后台运行，离开页面或关闭终端会话仍可继续使用。" : "配置会保留，开启转发后再到指定设备上使用地址。"}</p>
    </div>
    <footer className="fp-auto-footer">
      <div className="fp-auto-line">
        <div className="fp-auto-summary"><span className="fp-auto-icon"><Icon name="clock" size={21} /></span><div><h2>手动转发启动方式</h2><p>选择开启时机，仅用于本页手动转发。</p></div></div>
        <div className="fp-auto-current"><span>当前选择</span><strong>{selectedAuto.label}</strong></div>
        <Button className="fp-auto-change" variant="outline" aria-expanded={autoOpen} aria-controls="fp-auto-options" onClick={() => setAutoOpen(!autoOpen)}><Icon name="sliders" size={16} />{autoOpen ? "收起选项" : "更改启动方式"}<Icon name={autoOpen ? "chevronUp" : "chevronDown"} size={15} /></Button>
      </div>
      {autoOpen && <fieldset id="fp-auto-options" className="fp-auto-options"><legend className="sr-only">选择手动转发启动方式</legend>{AUTO_OPTIONS.map(option => <label key={option.value}><input type="radio" name="forward-auto" checked={auto === option.value} onChange={() => { setAuto(option.value); notify("手动转发启动方式已更改。"); }} /><span><strong>{option.label}</strong><small>{option.hint}</small></span></label>)}</fieldset>}
    </footer>
  </section>;
}
