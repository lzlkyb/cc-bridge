import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTunnelStatus } from "../../lib/sshTunnelStore";
import { invoke } from "../../lib/tauri";
import type { SshConnectionList } from "../../lib/types";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

const selectionKey = "relaySshConnectionId";

export function useRelaySshAccess(enabled: boolean) {
  const servers = useQuery({
    queryKey: ["sshConnections"],
    queryFn: () => invoke<SshConnectionList>("ssh_list_connections"),
    enabled,
  });
  const [selected, setSelected] = useState(() => localStorage.getItem(selectionKey) ?? "");
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
    if (!connection || pending || (reallocate ? !canReallocate : busy)) return;
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
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }

  return { servers, connection, connections, select, secret, setSecret, needsSecret, needsKey,
    port, busy, pending, tunnel, canReallocate, error, start };
}

export function RelaySshAccess({ access, listening }: {
  access: ReturnType<typeof useRelaySshAccess>;
  listening: boolean;
}) {
  const { servers, connections, connection, tunnel, busy, port } = access;
  if (!listening || servers.isPending || servers.isError || !servers.data?.enabled || !connections.length) {
    return (
      <div className="relay-prereq">
        <Icon name="info" size={13} />
        <span>{!listening ? "启动中转后可以建立 SSH 隧道。"
          : servers.isPending ? "正在读取 SSH 服务器…"
          : servers.isError ? "读取 SSH 服务器失败，请重新打开接入指南。"
          : !servers.data?.enabled ? "请先在设置中启用 SSH。"
          : "请先在终端页保存一条 SSH 服务器连接。"}</span>
      </div>
    );
  }

  const status = port ? "SSH 转发已就绪"
    : tunnel?.state === "reconnecting" || (busy && tunnel?.disconnectedAt) ? "SSH 正在重连"
    : busy ? "正在建立 SSH 转发"
    : tunnel?.state === "error" || access.error ? "SSH 转发失败"
    : "等待建立 SSH 转发";

  return (
    <div className="relay-prereq relay-ssh-access">
      <div className="relay-inline relay-wrap">
        <label htmlFor="relay-ssh-server">SSH 服务器</label>
        <select id="relay-ssh-server" value={connection?.id ?? ""} disabled={access.pending}
          onChange={(event) => access.select(event.target.value)}>
          {!connection && <option value="">选择服务器和账号</option>}
          {connections.map((item) => (
            <option key={item.id} value={item.id}>{item.name} · {item.username}@{item.host}:{item.port}</option>
          ))}
        </select>
      </div>
      <div className="relay-inline relay-wrap" role="status">
        <span className="relay-work-badge" data-tone={port ? "ok" : tunnel?.state === "error" || access.error ? "warn" : "accent"}>{status}</span>
        {port > 0 && <code>远端 127.0.0.1:{port}</code>}
        {(access.error || tunnel?.message) && <span>{access.error || tunnel?.message}</span>}
      </div>
      {access.needsSecret && (
        <label className="relay-inline relay-wrap">
          {access.needsKey ? "SSH 密钥口令" : "SSH 密码"}
          <input type="password" value={access.secret} autoComplete="off" onChange={(event) => access.setSecret(event.target.value)} />
        </label>
      )}
      {tunnel?.needsJumpSecret && <small>请在终端页保存跳板机的登录凭据，再重试。</small>}
      {connection && !port && (
        <div className="relay-inline relay-wrap">
          <Button size="sm" variant="outline" disabled={busy || (access.needsSecret && !access.secret)}
            onClick={() => void access.start()}>
            {tunnel?.state === "error" ? "重试连接" : "建立 SSH 转发"}
          </Button>
          {access.canReallocate && <Button size="sm" variant="outline" onClick={() => void access.start(true)} disabled={access.pending}>重新分配端口</Button>}
          {access.canReallocate && <small>端口变更后，请重新复制远端配置。</small>}
        </div>
      )}
    </div>
  );
}
