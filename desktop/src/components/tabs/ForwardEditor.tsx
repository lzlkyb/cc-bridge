import { useRef, useState, type FocusEvent, type FormEvent } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import type { ForwardRule } from "../../lib/types";
import type { ForwardContext } from "../../lib/forwardOwnership";
import { FORWARD_PURPOSES, forwardConflict, forwardRule, suggestForwardPort, validateForwardValues, type ForwardValues } from "../../lib/forwardPresentation";
import { ForwardPath } from "./ForwardSection";

export function ForwardEditor({ values, rules, context, editingId, running, busy: working, disabled = false, loadingText, onChange, onCancel, onSubmit }: {
  values: ForwardValues; rules: ForwardRule[]; context?: ForwardContext; editingId?: string; running: boolean; busy: boolean; disabled?: boolean; loadingText?: string;
  onChange: (values: ForwardValues) => void; onCancel: () => void; onSubmit: (values: ForwardValues, apply: boolean) => void;
}) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [help, setHelp] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const busy = working || disabled;
  const meta = FORWARD_PURPOSES[values.kind];
  const errors = validateForwardValues(values, rules, context, editingId);
  const validPorts = !errors.targetPort && (values.automaticPort || /^\d+$/.test(values.accessPort) && +values.accessPort > 0 && +values.accessPort <= 65535);
  const conflict = validPorts ? forwardConflict(forwardRule(editingId || "new", values), rules, context) : undefined;
  const suggestion = conflict ? suggestForwardPort(values, rules, context, editingId) : "";
  const scope = values.listenHost === "127.0.0.1" ? "loopback" : values.listenHost === "0.0.0.0" ? "all" : "custom";
  const patch = (next: Partial<ForwardValues>) => onChange({ ...values, ...next });
  const touch = (name: string) => setTouched(previous => ({ ...previous, [name]: true }));
  const errorFor = (name: string) => submitted || touched[name] ? errors[name] : undefined;
  const changePort = (name: "targetPort" | "accessPort", port: string) => {
    if (name === "targetPort" && (!values.accessPort || values.accessPort === values.targetPort)) patch({ targetPort: port, accessPort: port });
    else patch({ [name]: port });
  };
  const revealField = ({ target }: FocusEvent<HTMLFormElement>) => {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const actions = form.current?.querySelector<HTMLElement>(".fp-form-actions");
    const viewport = form.current?.closest<HTMLElement>(".fp-page-body");
    if (!actions || !viewport || getComputedStyle(actions).position !== "sticky") return;
    // Leave room for the field's recovery hint as well as the input above the compact action bar.
    const field = target.closest(".fp-field") ?? target;
    const covered = field.getBoundingClientRect().bottom - actions.getBoundingClientRect().top + 12;
    if (covered > 0) viewport.scrollTop += covered;
  };
  const submit = (event: FormEvent, apply: boolean) => {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    const first = ["targetPort", "accessPort", "targetHost", "listenHost"].find(name => errors[name]);
    if (first) {
      if (first.endsWith("Host")) form.current!.querySelector("details")!.open = true;
      form.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
      return;
    }
    onSubmit(values, apply);
  };
  return <form ref={form} className="fp-form" onFocusCapture={revealField} onSubmit={event => submit(event, true)} aria-label={editingId ? "编辑转发" : "填写转发信息"}>
    <div className="fp-form-heading"><span className="fp-purpose-icon"><Icon name={meta.icon} size={20} /></span><div><h2>{meta.label}</h2><p>{editingId ? "修改后应用，才会更新实际使用的地址。" : meta.hint}</p></div></div>
    <div className="fp-form-fields">
      {values.kind !== "dynamic" && <div className="fp-field">
        <label htmlFor="fp-target-port">{meta.targetLabel}</label>
        <div className="fp-port-control"><span>{meta.targetMachine}</span><input id="fp-target-port" name="targetPort" disabled={busy} inputMode="numeric" value={values.targetPort} placeholder="如 3000、3306" aria-invalid={!!errorFor("targetPort")} aria-describedby="fp-target-hint" onBlur={() => touch("targetPort")} onChange={event => changePort("targetPort", event.target.value)} /></div>
        <small id="fp-target-hint" className={errorFor("targetPort") ? "fp-field-error" : ""}>{errorFor("targetPort") || "填写要访问的服务实际使用的端口"}</small>
      </div>}
      <div className="fp-field">
        <label htmlFor="fp-access-port">{meta.accessLabel}</label>
        <div className="fp-port-control"><span>{meta.accessMachine}</span><input id="fp-access-port" name="accessPort" disabled={busy || values.automaticPort} inputMode="numeric" value={values.automaticPort ? "" : values.accessPort} placeholder={values.automaticPort ? "开启后由服务器分配" : "填写服务端口后建议"} aria-invalid={!!errorFor("accessPort") || !!conflict} aria-describedby="fp-access-hint" onBlur={() => touch("accessPort")} onChange={event => changePort("accessPort", event.target.value)} /></div>
        <small id="fp-access-hint" className={conflict || errorFor("accessPort") ? "fp-field-error" : ""}>{conflict || errorFor("accessPort") || (values.automaticPort ? "实际端口在开启后显示，重连时可能变化。" : "开启后，在这台设备上使用这个端口")}</small>
        {suggestion && <button type="button" className="fp-text-button fp-suggestion" disabled={busy} onClick={() => patch({ automaticPort: false, accessPort: suggestion })}>使用建议端口 {suggestion}<Icon name="arrowRight" size={13} /></button>}
      </div>
    </div>
    <button type="button" className="fp-text-button fp-port-help" disabled={busy} aria-expanded={help} onClick={() => setHelp(!help)}><Icon name="info" size={15} />不知道服务端口在哪看？</button>
    {help && <p className="fp-inline-help">端口是在服务启动时设置的编号。网页服务显示的“localhost:3000”中，3000 就是端口；数据库可在连接设置中查看。请填写你的服务端口，并先在对应设备上启动服务。</p>}
    <details className="fp-advanced">
      <summary>更多设置<span>服务地址、访问范围、名称</span><Icon name="chevronDown" size={14} /></summary>
      <div className="fp-advanced-fields">
        {values.kind !== "dynamic" && <div className="fp-field"><label htmlFor="fp-target-host">服务地址</label><input id="fp-target-host" name="targetHost" disabled={busy} value={values.targetHost} aria-invalid={!!errorFor("targetHost")} aria-describedby="fp-host-hint" onBlur={() => touch("targetHost")} onChange={event => patch({ targetHost: event.target.value })} /><small id="fp-host-hint" className={errorFor("targetHost") ? "fp-field-error" : ""}>{errorFor("targetHost") || "127.0.0.1 指" + meta.targetMachine + "；也可填写它能访问的其他地址。"}</small></div>}
        <div className="fp-field"><label htmlFor="fp-listen-scope">{values.kind === "remote" ? "请求的访问范围" : "谁可以使用访问入口"}</label><select id="fp-listen-scope" disabled={busy} value={scope} onChange={event => patch({ listenHost: event.target.value === "loopback" ? "127.0.0.1" : event.target.value === "all" ? "0.0.0.0" : "" })}><option value="loopback">仅在{meta.accessMachine}上使用</option><option value="all">允许其他设备访问</option><option value="custom">自定义监听地址</option></select>
          {scope === "custom" && <><label className="sr-only" htmlFor="fp-listen-host">自定义监听地址</label><input id="fp-listen-host" name="listenHost" disabled={busy} value={values.listenHost} placeholder="如 ::1 或指定 IP" aria-invalid={!!errorFor("listenHost")} aria-describedby="fp-listen-hint" onBlur={() => touch("listenHost")} onChange={event => patch({ listenHost: event.target.value })} /></>}
          <small id="fp-listen-hint" className={errorFor("listenHost") ? "fp-field-error" : ""}>{errorFor("listenHost") || (scope === "all" ? values.kind === "remote" ? "已请求服务器对外监听，实际范围由服务器设置决定。" : "其他设备使用本机 IP 访问此端口。" : values.kind === "remote" ? "服务器可能覆盖请求的范围，实际监听范围需在服务器确认。" : "默认仅本设备可访问入口。")}</small>
        </div>
        <div className="fp-field"><label htmlFor="fp-rule-name">转发名称（选填）</label><input id="fp-rule-name" disabled={busy} value={values.note} placeholder="如：开发网页、数据库" onChange={event => patch({ note: event.target.value })} /></div>
        <div className="fp-field fp-extra-options">
          <label className="fp-checkbox"><input type="checkbox" disabled={busy} checked={values.enabled} onChange={event => patch({ enabled: event.target.checked })} />启用这条规则</label>
          {values.kind === "remote" && <label className="fp-checkbox"><input type="checkbox" disabled={busy} checked={values.automaticPort} onChange={event => patch({ automaticPort: event.target.checked })} />由服务器自动分配访问端口</label>}
          <small>{values.enabled ? "开启转发时会包含这条规则。" : "配置保留，应用后停止这条规则。"}</small>
        </div>
      </div>
      <p className="fp-technical">SSH 方式：{values.kind === "local" ? "本地转发 · -L" : values.kind === "remote" ? "远端转发 · -R" : "动态代理 · -D"}</p>
    </details>
    {validPorts && <ForwardPath rule={forwardRule(editingId || "new", values)} />}
    <div className="fp-form-actions">
      <Button type="submit" isLoading={working} loadingText={loadingText} disabled={busy || !!conflict}>{!values.enabled ? "保存并应用" : editingId && running ? "应用更改" : "保存并开启"}<Icon name={editingId ? "check" : "play"} size={15} /></Button>
      <Button type="button" variant="ghost" disabled={working} onClick={onCancel}>取消</Button>
      <button type="button" className="fp-text-button fp-save-only" disabled={busy || !!conflict} onClick={event => submit(event, false)}>仅保存配置</button>
    </div>
    {running && <p className="fp-apply-hint">应用时会重新建立这台服务器的手动转发，正在使用的连接会短暂中断。</p>}
  </form>;
}
