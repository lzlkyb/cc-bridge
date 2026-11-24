import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import { useToast } from "../ui/toast";
import { Button } from "../ui/button";
import { Collapse } from "../ui/Collapse";
import { Icon } from "../ui/icon";
import type { RelayDeployResult, RelayLastDeploy, SshConnection, TunnelStatus } from "../../lib/types";

type DeployOptions = { serviceAccount: string | null; model: string | null };

export function useRelayDeployment(connectionId: string | undefined, active: boolean) {
  const client = useQueryClient();
  const lastDeploy = useQuery({
    queryKey: ["relayLastDeploy", connectionId],
    enabled: active && !!connectionId,
    queryFn: async () => {
      const receipt = await invoke<RelayLastDeploy | null>("relay_last_deploy", { connectionId });
      return receipt?.connectionId === connectionId ? receipt : null;
    },
  });
  const mutation = useMutation({
    mutationFn: async (args: {
      connectionId: string; baseUrl: string; options: DeployOptions; recover?: () => Promise<boolean>;
    }) => {
      let baseUrl = args.baseUrl;
      if (args.recover) {
        if (!await args.recover()) throw new Error("未能重新分配端口，请查看 SSH 状态。");
        baseUrl = `http://127.0.0.1:${await waitForRelayPort(args.connectionId)}`;
      }
      return deployRelayConfig(args.connectionId, baseUrl, args.options);
    },
    onSuccess: (result, args) => {
      client.setQueryData<RelayLastDeploy>(["relayLastDeploy", args.connectionId], {
        url: result.baseUrl, connectionId: args.connectionId, file: result.file, ...args.options,
      });
    },
  });
  return { lastDeploy, ...mutation };
}

export const relayDeployOptions = (receipt?: RelayLastDeploy | null): DeployOptions => ({
  serviceAccount: receipt?.serviceAccount || null,
  model: receipt?.model || null,
});

function deployRelayConfig(connectionId: string, baseUrl: string, options: DeployOptions) {
  return invoke<RelayDeployResult>("relay_deploy_config", { connectionId, expectedBaseUrl: baseUrl, ...options });
}

export function RelayDeploy({ connection, baseUrl, model, tokenPresent, blocked, deployment, onOpenTerminal }: {
  connection: SshConnection;
  baseUrl: string;
  model: string;
  tokenPresent: boolean;
  blocked: boolean;
  deployment: ReturnType<typeof useRelayDeployment>;
  onOpenTerminal?: (connectionId: string) => void;
}) {
  const { toast } = useToast();
  const [svc, setSvc] = useState<string>();
  const [modelInput, setModelInput] = useState<string>();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const last = deployment.lastDeploy.data;
  const deployed = last && last.url === baseUrl;
  const result = deployment.variables?.connectionId === connection.id && deployment.data?.baseUrl === baseUrl ? deployment.data : undefined;
  const serviceAccount = svc ?? last?.serviceAccount ?? "";
  const selectedModel = modelInput ?? last?.model ?? "";
  const busy = deployment.isPending;
  const pendingOptions = serviceAccount !== (last?.serviceAccount ?? "") || selectedModel !== (last?.model ?? "");

  function deploy() {
    if (!baseUrl || busy || blocked) return;
    deployment.mutate({
      connectionId: connection.id, baseUrl, options: {
        serviceAccount: serviceAccount.trim() || null, model: selectedModel.trim() || null,
      },
    }, { onSuccess: () => toast("已部署到远端，开新终端运行 claude-own", "success") });
  }
  return (
    <div className="relay-deploy">
      {deployment.lastDeploy.isError && <div className="relay-inline relay-wrap" role="alert">
        <small>读取部署记录失败。</small><Button size="sm" variant="outline" onClick={() => void deployment.lastDeploy.refetch()}>重试读取</Button>
      </div>}
      {deployment.variables?.connectionId === connection.id && deployment.isError &&
        <div className="relay-prereq" data-warn role="alert">部署未完成。{String(deployment.error)}</div>}
      {last && baseUrl && !deployed && <p className="relay-prereq" data-warn>远端上次配置使用 <code>{last.url}</code>。请更新为当前地址。</p>}
      <button type="button" className="relay-deploy-adv" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
        <Icon name={showAdvanced ? "chevronUp" : "chevronDown"} size={12} />高级选项（服务账号 / 模型）
      </button>
      <Collapse open={showAdvanced}>
        <div className="relay-deploy-adv-body">
          <label className="relay-inline relay-wrap">服务账号
            <input value={serviceAccount} placeholder="留空自动探测" autoComplete="off" onChange={(e) => setSvc(e.target.value)} />
          </label>
          <small>仅用于给运行 Claude Code 的系统账号授予读取权限。</small>
          <label className="relay-inline relay-wrap">模型
            <input value={selectedModel} placeholder={model} autoComplete="off" onChange={(e) => setModelInput(e.target.value)} />
          </label>
        </div>
      </Collapse>
      {deployed && <div className="relay-deploy-result">
        <span className="relay-work-badge" data-tone="ok"><Icon name="check" size={12} />配置已部署</span>
        {(result?.file || last.file) && <span>配置文件 <code>{result?.file || last.file}</code></span>}
        {result?.serviceAccount && <span>服务账号 <code>{result.serviceAccount}</code></span>}
        <span className="relay-deploy-hint"><Icon name="terminal" size={12} />
          在远端开一个新终端运行 <code>claude-own</code>，发送一条请求后查看「最近请求」。
        </span>
      </div>}
      <div className="relay-actions">
        {deployed && onOpenTerminal && <Button size="sm" disabled={blocked || busy} onClick={() => onOpenTerminal(connection.id)}>
          <Icon name="terminal" size={14} />打开远端终端
        </Button>}
        <Button size="sm" variant={deployed && onOpenTerminal && !pendingOptions ? "outline" : "default"}
          isLoading={busy} loadingText="正在部署配置" disabled={!tokenPresent || !baseUrl || blocked || !deployment.lastDeploy.isSuccess}
          onClick={deploy}><Icon name="upload" size={13} />{deployed ? "重新部署" : "部署到远端"}</Button>
      </div>
    </div>
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRelayPort(connectionId: string): Promise<number> {
  const deadline = Date.now() + 45_000;
  do {
    const list = await invoke<TunnelStatus[]>("ssh_tunnel_list");
    const tunnel = list.find((item) => item.connectionId === `relay:${connectionId}`);
    const rule = tunnel?.rules[0];
    if (tunnel?.state === "up" && rule?.state === "listening") {
      const port = rule.boundPort || rule.rule.listenPort;
      if (port) return port;
    }
    if (tunnel?.needsSecret || tunnel?.state === "error") {
      throw new Error(tunnel.message || tunnel.lastFailure || "SSH 转发未就绪，请在接入指南中处理。");
    }
    await sleep(750);
  } while (Date.now() < deadline);
  throw new Error("等待远端端口超时。可在转发就绪后重试部署。");
}

export async function oneClickTunnel(connectionId: string, onStage: (stage: string) => void,
  receipt?: RelayLastDeploy | null): Promise<RelayDeployResult> {
  onStage("正在切换监听方式");
  const result = await invoke<{ warnings: string[] }>("relay_save", { patch: { listenMode: "tunnel" } });
  if (result.warnings.length) throw new Error(result.warnings.join("；"));
  onStage("正在建立 SSH 转发");
  await invoke("relay_tunnel_start", { connectionId, password: null, passphrase: null, reallocate: false });
  const port = await waitForRelayPort(connectionId);
  onStage("正在部署远端配置");
  return deployRelayConfig(connectionId, `http://127.0.0.1:${port}`, relayDeployOptions(receipt));
}
