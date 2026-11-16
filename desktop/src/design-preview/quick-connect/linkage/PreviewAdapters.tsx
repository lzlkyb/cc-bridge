import { useEffect, type ComponentProps } from "react";
import { StatusCard as OriginalStatusCard } from "../../../components/tabs/StatusCard";
import { ConnectionMethodToggle as OriginalMethodToggle, StableConnectionMethod as OriginalStableMethod } from "../../../components/tabs/connect/StableConnectionMethod";
import { StableAccessGuide as OriginalAccessGuide } from "../../../components/tabs/connect/StableAccessGuide";
import { ConnectGuide as OriginalConnectGuide } from "../../../components/tabs/connect/ConnectGuide";
import { Button } from "../../../components/ui/button";
import { Icon } from "../../../components/ui/icon";
import { useOptionalLinkage, useLinkage } from "./context";
import { scopeText } from "./model";

export function CurrentAddress() {
  const link = useLinkage();
  const { summary, copied } = link;
  return <div className="ll-address-summary" aria-label="接入地址摘要">
    <div className="ll-address-row"><div><span>{summary.addressLabel}</span><code>{summary.address || "完成配置后自动确认"}</code>{summary.stable && <small>在服务器上使用</small>}</div>
      <Button type="button" size="sm" variant="outline" disabled={!summary.canCopyAddress} onClick={() => void link.copy("address")} aria-label="复制接入地址"><Icon name={copied === "address" ? "check" : "copy"} size={13}/>{copied === "address" ? "已复制" : "复制地址"}</Button>
    </div>
    {summary.previousAddress && <p className="ll-previous-address">原接入地址 <code>{summary.previousAddress}</code></p>}
  </div>;
}

export function StatusCard(props: ComponentProps<typeof OriginalStatusCard>) {
  const link = useOptionalLinkage();
  if (!link) return <OriginalStatusCard {...props}/>;
  const { summary, status, serviceBusy } = link;
  const nodes = [
    { name: "本机服务", detail: status.running ? "运行中" : "已停止", icon: status.running ? "check" : "pause", state: status.running ? "ok" : "idle" },
    { name: summary.stable ? "隧道通道" : "地址检查", detail: summary.channelDetail, icon: summary.state === "recovery" || summary.state === "applying" ? "spinner" : summary.channelReady ? "check" : summary.state === "paused" ? "pause" : "info", state: summary.channelReady ? "ok" : "idle" },
    { name: "接入验证", detail: summary.verified ? "已核实" : "待验证", icon: summary.verified ? "check" : "clock", state: summary.verified ? "ok" : "idle" },
  ];
  return <div className={`status-card status-card--${summary.tone} ll-status-card`} data-linkage-status={summary.state}>
    <div className="status-eyebrow ll-card-caption"><span className="ll-dot"/><strong>当前接入</strong><span className="ll-card-method">{summary.methodLabel}</span></div>
    <div className="ll-chain" role="list" aria-label="当前接入链路">{nodes.map((node, index) => <button type="button" role="listitem" className="ll-chain-node" key={node.name} onClick={() => index === 0 ? props.onNavigate?.("service") : link.focusGuide()} aria-label={`${node.name}：${node.detail}`}>
      {index > 0 && <span className="ll-chain-line" data-ready={node.state === "ok"} aria-hidden="true"/>}
      <span className="chain-node-face ll-node-face" data-tone={node.state}><Icon name={node.icon} size={14} className={node.icon === "spinner" ? "animate-spin" : ""}/></span><strong>{node.name}</strong><small>{node.detail}</small>
    </button>)}</div>
    <p className="ll-card-headline" aria-live="polite">{summary.title}</p><p className="status-summary ll-card-detail">{summary.detail}</p>
    <div className="ll-card-target"><Icon name={summary.stable ? "server" : "monitor"} size={13}/><span>{summary.stable ? summary.serverName : "本机直连"} · {scopeText(summary.scope)}{summary.scope !== "user" && summary.projectPath ? ` · ${summary.projectPath.split("/").filter(Boolean).slice(-1)[0]}` : ""}</span></div>
    <details className="ll-local-details"><summary>本机服务详情<Icon name="chevronDown" size={12}/></summary><p>监听地址 <code>{status.host}:{status.port}</code></p><p>传输协议 HTTP · 访问令牌已启用</p><p>停止本机服务会影响全部接入。</p></details>
    <div className="ll-service-actions"><Button className="status-btn status-btn--grow" disabled={serviceBusy} onClick={() => void link.toggleService()}><Icon name={serviceBusy ? "spinner" : status.running ? "pause" : "play"} size={14} className={serviceBusy ? "animate-spin" : ""}/>{serviceBusy ? "处理中…" : status.running ? "停止本机服务" : "启动本机服务"}</Button><Button className="status-btn status-btn--ghost" disabled={serviceBusy || !status.running} onClick={() => void link.toggleService(true)}><Icon name="refresh" size={14}/>重启</Button></div>
    <div className="ll-history-summary"><div><strong>本机全部接入 · 历史调用</strong><span>{status.stats.totalRequests} 次</span></div><p>全局统计独立显示，当前接入状态以验证结果为准。</p></div>
  </div>;
}

export function ConnectionMethodToggle(props: ComponentProps<typeof OriginalMethodToggle>) {
  const link = useOptionalLinkage();
  return <><OriginalMethodToggle {...props}/>{link?.summary.selectionPending && <p className="ll-selection-note" role="status"><Icon name="info" size={14}/>已选择{link.summary.methodLabel}，完成接入后才会应用到服务器。</p>}</>;
}

export function StableConnectionMethod(props: ComponentProps<typeof OriginalStableMethod>) {
  const link = useOptionalLinkage();
  useEffect(() => { if (link) link.stableApi.current = props.state; }, [link, props.state]);
  if (!link || !props.state.compact) return <OriginalStableMethod {...props}/>;
  const { summary } = link;
  const caption = summary.state === "verified" ? "接入已核实" : summary.state === "waiting" ? "隧道已连通" : summary.short;
  return <section className="stable-method ll-stable-method" aria-label="隧道连接设置" data-phase={props.state.record?.phase}>
    <div className="stable-inline-status"><div><span className="stable-status-dot" data-tone={summary.tone}/><div aria-live="polite"><strong>{summary.serverName} · {caption}</strong><p>{summary.state === "verified" || summary.state === "waiting" ? "VPN 重连，无需修改 MCP 地址" : summary.detail}</p></div></div>
      <div className="stable-inline-actions"><button type="button" className="stable-link" disabled={props.state.busy} onClick={link.primary}>{summary.state === "verified" || summary.state === "waiting" ? "检查接入" : summary.action}</button><button type="button" className="stable-link" onClick={() => props.state.update({ managing: true })} aria-label="管理隧道连接">管理<Icon name="chevronDown" size={13}/></button></div>
    </div>
  </section>;
}

export function StableAccessGuide(props: ComponentProps<typeof OriginalAccessGuide>) {
  const link = useOptionalLinkage();
  useEffect(() => {
    if (!link) return;
    link.accessApi.current = props.access;
    link.setPendingScope(props.access.scopeEditing && props.access.scopeChanged);
  }, [link, props.access]);
  if (!link) return <OriginalAccessGuide {...props}/>;
  const notice = props.state.compact && !props.state.showNextStep && link.summary.state === "waiting";
  return <div className="ll-access-guide" data-compact={props.state.compact}>
    {(props.state.record?.configured || props.state.compact) && <CurrentAddress/>}
    {notice && <div className="ll-client-wait" role="status"><Icon name="clock" size={16}/><div><strong>下一步：重新打开服务器上的 Claude Code</strong><p>隧道和配置已就绪，等待当前项目发起调用。</p></div></div>}
    <OriginalAccessGuide {...props}/>
  </div>;
}

export function ConnectGuide(props: ComponentProps<typeof OriginalConnectGuide>) {
  const link = useOptionalLinkage();
  useEffect(() => { link?.bindDirectDraft(props.guide.scope, props.guide.projectPath); }, [link, props.guide.scope, props.guide.projectPath]);
  if (!link) return <OriginalConnectGuide {...props}/>;
  return <><CurrentAddress/><div className="ll-direct-evidence" role="status"><Icon name={link.summary.verified ? "check" : "clock"} size={14}/><span>{link.summary.verified ? "当前接入已核实" : link.summary.state === "copied" ? "命令已复制，请在服务器执行后再验证" : "复制命令与服务器配置生效分别确认"}</span></div><OriginalConnectGuide {...props} guide={{ ...props.guide, firstCallSeen: link.summary.verified, copyConnect: () => { void link.copy("command"); }, isCopied: key => key === "connect" ? link.copied === "command" : props.guide.isCopied(key) }}/></>;
}
