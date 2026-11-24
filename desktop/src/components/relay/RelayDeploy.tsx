import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { useToast } from "../ui/toast";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import type { RelayDeployResult, SshConnectionList, TunnelStatus } from "../../lib/types";

const deployKey = "relayDeployConnectionId";

/**
 * 一键部署到远端（P1）。
 *
 * 收口三个复发问题：配置路径漂移、属主锁（claude 服务账号写 settings → ACL mask 锁登录用户）、
 * BASE_URL 不随模式变。做法：经所选 SSH 连接以**连接用户**身份，把按当前模式算好地址的
 * own-model.json 写到该用户家目录，设 ACL 让服务账号读得到，并幂等对齐 claude-own alias。
 *
 * 🔴 目标连接必须显式选（一机多实例不静默落地）；隧道模式下默认沿用接入页选的那条。
 * 🔴 不写死用户名/家目录——后端按连接用户的 $HOME 算路径，这里只回显结果。
 */
export function RelayDeploy({
  listening,
  baseUrl,
  token,
  model,
  defaultConnectionId,
}: {
  listening: boolean;
  baseUrl: string;
  token: string;
  model: string;
  defaultConnectionId?: string;
}) {
  const { toast } = useToast();
  const servers = useQuery({
    queryKey: ["sshConnections"],
    queryFn: () => invoke<SshConnectionList>("ssh_list_connections"),
    enabled: listening,
  });
  const [selected, setSelected] = useState(() => localStorage.getItem(deployKey) ?? "");
  const [svc, setSvc] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [op, setOp] = useState<{ busy: boolean; error: string; result: RelayDeployResult | null }>({
    busy: false,
    error: "",
    result: null,
  });

  if (!listening || !token) return null;

  const connections = servers.data?.connections ?? [];
  const connection = connections.find((c) => c.id === selected)
    ?? connections.find((c) => c.id === defaultConnectionId)
    ?? (connections.length === 1 ? connections[0] : undefined);
  const effectiveModel = modelInput.trim() || model;
  const preview = baseUrl
    ? JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_AUTH_TOKEN: token,
          ANTHROPIC_MODEL: effectiveModel,
        },
      }, null, 2)
    : "";

  function select(id: string) {
    setSelected(id);
    localStorage.setItem(deployKey, id);
    setOp({ busy: false, error: "", result: null });
  }

  async function deploy() {
    if (!connection || op.busy || !baseUrl) return;
    setOp({ busy: true, error: "", result: null });
    try {
      const result = await invoke<RelayDeployResult>("relay_deploy_config", {
        connectionId: connection.id,
        serviceAccount: svc.trim() || null,
        model: modelInput.trim() || null,
      });
      setOp({ busy: false, error: "", result });
      toast("已部署到远端，开新终端运行 claude-own", "success");
    } catch (e) {
      setOp({ busy: false, error: String(e), result: null });
    }
  }

  return (
    <div className="relay-deploy">
      <div className="bento-eyebrow">
        <Icon name="upload" size={12} />
        一键部署到远端
      </div>
      <p className="relay-method-note">
        经所选连接以登录用户身份写入 <code>~/.claude-own/own-model.json</code>，设 ACL 让 claude
        服务账号读得到，并对齐 <code>claude-own</code> alias。不碰全局配置，重复部署不叠行。
      </p>

      {servers.isPending ? (
        <div className="relay-prereq"><Icon name="info" size={13} /><span>正在读取 SSH 服务器…</span></div>
      ) : !servers.data?.enabled ? (
        <div className="relay-prereq"><Icon name="info" size={13} /><span>请先在设置中启用 SSH。</span></div>
      ) : !connections.length ? (
        <div className="relay-prereq"><Icon name="info" size={13} /><span>请先在终端页保存一条 SSH 服务器连接。</span></div>
      ) : (
        <>
          <div className="relay-inline relay-wrap">
            <label htmlFor="relay-deploy-server">目标连接</label>
            <select id="relay-deploy-server" value={connection?.id ?? ""} disabled={op.busy}
              onChange={(e) => select(e.target.value)}>
              {!connection && <option value="">选择服务器和账号</option>}
              {connections.map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {c.username}@{c.host}:{c.port}</option>
              ))}
            </select>
          </div>

          {!baseUrl && (
            <div className="relay-prereq" data-warn>
              <Icon name="alertTriangle" size={13} />
              <span>SSH 转发就绪后即可部署（隧道模式需先分配端口）。</span>
            </div>
          )}

          {preview && (
            <pre className="relay-code" tabIndex={0} aria-label="将写入的 own-model.json">
              {preview.split("\n").map((line, i) => (
                <span key={i} className="ln">{line || " "}</span>
              ))}
            </pre>
          )}

          <button type="button" className="relay-deploy-adv" aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}>
            <Icon name={showAdvanced ? "chevronUp" : "chevronDown"} size={12} />
            高级选项（服务账号 / 模型）
          </button>
          {showAdvanced && (
            <div className="relay-deploy-adv-body">
              <label className="relay-inline relay-wrap">
                服务账号
                <input value={svc} placeholder="留空自动探测" autoComplete="off"
                  onChange={(e) => setSvc(e.target.value)} />
              </label>
              <small>claude 以哪个系统账号运行（如 claude-svc）。留空则从远端 wrapper 探测；仅用于授读权限。</small>
              <label className="relay-inline relay-wrap">
                模型
                <input value={modelInput} placeholder={model} autoComplete="off"
                  onChange={(e) => setModelInput(e.target.value)} />
              </label>
            </div>
          )}

          <div className="relay-actions">
            <Button size="sm" isLoading={op.busy} loadingText="部署中…"
              disabled={!connection || !baseUrl || op.busy} onClick={() => void deploy()}>
              <Icon name="upload" size={13} />
              部署到远端
            </Button>
            {op.error && <span className="relay-deploy-error">{op.error}</span>}
          </div>

          {op.result && (
            <div className="relay-deploy-result" role="status">
              <span className="relay-work-badge" data-tone="ok"><Icon name="check" size={12} />已部署</span>
              <span>配置文件：<code>{op.result.file}</code></span>
              <span>服务账号：<code>{op.result.serviceAccount || "未探测到（仅登录用户可读）"}</code></span>
              <span>alias：<code>{op.result.alias}</code></span>
              <span className="relay-deploy-hint">
                <Icon name="terminal" size={12} />
                在远端<b>开一个新终端</b>运行 <code>claude-own</code> 即可生效——旧终端不会自动加载 alias。
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs: number, stepMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(stepMs);
  }
}

/**
 * P2 一键切隧道：切模式 → 等中转重启到回环 → 建 SSH 转发 → 等端口 → 重新部署。
 * 落到固定回环地址后本机 IP 变化不再影响远端。任一步失败抛错，由调用方提示并引导去接入指南。
 */
export async function oneClickTunnel(connectionId: string): Promise<RelayDeployResult> {
  await invoke("relay_save", { patch: { listenMode: "tunnel" } });
  // 中转重启到回环需要时间；relay_tunnel_start 在未就绪时报错，重试到它就绪。
  await until(async () => {
    try {
      await invoke("relay_tunnel_start", { connectionId, password: null, passphrase: null, reallocate: false });
      return true;
    } catch {
      return undefined;
    }
  }, 20000);
  await until(async () => {
    const list = await invoke<TunnelStatus[]>("ssh_tunnel_list");
    const t = list.find((x) => x.connectionId === `relay:${connectionId}`);
    const r = t?.rules[0];
    return t?.state === "up" && r?.state === "listening" ? (r.boundPort || r.rule.listenPort) : undefined;
  }, 45000);
  return invoke<RelayDeployResult>("relay_deploy_config", { connectionId, serviceAccount: null, model: null });
}