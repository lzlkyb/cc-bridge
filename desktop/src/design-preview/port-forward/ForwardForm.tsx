import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { PURPOSES, conflictFor, suggestedPort, validate, type Purpose, type Rule, type Values } from "./model";

export function PurposePicker({ onChoose }: { onChoose: (purpose: Purpose) => void }) {
  return <div className="fp-purpose-picker">
    <div className="fp-section-heading"><h2>你想让哪台设备访问服务？</h2><span>先选用途，再填端口</span></div>
    <div className="fp-purpose-options">
      {(["local", "remote"] as const).map(purpose => <button key={purpose} className="fp-purpose-option" onClick={() => onChoose(purpose)}>
        <span className="fp-purpose-icon"><Icon name={PURPOSES[purpose].icon} size={22} /></span>
        <span><strong>{PURPOSES[purpose].label}</strong><small>{PURPOSES[purpose].hint}</small></span>
        <Icon name="arrowRight" size={17} />
      </button>)}
    </div>
    <button className="fp-text-button fp-other-purpose" onClick={() => onChoose("dynamic")}>其他用途：SOCKS5 代理<Icon name="chevronRight" size={13} /></button>
  </div>;
}

export function FlowPath({ values }: { values: Values }) {
  const meta = PURPOSES[values.purpose];
  return <div className="fp-flow-path" aria-label="访问路径">
    <div><span>{meta.accessMachine} · 访问入口</span><code>{values.accessPort ? "端口 " + values.accessPort : "等待填写端口"}</code></div>
    <Icon name="arrowRight" size={20} />
    <div><span>{meta.targetMachine} · 服务</span><code>{values.purpose === "dynamic" ? "SOCKS5 代理" : values.targetHost + ":" + (values.targetPort || "端口")}</code></div>
  </div>;
}

export function ForwardForm({ values, rules, editingId, running, busy, onChange, onCancel, onSubmit }: {
  values: Values; rules: Rule[]; editingId?: string; running: boolean; busy: boolean;
  onChange: (values: Values) => void; onCancel: () => void; onSubmit: (values: Values, apply: boolean) => void;
}) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [help, setHelp] = useState(false);
  const meta = PURPOSES[values.purpose];
  const errors = validate(values, rules, editingId);
  const conflict = conflictFor(values, rules, editingId);
  const patch = (next: Partial<Values>) => onChange({ ...values, ...next });
  const changePort = (name: "targetPort" | "accessPort", value: string) => {
    const port = value.replace(/\D/g, "").slice(0, 5);
    if (name === "targetPort" && (!values.accessPort || values.accessPort === values.targetPort)) {
      patch({ targetPort: port, accessPort: port });
    } else patch({ [name]: port });
  };
  const errorFor = (name: string) => submitted || touched[name] ? errors[name] : undefined;
  const submit = (event: FormEvent, apply: boolean) => {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length === 0) onSubmit(values, apply);
  };
  return <form className="fp-form" onSubmit={event => submit(event, true)} aria-label={editingId ? "编辑转发" : "填写转发信息"}>
    <div className="fp-form-heading"><span className="fp-purpose-icon"><Icon name={meta.icon} size={20} /></span><div><h2>{meta.label}</h2><p>{editingId ? "修改后应用，才会更新实际使用的地址。" : meta.hint}</p></div></div>
    <div className="fp-form-fields">
      {values.purpose !== "dynamic" && <div className="fp-field">
        <label htmlFor="fp-target-port">{meta.targetLabel}</label>
        <div className="fp-port-control"><span>{meta.targetMachine}</span><input id="fp-target-port" disabled={busy} inputMode="numeric" value={values.targetPort} placeholder="如 3000、3306" aria-invalid={!!errorFor("targetPort")} aria-describedby="fp-target-hint" onBlur={() => setTouched(previous => ({ ...previous, targetPort: true }))} onChange={event => changePort("targetPort", event.target.value)} /></div>
        <small id="fp-target-hint" className={errorFor("targetPort") ? "fp-field-error" : ""}>{errorFor("targetPort") || "填写要访问的服务实际使用的端口"}</small>
      </div>}
      <div className="fp-field">
        <label htmlFor="fp-access-port">{meta.accessLabel}</label>
        <div className="fp-port-control"><span>{meta.accessMachine}</span><input id="fp-access-port" disabled={busy} inputMode="numeric" value={values.accessPort} placeholder="填写服务端口后建议" aria-invalid={!!errorFor("accessPort") || !!conflict} aria-describedby="fp-access-hint" onBlur={() => setTouched(previous => ({ ...previous, accessPort: true }))} onChange={event => changePort("accessPort", event.target.value)} /></div>
        <small id="fp-access-hint" className={conflict || errorFor("accessPort") ? "fp-field-error" : ""}>{conflict || errorFor("accessPort") || "开启后，在这台设备上使用这个端口"}</small>
        {conflict && <button type="button" className="fp-text-button fp-suggestion" onClick={() => patch({ accessPort: suggestedPort(values, rules, editingId) })}>使用建议端口 {suggestedPort(values, rules, editingId)}<Icon name="arrowRight" size={13} /></button>}
      </div>
    </div>
    <button type="button" className="fp-text-button fp-port-help" aria-expanded={help} onClick={() => setHelp(!help)}><Icon name="info" size={15} />不知道服务端口在哪看？</button>
    {help && <p className="fp-inline-help">端口是在服务启动时设置的编号。网页服务通常会显示“localhost:3000”这样的地址，最后的 3000 就是端口；数据库可在连接设置中查看。这里的示例端口需要按你的服务填写。</p>}
    <details className="fp-advanced">
      <summary>更多设置<span>服务地址、访问范围、名称</span><Icon name="chevronDown" size={14} /></summary>
      <div className="fp-advanced-fields">
        {values.purpose !== "dynamic" && <div className="fp-field"><label htmlFor="fp-target-host">服务地址</label><input id="fp-target-host" disabled={busy} aria-invalid={!!errorFor("targetHost")} aria-describedby="fp-host-hint" value={values.targetHost} onChange={event => patch({ targetHost: event.target.value })} /><small id="fp-host-hint" className={errorFor("targetHost") ? "fp-field-error" : ""}>{errorFor("targetHost") || "127.0.0.1 指" + meta.targetMachine + "；也可填写它能访问的其他地址。"}</small></div>}
        <div className="fp-field"><label htmlFor="fp-listen-host">谁可以使用访问入口</label><select id="fp-listen-host" disabled={busy} value={values.listenHost} onChange={event => patch({ listenHost: event.target.value })}><option value="127.0.0.1">仅在{meta.accessMachine}上使用</option><option value="0.0.0.0">允许其他设备访问</option></select><small>{values.listenHost === "0.0.0.0" ? values.purpose === "remote" ? "需要服务器允许对外监听，其他设备需使用服务器 IP。" : "其他设备需使用本机 IP 访问此端口。" : "默认仅本设备可访问入口。"}</small></div>
        <div className="fp-field"><label htmlFor="fp-rule-name">转发名称（选填）</label><input id="fp-rule-name" disabled={busy} value={values.name} placeholder="如：开发网页、数据库" onChange={event => patch({ name: event.target.value })} /></div>
      </div>
      <p className="fp-technical">SSH 方式：{values.purpose === "local" ? "本地转发 · -L" : values.purpose === "remote" ? "远端转发 · -R" : "动态代理 · -D"}</p>
    </details>
    {values.accessPort && (values.targetPort || values.purpose === "dynamic") && <FlowPath values={values} />}
    <div className="fp-form-actions">
      <Button type="submit" isLoading={busy} loadingText="正在建立转发…" disabled={!!conflict}>{editingId && running ? "应用更改" : "保存并开启"}<Icon name={editingId ? "check" : "play"} size={15} /></Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button>
      <button type="button" className="fp-text-button fp-save-only" disabled={busy} onClick={event => submit(event, false)}>仅保存配置</button>
    </div>
  </form>;
}
