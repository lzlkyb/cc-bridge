import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { StableConnectState } from "../../../hooks/useStableConnect";
import type { StableAccessState } from "../../../hooks/useStableAccess";
import { useStableConnectSnapshot } from "../../../hooks/useStableConnectSnapshot";
import { copyText, type McpScope } from "../../../lib/utils";
import { toast } from "../../../components/ui/toast";
import { initialDiscovery } from "../discovery";
import { invoke, previewConnections, resetPreviewConnections, status as sampleStatus } from "../mock";
import { prepareLinkageFixture, productionPreviewQuery, recoverLinkageFixture } from "../production-fixture";
import { connectionSummary, evidenceKey, type AccessEvidence, type LinkageScenario } from "./model";

const originalToken = "PREVIEW_ONLY_NOT_A_SECRET";
let seedEvidence: AccessEvidence | null = null;
export function seedLinkagePreview(preset: LinkageScenario) {
  document.title = "CC Bridge · 连接页面全入口联动设计稿";
  document.documentElement.dataset.connectionLinkage = "true";
  document.documentElement.dataset.quickConnect = "true";
  resetPreviewConnections(false);
  prepareLinkageFixture(preset);
  const projectPath = initialDiscovery("existing-project", "cloud").entries[0].projectPath;
  Object.assign(sampleStatus, { running: true, token: preset === "changed" ? "PREVIEW_ONLY_UPDATED_TOKEN" : originalToken,
    scope: "project", projectPath, ipChanged: preset === "recovery" || preset === "ip-changed", lastSelectedIp: preset === "ip-changed" ? "10.203.5.36" : "192.168.31.81",
    lanIps: preset === "recovery" || preset === "ip-changed" ? ["192.168.31.81", "10.203.5.58"] : ["192.168.31.81", "10.203.5.36"], remoteReachable: true, connectClient: "claude-code",
    stats: { ...sampleStatus.stats, totalRequests: 146, totalErrors: 1, successRate: 99.3, requestsPerMin: 0, avgLatencyMs: 18, p95LatencyMs: 42, activeCommands: 0 } });
  seedEvidence = preset === "setup" || preset === "server" ? null : { method: preset === "direct" || preset === "ip-changed" ? "direct" : "stable", connectionId: preset === "direct" || preset === "ip-changed" ? "direct" : "cloud",
    address: preset === "direct" ? "http://192.168.31.81:7823/mcp" : preset === "ip-changed" ? "http://10.203.5.36:7823/mcp" : "http://127.0.0.1:7823/mcp", scope: "project", projectPath, token: originalToken };
}
export const initialLinkageScenario = (): LinkageScenario => {
  const requested = productionPreviewQuery().get("scenario") ?? "verified";
  return ["verified", "waiting", "setup", "recovery", "paused", "changed", "login", "server", "direct", "ip-changed"].includes(requested) ? requested as LinkageScenario : "verified";
};

function useLinkageController(preset: LinkageScenario) {
  const client = useQueryClient();
  const [status, setStatus] = useState({ ...sampleStatus });
  const [ip, setSelectedIp] = useState(preset === "ip-changed" ? "10.203.5.58" : "192.168.31.81");
  const [applied, setApplied] = useState(seedEvidence);
  const [verifiedKey, setVerifiedKey] = useState(preset === "verified" || preset === "direct" ? seedEvidence && evidenceKey(seedEvidence) : null);
  const [directDraft, setDirectDraft] = useState({ scope: "project" as McpScope, projectPath: sampleStatus.projectPath ?? "" });
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [pendingScope, setPendingScope] = useState(false);
  const [copied, setCopied] = useState("");
  const [serviceBusy, setServiceBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const snapshot = useStableConnectSnapshot(status);
  const stableApi = useRef<StableConnectState | null>(null);
  const accessApi = useRef<StableAccessState | null>(null);
  const guideAnchor = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const method = snapshot.data?.method ?? (preset === "direct" || preset === "ip-changed" ? "direct" : "stable");
  const connectionId = snapshot.data?.selectedConnectionId ?? (preset === "server" ? "dev" : "cloud");
  const record = snapshot.data?.connections.find(c => c.connectionId === connectionId);
  const summary = connectionSummary({ method, connectionId, serverName: previewConnections.find(c => c.id === connectionId)?.name ?? "服务器",
    record, status, ip, directScope: directDraft.scope, directPath: directDraft.projectPath, applied, verifiedKey, copiedCommand, pendingChange: pendingScope });
  const previousPhase = useRef({ connectionId, phase: record?.phase });
  const targetKey = evidenceKey(summary.target);
  const refresh = () => { setStatus({ ...sampleStatus }); client.setQueryData(["status"], { ...sampleStatus }); };
  useEffect(() => { setCopied(""); setCopiedCommand(false); clearTimeout(copyTimer.current); }, [targetKey]);
  useEffect(() => {
    const previous = previousPhase.current;
    previousPhase.current = { connectionId, phase: record?.phase };
    if (record?.phase === "ready" && previous.phase === "running" && previous.connectionId === connectionId) {
      setApplied({ method: "stable", connectionId, address: `http://127.0.0.1:${record.port}/mcp`, scope: record.target?.scope ?? record.scope,
        projectPath: record.target?.projectPath ?? record.projectPath, token: status.token });
      setVerifiedKey(null);
    }
  }, [connectionId, record?.phase, record?.port, record?.scope, record?.projectPath, record?.target, status.token]);
  useEffect(() => {
    const listener = () => { setStatus({ ...sampleStatus }); client.setQueryData(["status"], { ...sampleStatus }); };
    window.addEventListener("quick-preview-config-changed", listener);
    return () => { window.removeEventListener("quick-preview-config-changed", listener); clearTimeout(copyTimer.current); };
  }, [client]);
  const focusGuide = (manage = false) => {
    setSearchOpen(false); setTrayOpen(false);
    if (manage && summary.stable) stableApi.current?.update({ managing: true });
    requestAnimationFrame(() => {
      const card = guideAnchor.current?.querySelector(".card-primary");
      card?.scrollIntoView({ block: "start", behavior: "auto" });
      const heading = card?.querySelector<HTMLElement>(".stable-method-toggle button[aria-pressed=true]");
      heading?.focus({ preventScroll: true });
    });
  };
  const selectIp = (next: string, byUser = false) => {
    if (summary.stable && !byUser) return;
    setSelectedIp(next); setCopiedCommand(false); setVerifiedKey(null);
  };
  const toggleService = async (restart = false) => {
    if (serviceBusy) return;
    setServiceBusy(true);
    try {
      if (restart) { await invoke("stop_mcp_server"); refresh(); await new Promise(resolve => setTimeout(resolve, 400)); }
      else await new Promise(resolve => setTimeout(resolve, 350));
      await invoke(restart || !status.running ? "start_mcp_server" : "stop_mcp_server");
      refresh();
      if (restart) toast("本机服务已重启，当前隧道的暂停设置保留。", "success");
    } finally { setServiceBusy(false); }
  };
  const copy = async (kind: "address" | "command" | "ip") => {
    const text = kind === "address" ? summary.address : kind === "ip" ? summary.ipCommand : summary.command;
    if (!text || kind === "command" && !summary.canCopyCommand || kind === "ip" && summary.stable) { focusGuide(); return false; }
    let success = false;
    await copyText(text, () => { success = true; setCopied(kind); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(""), 2200); }, error => toast(`复制失败：${error}`, "error"));
    if (success && !summary.stable && kind !== "address") { setCopiedCommand(true); setVerifiedKey(null); }
    return success;
  };
  const primary = () => {
    if (!status.running) { void toggleService(); return; }
    if (!summary.stable && (summary.state === "setup" || summary.state === "changed")) { void copy("command"); return; }
    if (summary.state === "ip-changed") { void copy("ip"); return; }
    if (summary.state === "paused") { void stableApi.current?.start(); return; }
    if (summary.state === "verified" || summary.state === "waiting" || summary.state === "copied") {
      toast(summary.verified ? "当前目标已有客户端调用证据，配置与接入地址一致。" : "接入配置已核实。请重新打开 Claude Code，等待当前接入的客户端调用。", "info");
      return;
    }
    focusGuide(summary.state !== "recovery");
    if (summary.state === "changed") accessApi.current?.retry();
  };
  const simulateCall = () => {
    if (!summary.channelReady || summary.stable && (!summary.configured || summary.changed)) return;
    setApplied(summary.target); setVerifiedKey(evidenceKey(summary.target)); setCopiedCommand(false);
    Object.assign(sampleStatus, { ipChanged: summary.stable ? sampleStatus.ipChanged : false, lastSelectedIp: summary.stable ? sampleStatus.lastSelectedIp : ip });
    refresh();
    toast("已模拟当前接入的 Claude Code 调用，所有入口已同步。", "success");
  };
  const recoverNetwork = () => { recoverLinkageFixture(); toast("已模拟 VPN 恢复，继续沿用原固定地址。", "success"); };
  const pause = () => { void stableApi.current?.stop(); setTrayOpen(false); };
  const bindDirectDraft = (scope: McpScope, projectPath: string) => setDirectDraft(old => old.scope === scope && old.projectPath === projectPath ? old : { scope, projectPath });
  return { preset, summary, status, record, ip, applied, copied, serviceBusy, searchOpen, setSearchOpen, trayOpen, setTrayOpen,
    stableApi, accessApi, guideAnchor, refresh, focusGuide, selectIp, toggleService, copy, primary, simulateCall, recoverNetwork, pause, bindDirectDraft, setPendingScope };
}
export type LinkageController = ReturnType<typeof useLinkageController>;
const LinkageContext = createContext<LinkageController | null>(null);
export const useOptionalLinkage = () => useContext(LinkageContext);
export function useLinkage() { const context = useOptionalLinkage(); if (!context) throw new Error("联动设计稿需要上下文"); return context; }
export function LinkageProvider({ preset, children }: { preset: LinkageScenario; children: ReactNode }) {
  return <LinkageContext.Provider value={useLinkageController(preset)}>{children}</LinkageContext.Provider>;
}
