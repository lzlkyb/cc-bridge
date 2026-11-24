import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/tauri";
import { useToast } from "../components/ui/toast";
import { oneClickTunnel } from "../components/relay/RelayDeploy";
import type { RelayLastDeploy } from "../lib/types";

/**
 * P1 漂移自救：上次部署地址与当前直连地址不一致 ⇒ 远端还指旧 IP。
 * 提供「一键重新部署」与「一键切隧道（切模式＋建转发＋重部署）」两个显式动作。
 * 抽成 hook 是为把 RelayTab 的状态数压回门禁上限（互相牵扯的异步态集中在这里）。
 */
export function useRelayDrift({
  running,
  direct,
  listenHost,
  port,
  onRefresh,
  onNeedGuide,
}: {
  running: boolean;
  direct: boolean;
  listenHost: string;
  port: number;
  onRefresh: () => void | Promise<unknown>;
  onNeedGuide: () => void;
}) {
  const { toast } = useToast();
  const lastDeploy = useQuery({
    queryKey: ["relayLastDeploy"],
    queryFn: () => invoke<RelayLastDeploy | null>("relay_last_deploy"),
    enabled: running,
  });
  const currentUrl = direct ? `http://${listenHost}:${port}` : "";
  const drift = direct && !!lastDeploy.data && lastDeploy.data.url !== currentUrl;
  const [busy, setBusy] = useState<"" | "deploy" | "tunnel">("");

  const redeploy = async () => {
    if (!lastDeploy.data || busy) return;
    setBusy("deploy");
    try {
      await invoke("relay_deploy_config", { connectionId: lastDeploy.data.connectionId, serviceAccount: null, model: null });
      toast("已按当前地址重新部署远端配置。", "success");
      await lastDeploy.refetch();
      await onRefresh();
    } catch (e) {
      toast(`重新部署失败：${String(e)}`, "error");
    } finally {
      setBusy("");
    }
  };

  const goTunnel = async () => {
    if (!lastDeploy.data || busy) return;
    setBusy("tunnel");
    try {
      const r = await oneClickTunnel(lastDeploy.data.connectionId);
      toast(`已切隧道并部署，固定地址 ${r.baseUrl}，IP 变化不再影响。`, "success");
      await lastDeploy.refetch();
      await onRefresh();
    } catch (e) {
      toast(`切隧道未完成：${String(e)}。可在接入指南手动完成。`, "error");
      onNeedGuide();
    } finally {
      setBusy("");
    }
  };

  return { lastDeploy, currentUrl, drift, busy, redeploy, goTunnel };
}