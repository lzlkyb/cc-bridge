import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import { useToast } from "../components/ui/toast";
import { oneClickTunnel, relayDeployOptions } from "../components/relay/RelayDeploy";
import type { RelayLastDeploy } from "../lib/types";

export function useRelayDrift({ receipt, connectionId, currentUrl, direct, onRefresh, onNeedGuide }: {
  receipt?: RelayLastDeploy | null;
  connectionId?: string;
  currentUrl: string;
  direct: boolean;
  onRefresh: () => void | Promise<unknown>;
  onNeedGuide: () => void;
}) {
  const { toast } = useToast();
  const client = useQueryClient();
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const drift = direct && receipt && !receipt.url.startsWith("http://127.0.0.1:") && receipt.url !== currentUrl;

  async function change(kind: "deploy" | "tunnel") {
    if (!connectionId || stage || (kind === "deploy" && !receipt)) return;
    setStage("正在部署远端配置");
    setError("");
    try {
      if (kind === "tunnel") await oneClickTunnel(connectionId, setStage, receipt);
      else await invoke("relay_deploy_config", {
        connectionId, expectedBaseUrl: currentUrl, ...relayDeployOptions(receipt),
      });
      toast(kind === "tunnel" ? "已切到隧道并更新远端配置。" : "已按当前内网地址重新部署。", "success");
    } catch (e) {
      setError(String(e));
      toast(`操作未完成：${e}`, "error");
      onNeedGuide();
    } finally {
      await Promise.allSettled([client.invalidateQueries({ queryKey: ["relayLastDeploy", connectionId] }), onRefresh()]);
      setStage("");
    }
  }

  return { drift, stage, error, change };
}
