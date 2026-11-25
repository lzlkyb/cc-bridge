import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTunnelStatus } from "../../lib/sshTunnelStore";
import { invoke } from "../../lib/tauri";
import type { SshConnectionList } from "../../lib/types";
import { Button } from "../ui/button";

const selectionKey = "relaySshConnectionId";

export function useRelaySshAccess(enabled: boolean) {
  const servers = useQuery({
    queryKey: ["sshConnections"],
    queryFn: () => invoke<SshConnectionList>("ssh_list_connections"),
    enabled,
  });
  const [selected, setSelected] = useState(() => localStorage.getItem(selectionKey) ?? localStorage.getItem("relayDeployConnectionId") ?? "");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const connections = servers.data?.connections ?? [];
  const connection = connections.find((item) => item.id === selected)
    ?? (connections.length === 1 ? connections[0] : undefined);
  const tunnel = useTunnelStatus(connection ? `relay:${connection.id}` : "");
  const rule = tunnel?.rules[0];
  const port = tunnel?.state === "up" && rule?.state === "listening"
    ? rule.boundPort || rule.rule.listenPort
    : 0;
  const busy = pending || tunnel?.state === "connecting" || tunnel?.state === "reconnecting"
    || (tunnel?.state === "up" && !port);
  const needsSecret = !!tunnel?.needsSecret && !tunnel.needsJumpSecret;
  const needsKey = connection?.authType === "key";
  const canReallocate = !tunnel?.needsSecret
    && (tunnel?.state === "error" || tunnel?.state === "reconnecting")
    && rule?.state === "failed" && rule.rule.listenPort > 0;

  function select(id: string) {
    setSelected(id);
    setSecret("");
    setError("");
    localStorage.setItem(selectionKey, id);
  }

  async function start(reallocate = false) {
    if (!connection || pending || (reallocate ? !canReallocate : busy)) return false;
    setPending(true);
    setError("");
    const supplied = needsSecret ? secret : "";
    setSecret("");
    localStorage.setItem(selectionKey, connection.id);
    try {
      await invoke("relay_tunnel_start", {
        connectionId: connection.id,
        password: needsKey ? null : supplied || null,
        passphrase: needsKey ? supplied || null : null,
        reallocate,
      });
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setPending(false);
    }
  }

  return { servers, connection, connections, select, secret, setSecret, needsSecret, needsKey,
    port, busy, pending, tunnel, canReallocate, error, start };
}

const phaseLabels: Record<string, string> = {
  ssh: "连接 SSH 服务器", auth: "等待 SSH 认证",
  forward: "正在建立端口转发", confirm: "正在确认远端端口",
};

export function relayTunnelLabel(access: ReturnType<typeof useRelaySshAccess>) {
  const { tunnel, port, busy, error, canReallocate } = access;
  if (port) return "SSH 转发已就绪";
  if (tunnel?.needsSecret) return "需要 SSH 凭据";
  if (canReallocate) return "原端口绑定失败";
  if (tunnel?.state === "reconnecting") return "SSH 正在重连";
  if (busy) return phaseLabels[tunnel?.phase ?? ""] ?? "正在建立 SSH 转发";
  if (tunnel?.state === "error" || error) return "SSH 转发失败";
  return "等待建立 SSH 转发";
}

type Access = ReturnType<typeof useRelaySshAccess>;

export function RelayTargetSelect({ access, id, disabled, direct = false }: {
  access: Access; id: string; disabled?: boolean; direct?: boolean;
}) {
  const { servers, connections, connection, select } = access;
  return (
    <div className="relay-target-select">
      <label htmlFor={id}>{direct ? "部署目标 / SSH 账号" : "服务器 / SSH 账号"}</label>
      <select id={id} value={connection?.id ?? ""} disabled={disabled || !servers.data?.enabled || !connections.length}
        onChange={(event) => select(event.target.value)}>
        {!connection && <option value="">{servers.isPending ? "正在读取服务器…" : "选择服务器和账号"}</option>}
        {connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.username}@{item.host}:{item.port}</option>)}
      </select>
    </div>
  );
}

export function RelaySshSetup({ access, onManage, optional }: { access: Access; onManage?: (anchor?: string) => void; optional?: boolean }) {
  const { servers, connections } = access;
  if (!servers.data || (servers.data.enabled && connections.length)) return null;
  const enabled = servers.data.enabled;
  return <div className="relay-prereq"><div className="relay-inline relay-wrap relay-spread">
    <span>{optional ? "一键部署需要 SSH，也可手动复制远端配置。" : enabled ? "添加服务器后即可选择接入账号。" : "先启用 SSH，再保存服务器连接。"}</span>
    {onManage && <Button size="sm" variant="outline" onClick={() => onManage(enabled ? "relay-ssh-new" : undefined)}>{enabled ? "添加服务器" : "前往启用 SSH"}</Button>}
  </div></div>;
}

export function RelaySshAccess({ access, recovery, onRecover, disabled, onManage }: {
  access: Access; recovery?: boolean; onRecover: () => void; disabled?: boolean; onManage?: (anchor?: string) => void;
}) {
  const { servers, connections, connection, tunnel, busy, port } = access;
  if (servers.isPending) return <p className="relay-method-note" role="status">正在读取 SSH 服务器…</p>;
  if (servers.isError) return <div className="relay-inline relay-wrap" role="alert">
    <span>读取 SSH 服务器失败。</span><Button size="sm" variant="outline" onClick={() => void servers.refetch()}>重试读取</Button>
  </div>;
  if (!servers.data?.enabled || !connections.length) return <RelaySshSetup access={access} onManage={onManage} />;

  const connecting = busy && !port;
  const oldPort = tunnel?.rules[0]?.rule.listenPort;
  const failure = tunnel?.state === "error" || access.error || access.canReallocate;
  const retry = tunnel?.state === "error" || Boolean(access.error);
  return (
    <div className="relay-ssh-access">
      <div className="relay-inline relay-wrap" role="status">
        <span className="relay-work-badge" data-tone={port ? "ok" : failure || tunnel?.state === "reconnecting" ? "warn" : "accent"}>
          {connecting && <span className="relay-access-spinner" aria-hidden="true" />}{relayTunnelLabel(access)}
        </span>
        {port > 0 ? <code>远端 127.0.0.1:{port}</code> : Boolean(oldPort) && <small>原端口 {oldPort}</small>}
        {tunnel?.state === "reconnecting" && tunnel.attempt != null && <small>第 {tunnel.attempt} 次尝试</small>}
      </div>
      {access.canReallocate && <small>仍会尝试恢复原端口。改用新端口后，远端配置需要更新。</small>}
      {access.needsSecret && (
        <label className="relay-inline relay-wrap">
          {access.needsKey ? "SSH 密钥口令" : "SSH 密码"}
          <input type="password" value={access.secret} autoComplete="off" onChange={(event) => access.setSecret(event.target.value)} />
        </label>
      )}
      {tunnel?.needsJumpSecret && <div className="relay-inline relay-wrap"><small>请保存跳板机的登录凭据，再重试。</small>
        {onManage && connection?.proxyJumpId && <Button size="sm" variant="outline" onClick={() => onManage(`relay-ssh-edit:${connection.proxyJumpId}`)}>补充跳板机凭据</Button>}
      </div>}
      {!port && (access.error || tunnel?.message || tunnel?.lastFailure) && <small>{access.error || tunnel?.message || tunnel?.lastFailure}</small>}
      {connection && !port && <div className="relay-inline relay-wrap">
        {(!connecting || retry) && <Button size="sm" disabled={disabled || busy || (access.needsSecret && !access.secret) || tunnel?.needsJumpSecret}
          onClick={() => void access.start()}>{retry ? "重试连接" : "建立 SSH 转发"}</Button>}
        {access.canReallocate && <Button size="sm" variant={recovery ? "default" : "outline"} onClick={onRecover} disabled={disabled || access.pending}>
          {recovery ? "重新分配并部署" : "重新分配端口"}
        </Button>}
      </div>}
    </div>
  );
}
