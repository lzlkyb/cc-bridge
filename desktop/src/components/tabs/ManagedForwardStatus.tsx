import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { invoke } from "../../lib/tauri";
import { CONNECT_GUIDE_ANCHOR } from "../../lib/connectionAccess";
import { managedForwardLabel, type ForwardContext } from "../../lib/forwardOwnership";

export function ManagedForwardStatus({ context, onNavigate }: {
  context: ForwardContext;
  onNavigate?: (tab: string, anchor?: string) => void;
}) {
  const client = useQueryClient();
  const [opening, setOpening] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const owners = context.managed.filter((m, i, all) => all.findIndex(x => x.connectionId === m.connectionId) === i);
  const manage = async (connectionId: string) => {
    setOpening(true);
    try {
      await invoke("stable_connect_select", { method: "stable", connectionId });
      await client.invalidateQueries({ queryKey: ["stable-connect"] });
      onNavigate?.("connect", CONNECT_GUIDE_ANCHOR);
    } catch (error) {
      toast(`无法打开隧道设置：${error}`, "error");
    } finally { setOpening(false); }
  };
  if (!owners.length) return null;
  return <div aria-label="Claude Code 隧道自动管理">
    {owners.map(managed => <div key={managed.connectionId} className="fp-managed-row">
      <Icon name="plug" size={17} /><strong>Claude Code 隧道</strong>
      <span className="fp-managed-phase" aria-live="polite">{managedForwardLabel(managed)}</span>
      <span className="fp-managed-meta">固定端口 {managed.rule.listenPort} · 接入卡自动管理</span>
      <Button type="button" className="fp-text-button" variant="ghost" size="sm" aria-expanded={expanded === managed.connectionId}
        onClick={() => setExpanded(expanded === managed.connectionId ? null : managed.connectionId)}>查看接入<Icon name="chevronDown" size={14}/></Button>
      {expanded === managed.connectionId && <div className="basis-full text-sm text-muted-foreground">
        <p>{managed.message || "此转发由 Claude Code 接入管理。切换后，连接页会把这台服务器的隧道设为当前接入。"}</p>
        {onNavigate && <Button type="button" variant="outline" size="sm" className="mt-2" isLoading={opening} disabled={opening}
          onClick={() => void manage(managed.connectionId)}>切换为当前接入<Icon name="arrowRight" size={14}/></Button>}
      </div>}
    </div>)}
  </div>;
}
