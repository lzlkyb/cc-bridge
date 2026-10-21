import { useEffect, useRef } from "react";
import type { StaticStatus } from "../../lib/types";
import type { SettingsSection } from "../../lib/settingsSections";
import { useViewActive } from "../../lib/viewActivity";
import { useSettingsScrollSpy } from "../../hooks/useSettingsScrollSpy";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { FirewallGroup } from "./firewall/FirewallGroup";
import { AboutGroup } from "./AboutGroup";
import { RiskBand } from "../ui/RiskBand";
import { NetworkGroup } from "./settings/NetworkGroup";
import { SecurityGroup } from "./settings/SecurityGroup";
import { McpBridgeGroup } from "./settings/mcpbridge/McpBridgeGroup";
import { BackupAuditGroup } from "./settings/BackupAuditGroup";
import { TokenUsageGroup } from "./settings/TokenUsageGroup";
import { NotifyGroup } from "./settings/NotifyGroup";
import { AdvancedGroup } from "./settings/AdvancedGroup";
import { TerminalGroup } from "./settings/TerminalGroup";
import { AppGroup } from "./settings/AppGroup";
import { InstallGroup } from "./settings/InstallGroup";
import { ConfigGroup } from "./settings/ConfigGroup";

interface Props {
  status?: StaticStatus;
  onSaved: () => void;
  highlightAnchor?: { anchor: string; nonce: number } | null;
  unreadCount?: number;
  onReopenOnboarding?: () => void;
  onMarkSeen?: () => void;
  changelogOpenToken?: number;
  sections: SettingsSection[];
  onActiveSectionChange: (id: string) => void;
  onNavigate?: (tab: string, anchor?: string) => void;
}

export function SettingsTab({ status, onSaved, highlightAnchor, unreadCount, onReopenOnboarding, onMarkSeen, changelogOpenToken, sections, onActiveSectionChange, onNavigate }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const active = useViewActive();
  const reduced = usePrefersReducedMotion();
  const markNavigation = useSettingsScrollSpy(containerRef, onActiveSectionChange);
  useEffect(() => {
    if (!active || !highlightAnchor?.anchor) return;
    const anchor = highlightAnchor.anchor;
    const target = containerRef.current?.querySelector<HTMLElement>(`#toggle-${CSS.escape(anchor)}, #${CSS.escape(anchor)}`);
    if (!target) return;
    markNavigation();
    target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: anchor.startsWith("set-") ? "start" : "center" });
    target.classList.add("anchor-highlight");
    const timer = setTimeout(() => target.classList.remove("anchor-highlight"), 1600);
    return () => { clearTimeout(timer); target.classList.remove("anchor-highlight"); };
  }, [highlightAnchor, active, reduced, markNavigation]);

  const content = (id: string) => {
    switch (id) {
      case "set-about": return <AboutGroup status={status} unreadCount={unreadCount} onMarkSeen={onMarkSeen} changelogOpenToken={changelogOpenToken} />;
      case "set-install": return <InstallGroup platform={status?.platform} onReopenOnboarding={onReopenOnboarding} />;
      case "set-network": return <NetworkGroup status={status} onSaved={onSaved} />;
      case "set-firewall": return <FirewallGroup onRefresh={onSaved} />;
      case "set-security": return <SecurityGroup status={status} onSaved={onSaved} onNavigate={onNavigate} />;
      case "set-mcpbridge": return <McpBridgeGroup status={status} />;
      case "set-backupaudit": return <BackupAuditGroup status={status} onSaved={onSaved} onNavigate={onNavigate} />;
      case "set-tokenusage": return <TokenUsageGroup />;
      case "set-notify": return <NotifyGroup status={status} onSaved={onSaved} />;
      case "set-terminal": return <TerminalGroup />;
      case "set-app": return <AppGroup />;
      case "set-advanced": return <AdvancedGroup status={status} onSaved={onSaved} />;
      case "set-config": return <ConfigGroup status={status} onSaved={onSaved} />;
      default: return null;
    }
  };
  return (
    <div ref={containerRef} data-scroll-viewport className="page-scroll settings-tab settings-category h-full min-h-0 space-y-4 overflow-y-auto overflow-x-hidden pb-1">
      <RiskBand status={status} />
      {sections.map(section => (
        <div key={section.id} data-settings-section={section.id} className="scroll-mt-3">
          {content(section.id)}
        </div>
      ))}
    </div>
  );
}
