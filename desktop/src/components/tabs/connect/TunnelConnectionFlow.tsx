import { useEffect, useState } from "react";
import { CONNECT_GUIDE_ANCHOR, type ConnectionAccess } from "../../../lib/connectionAccess";
import type { ChainSegment } from "../../../lib/serviceChain";
import { stableRuntimeId, useTunnelStatus } from "../../../lib/sshTunnelStore";
import { useAppHidden } from "../../../lib/appVisibility";
import { invoke } from "../../../lib/tauri";
import { useToast } from "../../ui/toast";
import { Icon } from "../../ui/icon";
import { NavTarget } from "../../ui/NavTarget";
import { TunnelTrafficPulses, type TunnelTrafficSample } from "./TunnelTrafficPulses";
import "./tunnel-connection-flow.css";

export function TunnelConnectionFlow({ access, service, motion, onNavigate }: {
  access: ConnectionAccess;
  service: ChainSegment;
  motion: boolean;
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const runtime = useTunnelStatus(access.connectionId ? stableRuntimeId(access.connectionId) : "");
  const hidden = useAppHidden();
  const [sample, setSample] = useState<TunnelTrafficSample>({ toLocal: 0, toRemote: 0, lastAt: 0 });
  const [now, setNow] = useState(Date.now);
  const [retrying, setRetrying] = useState(false);
  const { toast } = useToast();
  const serviceReady = service.tone === "ok";
  const needsAction = !!runtime?.needsSecret || runtime?.state === "error" || ["login", "error", "paused"].includes(access.state);
  const connecting = serviceReady && !needsAction && (runtime
    ? runtime.state === "connecting" || runtime.state === "reconnecting"
    : access.state === "applying" || access.state === "recovery");
  const reconnecting = connecting && access.configured;
  const waiting = connecting && runtime?.state === "reconnecting" && runtime.retryAt != null;
  const retrySeconds = Math.max(0, Math.ceil(((runtime?.retryAt ?? now) - now) / 1000));
  const connected = serviceReady && !needsAction && (runtime ? runtime.state === "up" : access.channelReady) && !connecting;
  // A listening forward doesn't prove Claude Code is configured to use it.
  const clientPath = connected && access.configured && access.configMatches && access.state !== "changed";
  useEffect(() => {
    // A fresh SSH attempt must not revive the previous attempt's last visible sample.
    if (!clientPath) setSample({ toLocal: 0, toRemote: 0, lastAt: 0 });
  }, [clientPath]);
  const channelLabel = waiting ? "等待重试" : connecting ? reconnecting ? "正在重连" : "正在连接" : clientPath ? "SSH 加密转发" : serviceReady ? access.short : "SSH 隧道";
  const active = clientPath && !hidden && sample.lastAt > 0 && now - sample.lastAt < 2000;
  const clockNeeded = connecting || connected && sample.lastAt > 0;
  useEffect(() => {
    if (hidden || !clockNeeded) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hidden, clockNeeded]);

  const retry = async () => {
    if (!access.connectionId || retrying) return;
    setRetrying(true);
    try { await invoke("stable_tunnel_retry", { connectionId: access.connectionId }); }
    catch (error) { toast(`重试失败：${error}`, "error"); }
    finally { setRetrying(false); }
  };
  const phaseLabel = runtime?.phase === "auth" ? "正在验证服务器身份"
    : runtime?.phase === "forward" ? "正在恢复固定端口"
    : runtime?.phase === "confirm" ? "正在确认通道就绪" : "正在建立 SSH 连接";
  const failure = runtime?.lastFailure ?? runtime?.message ?? access.channelDetail;
  const attempt = runtime?.attempt;
  const statusLabel = waiting ? retrySeconds > 0 ? `${tunnelFailureLabel(failure)} · ${retrySeconds} 秒后自动重试` : "即将开始下一次重试"
    : connecting ? `${attempt ? `第 ${attempt} 次尝试 · ` : ""}${phaseLabel}`
    : needsAction ? runtime?.needsSecret || access.state === "login" ? "需要重新登录服务器" : "隧道连接需要处理"
    : active ? "正在传输数据" : connected ? sample.lastAt ? `通道正常 · 最近传输于 ${Math.max(0, Math.floor((now - sample.lastAt) / 1000))} 秒前` : "通道正常 · 等待数据传输" : access.short;

  return <>
    <p className="connection-card-headline" aria-live="polite">{reconnecting ? "正在恢复隧道连接" : access.title}</p>
    <p className="status-summary connection-card-detail">{reconnecting
      ? <>固定接入地址不变{runtime?.disconnectedAt ? ` · 已断开 ${Math.max(0, Math.floor((now - runtime.disconnectedAt) / 1000))} 秒` : "，正在自动恢复连接。"}</> : access.detail}</p>
    <section className="tunnel-route" aria-label="SSH 隧道传输路径" data-reconnecting={connecting} data-motion={motion}>
    <NavTarget className="tunnel-route-end" tab="connect" anchor={CONNECT_GUIDE_ANCHOR}
      title="查看服务器上的 Claude Code 接入" onNavigate={onNavigate}>
      <span className="tunnel-route-device"><Icon name="terminal" size={18} aria-hidden="true"/></span>
      <strong>Claude Code</strong>
      <small>远程服务器</small>
    </NavTarget>
    <svg className="tunnel-route-tracks" viewBox="0 0 200 46" preserveAspectRatio="none" aria-hidden="true">
      <g data-connected={clientPath}>
        <path d="M0 23C24 23 24 7 52 7H100M0 23C24 23 24 39 52 39H100"/>
      </g>
      <g data-connected={connected}>
        <path d="M100 7H148C176 7 176 23 200 23M100 39H148C176 39 176 23 200 23"/>
      </g>
      {clientPath && <path className="tunnel-route-direction" d="M84 7h50m-6-3 6 3-6 3M116 39H66m6-3-6 3 6 3"/>}
      {clientPath && !hidden && access.connectionId &&
        <TunnelTrafficPulses key={access.connectionId} connectionId={access.connectionId} motion={motion} onSample={setSample}/>}
      {connecting && <path className="tunnel-route-interruption" d="M0 23C24 23 24 7 52 7H148C176 7 176 23 200 23M0 23C24 23 24 39 52 39H148C176 39 176 23 200 23"/>}
    </svg>
    <div className="tunnel-route-channel">
      <NavTarget className="tunnel-route-state" tab="connect" anchor={CONNECT_GUIDE_ANCHOR}
        title="查看当前隧道与接入配置" onNavigate={onNavigate}>
        <Icon name={waiting ? "clock" : connecting ? "spinner" : "lock"} className={connecting && !waiting && motion ? "tunnel-route-spinner" : ""} size={11} aria-hidden="true"/>{channelLabel}
      </NavTarget>
      {clientPath && <>
        <span className="tunnel-route-request">请求<span className="sr-only">发往本机</span></span>
        <span className="tunnel-route-response">响应<span className="sr-only">返回远程服务器</span></span>
      </>}
    </div>
    <NavTarget className="tunnel-route-end" tab="settings" anchor="set-network"
      title="查看本机服务网络设置" onNavigate={onNavigate}>
      <span className="tunnel-route-device"><Icon name="monitor" size={18} aria-hidden="true"/></span>
      <strong>CC Bridge</strong>
      <small>{serviceReady ? connecting ? "本机服务正常" : "本机 MCP 服务" : `本机服务${service.detail}`}</small>
    </NavTarget>
    </section>
    <div className="tunnel-route-activity" data-tone={connecting ? "reconnecting" : needsAction ? "error" : connected ? "connected" : "idle"}>
      <div className="tunnel-route-activity-heading">
        <span className="tunnel-route-activity-label"><i aria-hidden="true"/>{statusLabel}</span>
        {waiting && <button type="button" onClick={() => void retry()} disabled={retrying || retrySeconds === 0}>立即重试<Icon name="refresh" size={10}/></button>}
        {active && <small>近 1 秒</small>}
      </div>
      <div className="tunnel-route-activity-detail">
        {connecting || needsAction ? <>
          <span title={failure}>{waiting ? `已尝试 ${attempt ?? "—"} 次 · ${access.configured ? "无需重复配置" : "等待网络恢复后继续"}`
            : needsAction ? `连接问题：${tunnelFailureLabel(failure)}`
            : runtime?.lastFailure ? `上次失败：${tunnelFailureLabel(failure)}` : "正在等待服务器响应"}</span>
          <button type="button" onClick={() => onNavigate?.("connect", CONNECT_GUIDE_ANCHOR)}>查看详情<Icon name="chevronRight" size={10}/></button>
        </> : clientPath && <><span><Icon name="arrowDown" size={10}/>发往本机 {formatTunnelBytes(active ? sample.toLocal : 0)}</span><span><Icon name="arrowUp" size={10}/>返回远端 {formatTunnelBytes(active ? sample.toRemote : 0)}</span></>}
      </div>
    </div>
  </>;
}

export function formatTunnelBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function tunnelFailureLabel(message?: string | null): string {
  if (!message) return "等待服务器响应";
  if (/timed? ?out|超时/i.test(message)) return "连接超时";
  if (/refused|拒绝连接/i.test(message)) return "服务器拒绝连接";
  if (/Permission denied|密码|口令/i.test(message)) return "登录验证失败";
  if (/resolve hostname|解析/i.test(message)) return "服务器地址解析失败";
  if (/reset|broken pipe|断开|closed/i.test(message)) return "连接已断开";
  return message;
}
