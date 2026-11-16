import type { RefObject } from "react";
import { ConnectTab } from "../../components/tabs/ConnectTab";
import { ConnectBento } from "../../components/tabs/ConnectBento";
import { useStableConnectSnapshot, stableConnectKey } from "../../hooks/useStableConnectSnapshot";
import { invokeOrToast } from "../../lib/tauri";
import { useQueryClient } from "@tanstack/react-query";
import type { StaticStatus } from "../../lib/types";
import type { McpClientTool } from "../../lib/mcpClients";
import { DiscoveryGuide } from "./DiscoveryGuide";
import type { DiscoveryScenario } from "./discovery";

export function ProposalConnectPage({ scenario, revision, status, ip, onSelectIp, refresh, onNavigate, onCopySed, anchor }: {
  scenario: DiscoveryScenario; revision: number; status: StaticStatus; ip: string;
  onSelectIp: (ip: string) => void; refresh: () => void; onNavigate: (tab: string) => void;
  onCopySed: () => Promise<boolean>; anchor: RefObject<HTMLDivElement>;
}) {
  const snapshot = useStableConnectSnapshot(status);
  const client = useQueryClient();
  const method = snapshot.data?.method ?? (new URLSearchParams(location.search).get("method") === "direct" ? "direct" : "stable");
  const proposed = method === "stable" && (status.connectClient ?? "claude-code") === "claude-code";
  const selectDirect = async (connectionId: string) => {
    await invokeOrToast("stable_connect_select", { method: "direct", connectionId });
    await client.invalidateQueries({ queryKey: stableConnectKey });
  };
  const selectTool = async (tool: McpClientTool) => {
    await invokeOrToast("save_config", { patch: { connectClient: tool } }); refresh();
  };
  return <div ref={anchor} className="qc-guide-anchor">
    {/* Retain the simulated stable setup while the user inspects the unchanged direct flow. */}
    <div style={{ display: proposed ? undefined : "none" }}>
      <ConnectBento status={status} displayHost={ip} port={status.port} onChanged={refresh} onNavigate={onNavigate}
        guide={<DiscoveryGuide key={revision} scenario={scenario} status={status} refresh={refresh} onChooseDirect={selectDirect} onToolChange={selectTool}/>}/>
    </div>
    {!proposed && <ConnectTab key={revision} status={status} onRefresh={refresh} selectedIp={ip} onSelectIp={onSelectIp}
      ipResolvedByUser={false} onSedResolved={() => {}} onNavigate={onNavigate} onCopySed={onCopySed}/>}
  </div>;
}
