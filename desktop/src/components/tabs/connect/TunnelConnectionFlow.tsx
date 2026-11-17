import { CONNECT_GUIDE_ANCHOR, type ConnectionAccess } from "../../../lib/connectionAccess";
import type { ChainSegment } from "../../../lib/serviceChain";
import { Icon } from "../../ui/icon";
import { NavTarget } from "../../ui/NavTarget";
import { TunnelTrafficPulses } from "./TunnelTrafficPulses";
import "./tunnel-connection-flow.css";

export function TunnelConnectionFlow({ access, service, motion, onNavigate }: {
  access: ConnectionAccess;
  service: ChainSegment;
  motion: boolean;
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const serviceReady = service.tone === "ok";
  const reconnecting = serviceReady && access.state === "recovery";
  const connecting = access.state === "applying" || reconnecting;
  const connected = serviceReady && access.channelReady && !connecting;
  // A listening forward doesn't prove Claude Code is configured to use it.
  const clientPath = connected && access.configured && access.configMatches && access.state !== "changed";
  const channelLabel = clientPath ? "SSH 加密转发" : serviceReady ? access.short : "SSH 隧道";

  return <section className="tunnel-route" aria-label="SSH 隧道传输路径" data-reconnecting={reconnecting}>
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
      {clientPath && motion && access.connectionId &&
        <TunnelTrafficPulses key={access.connectionId} connectionId={access.connectionId}/>}
      {reconnecting && <path className="tunnel-route-interruption" d="M72 7h56M72 39h56"/>}
    </svg>
    <div className="tunnel-route-channel">
      <NavTarget className="tunnel-route-state" tab="connect" anchor={CONNECT_GUIDE_ANCHOR}
        title="查看当前隧道与接入配置" onNavigate={onNavigate}>
        <Icon name="lock" size={11} aria-hidden="true"/>{channelLabel}
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
      <small>{serviceReady ? "本机 MCP 服务" : `本机服务${service.detail}`}</small>
    </NavTarget>
  </section>;
}
