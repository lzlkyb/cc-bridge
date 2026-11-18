import { useEffect, useState } from "react";
import { formatUptime } from "../../lib/utils";
import type { StaticStatus } from "../../lib/types";
import { currentAccessChain, connectionMethodLabel, connectionScopeLabel } from "../../lib/connectionAccess";
import type { ChainTone } from "../../lib/serviceChain";
import { useCurrentConnection } from "../../hooks/useCurrentConnection";
import { useServiceControl } from "../../hooks/useServiceControl";
import { useLiveStatus } from "../../hooks/useLiveStatus";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useAppHidden } from "../../lib/appVisibility";
import { useRemoteActivity } from "../../lib/metricHistory";
import { useChangeClass } from "../../hooks/useChangeClass";
import { ServiceChain } from "./ServiceChain";
import { TunnelConnectionFlow } from "./connect/TunnelConnectionFlow";
import { RecentActivity } from "./RecentActivity";
import { StopClick } from "../ui/NavTarget";
import { useToast } from "../ui/toast";
import { useDashboardMotion } from "../../hooks/useDashboardMotion";

const TONE_CLASS: Record<ChainTone, string> = {
  live: "status-card--live", warn: "status-card--warn",
  error: "status-card--error", stopped: "status-card--stopped",
};

/** The current access owns the conclusion; local service and global history remain explicit. */
export function StatusCard({ status, displayHost, port, onChanged, onNavigate }: {
  status?: StaticStatus; displayHost: string; port: number; onChanged: () => void;
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const { data: live } = useLiveStatus();
  const access = useCurrentConnection(status);
  const tunnel = access?.method === "stable" ? access : undefined;
  const control = useServiceControl(status, onChanged);
  const running = !!status?.running;
  const chain = currentAccessChain(status, access);
  // A reconnect belongs to the route. Keep the shared service controls on a stable surface.
  const surfaceTone = tunnel?.state === "recovery" && running ? "live" : chain.tone;
  const { lastIncreaseAt } = useRemoteActivity();
  const motion = useDashboardMotion();
  const traffic = useChangeClass(lastIncreaseAt ?? 0, "dashboard-traffic", 900, !tunnel && motion && running && lastIncreaseAt !== null);
  const toneSwitch = useChangeClass(surfaceTone, "status-card--switch", 400, motion);
  const { toast } = useToast();

  const [liveUptime, setLiveUptime] = useState(0);
  const uptimeSeconds = live?.uptimeSeconds;
  const appHidden = useAppHidden();
  useEffect(() => {
    if (uptimeSeconds == null || !running) return;
    setLiveUptime(uptimeSeconds);
    if (appHidden) return;
    const timer = setInterval(() => setLiveUptime(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, [uptimeSeconds, running, appHidden]);

  const restart = async () => {
    if (await control.run("restart")) toast("本机服务已重启", "success");
  };
  const projectName = access?.projectPath.split("/").filter(Boolean).slice(-1)[0];

  return <div className={`status-card connection-status-card ${TONE_CLASS[surfaceTone]} ${toneSwitch} ${traffic}`}
    data-connection-state={access?.state} data-connection-method={tunnel?.method}>
    <div className="status-eyebrow connection-card-caption">
      <span className="connection-status-dot"/><strong>当前接入</strong>
      <span className="connection-card-method">{access ? connectionMethodLabel(access) : "读取中"}</span>
    </div>
    {!tunnel && <div className="my-3.5"><ServiceChain segments={chain.segments} onNavigate={onNavigate} platform={status?.platform}/></div>}
    {tunnel ? <TunnelConnectionFlow key={tunnel.connectionId} access={tunnel} service={chain.segments[0]} motion={motion} onNavigate={onNavigate}/>
      : <><p className="connection-card-headline" aria-live="polite">{chain.headline}</p>
        <p className="status-summary connection-card-detail">{chain.sub}</p></>}
    {access && <div className="connection-card-target" title={access.projectPath}>
      <Icon name={access.method === "stable" ? "server" : "monitor"} size={13}/>
      <span>{access.serverName} · {connectionScopeLabel(access.scope)}{access.scope !== "user" && projectName ? ` · ${projectName}` : ""}</span>
    </div>}
    <details className="connection-local-details">
      <summary>本机服务详情<Icon name="chevronDown" size={12}/></summary>
      <p>监听地址 <code>{status?.host ?? displayHost}:{port}</code>{tunnel && <span>（本机服务端口）</span>}</p>
      {tunnel?.address && <p>服务器上的接入地址 <code>{tunnel.address}</code>，端口由服务器按账号分配。</p>}
      <p>{status?.remoteTlsEnabled ? "HTTPS" : "HTTP"} · {status?.transport === "sse" ? "SSE" : "HTTP"} 传输 · {status?.token ? "访问令牌已启用" : "未设访问令牌"}</p>
      <p>{running ? `已运行 ${formatUptime(liveUptime)}` : "本机服务未运行"}；停止服务会影响全部接入。</p>
      {access?.configurationVerified && <p>远端配置已核实{access.verifiedAt ? ` · ${new Date(access.verifiedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}，客户端加载情况仍待验证。</p>}
    </details>
    {status && <StopClick className="connection-service-actions">
      <Button onClick={() => void control.run(running ? "stop" : "start")} disabled={control.busy} className="status-btn status-btn--grow">
        <Icon name={control.busy ? "spinner" : running ? "pause" : "play"} size={14} className={control.busy ? "animate-spin" : ""}/>
        {control.pending === "restart" ? "重启中…" : control.pending === "stop" ? "停止中…" : control.pending === "start" ? "启动中…" : running ? "停止本机服务" : "启动本机服务"}
      </Button>
      <Button onClick={() => void restart()} disabled={control.busy || !running} className="status-btn status-btn--ghost"><Icon name="refresh" size={14}/>重启</Button>
    </StopClick>}
    {control.error && <div className="status-error animate-shake mt-2 flex items-start gap-1.5 rounded-lg border border-white/25 bg-black/25 px-2.5 py-1.5 text-[11.5px]" role="alert">
      <Icon name="alertTriangle" size={13} className="mt-px shrink-0"/><span className="break-all">{control.error}</span>
    </div>}
    <RecentActivity onViewAll={onNavigate ? () => onNavigate("log") : undefined}/>
  </div>;
}
