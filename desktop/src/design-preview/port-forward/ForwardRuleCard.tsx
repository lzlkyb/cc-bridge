import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { FlowPath } from "./ForwardForm";
import { PURPOSES, usageAddress, type Rule } from "./model";

const PHASES = { running: "转发已开启", stopped: "尚未开启", connecting: "正在建立转发", reconnecting: "正在自动重连", error: "暂时无法开启" };

export function ForwardRuleCard({ rule, busy, onEdit, onApply, onStart, onRemove, onCopy }: {
  rule: Rule; busy: boolean; onEdit: () => void; onApply: () => void;
  onStart: () => void; onRemove: () => void; onCopy: (value: string) => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState(false);
  const copyTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const meta = PURPOSES[rule.values.purpose];
  const copy = async () => {
    if (!(await onCopy(usageAddress(rule.values)))) return;
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  return <article className="fp-rule" data-phase={rule.phase} data-rule-id={rule.id} aria-label={rule.values.name || meta.label}>
    <header className="fp-rule-head">
      <span className="fp-rule-icon"><Icon name={meta.icon} size={20} /></span>
      <div className="fp-rule-title"><h3>{rule.values.name || meta.label}</h3><p>{meta.short}{rule.values.purpose === "dynamic" ? " · SOCKS5" : " · 公司"}</p></div>
      <span className="fp-phase" data-phase={rule.phase}><span />{PHASES[rule.phase]}</span>
      <div className="fp-rule-actions">
        <button className="fp-text-button" disabled={busy} onClick={onEdit}><Icon name="sliders" size={14} />编辑</button>
        <button className="fp-icon-button" aria-label="删除这条转发" disabled={busy} onClick={() => setConfirm(!confirm)}><Icon name="trash" size={16} /></button>
      </div>
    </header>
    <FlowPath values={rule.values} />
    <div className="fp-use-address">
      <div><span>{rule.values.purpose === "dynamic" ? "在应用中填写代理地址" : "在" + meta.accessMachine + "上使用这个地址"}</span><code>{usageAddress(rule.values)}</code></div>
      <Button variant="outline" onClick={() => void copy()} disabled={rule.phase === "error" || rule.phase === "stopped" || rule.phase === "connecting"}><Icon name={copied ? "check" : "copy"} size={15} />{copied ? "已复制" : "复制使用地址"}</Button>
    </div>
    {rule.pending && <div className="fp-rule-pending"><div><Icon name="clock" size={16} /><span><strong>更改尚未应用</strong><small>当前地址仍为 {usageAddress(rule.values)}，应用后改为 {usageAddress(rule.pending)}。</small></span></div><Button variant="secondary" disabled={busy} onClick={onApply}>应用更改</Button></div>}
    {rule.phase === "error" && <div className="fp-rule-failure"><div><strong>服务器暂时没有接受访问端口 {rule.values.accessPort}</strong><p>可以重试，或编辑这条转发改用其他访问端口。</p></div><Button variant="secondary" disabled={busy} onClick={onStart}><Icon name="refresh" size={14} />重试</Button><button className="fp-text-button" onClick={() => setReason(!reason)}>查看原因<Icon name="chevronDown" size={13} /></button>{reason && <p className="fp-error-detail">SSH 未能建立远端监听。可能是端口占用或服务器转发权限限制；此状态本身不能判断是哪一种。</p>}</div>}
    {rule.phase === "reconnecting" && <p className="fp-rule-note"><Icon name="refresh" size={14} />正在等待网络恢复，原访问地址保留。</p>}
    {rule.phase === "stopped" && <div className="fp-rule-stopped"><span>配置已保留，开启后即可复制使用地址。</span><Button variant="secondary" disabled={busy} onClick={onStart}><Icon name="play" size={14} />开启转发</Button></div>}
    {confirm && <div className="fp-delete-confirm"><span>删除这条规则{rule.phase === "running" ? "并停止它的转发" : ""}？</span><Button size="sm" variant="destructive" disabled={busy} onClick={onRemove}>删除规则</Button><Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>取消</Button></div>}
  </article>;
}
