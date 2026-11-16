import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { copyText } from "../../lib/utils";
import type { ForwardRule, TunnelStatus } from "../../lib/types";
import { FORWARD_PURPOSES, forwardAddress, forwardDisplay } from "../../lib/forwardPresentation";
import { ForwardPath } from "./ForwardSection";

const PHASES = { running: "转发已开启", stopped: "尚未开启", connecting: "正在建立转发", reconnecting: "正在自动重连", error: "暂时无法开启" };
export function ForwardRuleRow({ rule, status, conflict, removed, busy, onEdit, onApply, onStart, onRemove }: {
  rule: ForwardRule; status?: TunnelStatus; conflict?: string; removed?: boolean; busy: boolean;
  onEdit: () => void; onApply: () => void; onStart: () => void; onRemove: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState(false);
  const copyTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const meta = FORWARD_PURPOSES[rule.kind];
  const view = forwardDisplay(rule, status);
  const currentAddress = useRef(view.address);
  currentAddress.current = view.address;
  useEffect(() => { setCopied(false); window.clearTimeout(copyTimer.current); }, [view.address]);
  const newPending = !!status && !["error", "stopped"].includes(status.state) && rule.enabled && !view.live;
  const pending = view.pending || newPending || removed;
  const copy = async () => {
    if (!view.canCopy || !view.address) return;
    await copyText(view.address, () => {
      if (currentAddress.current !== view.address) return;
      setCopied(true); window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    }, () => toast("复制未完成，可以选中地址手动复制。", "error"));
  };
  return <article id={"forward-rule-" + rule.id} className="fp-rule" data-phase={view.phase} aria-label={rule.note || meta.label}>
    <header className="fp-rule-head"><span className="fp-rule-icon"><Icon name={meta.icon} size={20} /></span><div className="fp-rule-title"><h3>{rule.note || meta.label}</h3><p>{meta.short}{rule.kind === "dynamic" ? " · SOCKS5" : ""}</p></div><span className="fp-phase" data-phase={conflict ? "error" : view.phase}><span />{conflict ? "端口冲突" : !rule.enabled && !(view.active && view.live) ? "已停用" : PHASES[view.phase]}</span><div className="fp-rule-actions">{!removed && <><button type="button" className="fp-text-button" disabled={busy} onClick={onEdit}><Icon name="sliders" size={14} />编辑</button><button type="button" className="fp-icon-button" aria-label="删除这条转发" disabled={busy} onClick={() => setConfirm(!confirm)}><Icon name="trash" size={16} /></button></>}</div></header>
    <ForwardPath rule={view.actual} boundPort={view.boundPort} />
    <div className="fp-use-address"><div><span>{rule.kind === "dynamic" ? "在应用中填写代理地址" : "在" + meta.accessMachine + "上使用这个地址"}</span><code>{view.address || "开启后显示实际端口"}</code></div><Button variant="outline" onClick={() => void copy()} disabled={!view.canCopy}><Icon name={copied ? "check" : "copy"} size={15} />{copied ? "已复制" : "复制使用地址"}</Button></div>
    {pending && <div className="fp-rule-pending"><div><Icon name="clock" size={16} /><span><strong>{removed ? "删除尚未生效" : !rule.enabled ? "停用尚未应用" : "更改尚未应用"}</strong><small>{removed || !rule.enabled ? "当前转发仍在运行，应用后停止这条规则。" : newPending ? "配置已保存，应用后加入已开启的转发。" : "当前地址仍为 " + (view.address || "服务器分配的端口") + "，应用后改为 " + (forwardAddress(rule) || "服务器重新分配的端口") + "。"}</small></span></div><Button variant="secondary" disabled={busy || !!conflict} onClick={onApply}>应用更改</Button></div>}
    {conflict && <div className="fp-rule-failure" role="alert"><div><strong>{conflict}</strong><p>编辑访问端口，或停用这条规则后再应用。</p></div><Button variant="secondary" disabled={busy} onClick={onEdit}>编辑规则</Button></div>}
    {view.live?.state === "failed" && !conflict && <div className="fp-rule-failure"><div><strong>访问入口暂时无法建立</strong><p>可以重试，或编辑这条转发调整访问端口。</p></div><Button variant="secondary" disabled={busy} onClick={onStart}><Icon name="refresh" size={14} />重试</Button><button type="button" className="fp-text-button" onClick={() => setReason(!reason)}>查看原因<Icon name="chevronDown" size={13} /></button>{reason && <p className="fp-error-detail">{view.live.message || "SSH 未能建立监听。请检查端口是否被占用，以及服务器是否允许转发。"}</p>}</div>}
    {view.phase === "reconnecting" && <p className="fp-rule-note"><Icon name="refresh" size={14} />{view.actual.listenPort ? "正在等待网络恢复，原访问地址保留。" : "正在等待网络恢复，服务器端口可能重新分配。"}</p>}
    {view.phase === "stopped" && !pending && !conflict && <div className="fp-rule-stopped"><span>配置已保留，开启后即可复制使用地址。</span><Button variant="secondary" disabled={busy} onClick={onStart}><Icon name="play" size={14} />{rule.enabled ? "开启转发" : "启用并开启"}</Button></div>}
    {confirm && <div className="fp-delete-confirm"><span>删除这条规则{view.live ? "并应用停止它的转发" : ""}？</span><Button size="sm" variant="destructive" disabled={busy} onClick={onRemove}>删除规则</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>取消</Button></div>}
  </article>;
}
