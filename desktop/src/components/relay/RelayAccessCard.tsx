import { useState, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { useToast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { copyText } from "../../lib/utils";
import { invoke } from "../../lib/tauri";
import { buildRelaySnippet } from "../../lib/relayFormat";
import type { RelaySaveResult, RelaySnapshot } from "../../lib/types";
import { RelaySshAccess, RelayTargetSelect, relayTunnelLabel, type useRelaySshAccess } from "./RelaySshAccess";
import { RelayDeploy, relayDeployOptions, type useRelayDeployment } from "./RelayDeploy";
import "../tabs/connect/stable-connect.css";

type Access = ReturnType<typeof useRelaySshAccess>;
type Deployment = ReturnType<typeof useRelayDeployment>;

export function RelayAccessSummary({ access, deployment, baseUrl, direct, verified, disabled, onOpen }: {
  access: Access; deployment: Deployment; baseUrl: string; direct: boolean; verified: boolean;
  disabled: boolean; onOpen: () => void;
}) {
  const receipt = deployment.lastDeploy.data;
  const deployed = !!baseUrl && receipt?.url === baseUrl;
  const target = access.connection;
  const error = deployment.isError && deployment.variables?.connectionId === target?.id;
  const busy = deployment.isPending || (!direct && access.busy);
  const tone = direct || access.canReallocate || access.tunnel?.state === "reconnecting" || access.error ? "warn" : access.port ? "ok" : "accent";
  const action = !target ? "管理接入"
    : busy ? "查看进度"
    : !direct && !access.port ? access.canReallocate || access.error || access.tunnel?.state === "error" ? "恢复连接" : "建立 SSH 转发"
    : error ? "查看部署错误" : deployed ? "管理接入" : "部署到远端";
  return (
    <section className="relay-work-panel relay-access-summary" aria-label="远端接入">
      <div className="relay-access-summary-target">
        <span className="relay-route-symbol"><Icon name={direct ? "server" : "lock"} size={18} /></span>
        <div><strong>远端接入 <small>· {direct ? "内网直连" : "SSH 隧道"}</small></strong>
          {access.servers.data?.enabled && access.connections.length > 0 &&
            <RelayTargetSelect access={access} id="relay-current-target" disabled={disabled || deployment.isPending || access.pending} direct={direct} />}
        </div>
      </div>
      <div className="relay-access-summary-cell" role="status">
        <small>{direct ? "内网访问地址" : "SSH 转发"}</small>
        <span className="relay-work-badge" data-tone={tone}>
          {!direct && access.busy && <span className="relay-access-spinner" aria-hidden="true" />}
          {direct ? "内网开放" : relayTunnelLabel(access)}
        </span>
        {baseUrl ? <code>{baseUrl.replace("http://", "")}</code>
          : access.tunnel?.rules[0]?.rule.listenPort ? <small>原端口 {access.tunnel.rules[0].rule.listenPort}</small> : null}
      </div>
      <div className="relay-access-summary-cell" role="status">
        <small>远端配置</small>
        <strong>{deployment.isPending ? (deployment.variables?.recover && !baseUrl ? "正在分配新端口" : "正在部署配置")
          : error ? "部署未完成" : deployment.lastDeploy.isError ? "无法读取部署记录"
          : deployed ? "配置已部署" : receipt && baseUrl ? "远端配置需更新" : "等待部署"}</strong>
        <small>{verified ? "中转已收到成功请求" : "中转等待首个成功请求"}</small>
      </div>
      <Button size="sm" variant={deployed ? "outline" : "default"} onClick={onOpen} disabled={disabled}><Icon name="plug" size={15} />{action}</Button>
    </section>
  );
}

function RelayGuideStep({ number, title, children, complete, active }: {
  number: number; title: string; children: ReactNode; complete?: boolean; active?: boolean;
}) {
  return <li className="relay-guide-step" data-complete={complete || undefined} aria-current={active ? "step" : undefined}>
    <span className="relay-step-number" aria-label={complete ? "已完成" : undefined}>{complete ? <Icon name="check" size={15} /> : number}</span>
    <div><h3>{title}</h3>{children}</div>
  </li>;
}

export function RelayAccessCard({ snapshot, access, deployment, baseUrl, onChanged, blocked, onMigrate, onOpenTerminal }: {
  snapshot: RelaySnapshot; access: Access; deployment: Deployment; baseUrl: string;
  onChanged: () => void | Promise<unknown>; blocked: boolean; onMigrate: () => void; onOpenTerminal?: (id: string) => void;
}) {
  const { toast } = useToast();
  const [switching, setSwitching] = useState(false);
  const [confirmMode, setConfirmMode] = useState<"tunnel" | "direct" | null>(null);
  const direct = snapshot.listenHost !== "127.0.0.1";
  const listening = snapshot.running;
  const target = access.connection;
  const receipt = deployment.lastDeploy.data;
  const deployed = !!baseUrl && receipt?.url === baseUrl;
  const disabled = blocked || switching || deployment.isPending || !listening;
  const alias = snapshot.tiers.find((t) => t.tier === "default")?.alias ?? "claude-sonnet-5-5";
  const snippet = baseUrl && snapshot.token ? buildRelaySnippet({ baseUrl, token: snapshot.token, model: alias }) : "";

  const switchMode = async (next: "tunnel" | "direct") => {
    if ((next === "direct") === direct || disabled) return;
    setSwitching(true);
    setConfirmMode(null);
    try {
      const result = await invoke<RelaySaveResult>("relay_save", { patch: { listenMode: next } });
      await onChanged();
      for (const warning of result.warnings) toast(warning, "warning");
      if (!result.warnings.length) toast(next === "direct" ? "已切到内网直连" : "已切回 SSH 隧道", "success");
    } catch (e) {
      toast(`切换失败：${String(e)}`, "error");
    } finally {
      setSwitching(false);
    }
  };

  const recover = () => {
    if (disabled || !target || !access.canReallocate) return;
    if (receipt) deployment.mutate({
      connectionId: target.id, baseUrl: "", recover: () => access.start(true), options: relayDeployOptions(receipt),
    });
    else void access.start(true);
  };

  return (
    <section className="relay-access" aria-label="远端接入步骤">
      <div className="relay-method">
        <div className="stable-method-heading">
          <h3>接入方式</h3>
          <div className="stable-method-toggle" role="group" aria-label="接入方式">
            <button type="button" aria-pressed={!direct} disabled={disabled} onClick={() => direct && setConfirmMode("tunnel")}>隧道连接<span>推荐</span></button>
            <button type="button" aria-pressed={direct} disabled={disabled} onClick={() => !direct && setConfirmMode("direct")}>内网直连</button>
          </div>
        </div>
        <p className="relay-method-note">{switching ? "正在切换接入方式…"
          : direct ? "远端使用本机内网地址访问，中转服务对同网段开放。"
          : "经 SSH 加密转发，为每个账号分配独立端口。重连会优先恢复原端口。"}</p>
      </div>
      <RelayTargetSelect id={direct ? "relay-deploy-server" : "relay-ssh-server"} access={access} direct={direct} disabled={disabled || access.pending} />
      {direct && <div className="relay-prereq" data-warn>
        <Icon name="alertTriangle" size={16} />
        <div><strong>远端须能访问本机内网地址</strong><br />令牌通过 HTTP 明文传输，防火墙需允许远端访问 <code>{snapshot.port}</code>。本机 IP 变化后须更新远端配置。</div>
      </div>}
      {direct && target && access.servers.data?.enabled && <Button size="sm" variant="outline" className="w-fit" disabled={disabled} onClick={onMigrate}>
        切隧道并重新部署
      </Button>}
      <ol className="relay-guide-steps">
        {!direct && <RelayGuideStep number={1} title="确认接入账号" complete={Boolean(target)} active={!target}>
          <p>转发、配置和验证入口都使用所选账号。</p>
        </RelayGuideStep>}
        <RelayGuideStep number={direct ? 1 : 2} title={direct ? "确认内网地址" : "建立 SSH 转发"} complete={Boolean(baseUrl)} active={!!target && !baseUrl}>
          {direct ? <code className="relay-guide-address">{baseUrl}</code>
            : <RelaySshAccess access={access} recovery={!!receipt} onRecover={recover} disabled={disabled} />}
        </RelayGuideStep>
        <RelayGuideStep number={direct ? 2 : 3} title="部署并验证" complete={deployed} active={!!baseUrl && !deployed}>
          <p>{direct ? "一键部署使用 SSH，也可以手动复制下方配置到远端。"
            : "将配置写入所选账号的家目录，然后用 Claude Code 发送一条请求。"}</p>
          {deployment.isError && deployment.variables?.connectionId === target?.id && !baseUrl &&
            <p className="relay-prereq" data-warn role="alert">{String(deployment.error)}</p>}
          {target && (baseUrl || deployment.isPending || deployment.lastDeploy.isError) && <RelayDeploy key={target.id} connection={target}
            baseUrl={baseUrl} model={alias} tokenPresent={!!snapshot.token} blocked={disabled}
            deployment={deployment} onOpenTerminal={onOpenTerminal} />}
        </RelayGuideStep>
      </ol>
      <details className="relay-manual">
        <summary>手动配置</summary>
        {snippet ? <>
          <p className="relay-method-note">在{target ? ` ${target.username}@${target.host} 的` : "远端"}终端执行。配置包含中转令牌。</p>
          <pre className="relay-code" tabIndex={0} aria-label="远端配置命令">{snippet}</pre>
        </> : <p className="relay-method-note">{baseUrl ? "生成中转令牌后可以复制配置。" : "SSH 转发就绪后可以复制配置。"}</p>}
        <Button variant="outline" size="sm" disabled={disabled || !snippet} onClick={() => void copyText(snippet,
          () => toast("已复制远端配置。", "success"), () => toast("复制失败，请手动选中复制。", "error"))}>
          <Icon name="copy" size={13} />复制远端配置
        </Button>
      </details>
      {confirmMode && <ConfirmDialog zIndex={1100} title={confirmMode === "direct" ? "切到内网直连？" : "切回 SSH 隧道？"}
        description={confirmMode === "direct"
          ? "中转会绑定到内网，同网段设备可探测端口，令牌通过 HTTP 明文传输。切换会重启中转，正在处理的请求可能中断。"
          : "切换会重启中转，正在处理的请求可能中断。远端客户端需要改用 SSH 转发地址。"}
        confirmLabel={confirmMode === "direct" ? "切到直连" : "切回隧道"}
        onCancel={() => setConfirmMode(null)} onConfirm={() => void switchMode(confirmMode)} />}
    </section>
  );
}
