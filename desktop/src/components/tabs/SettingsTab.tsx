import { useEffect, useRef, useState } from "react";
import type { StaticStatus } from "../../lib/types";
import type { SettingsSection } from "../../lib/settingsSections";
import { CATEGORY_DESCRIPTIONS } from "../../lib/settingsCategories";
import { settingsSectionForAnchor } from "../../lib/settingsNavigation";
import { useViewActive, ViewActivityContext } from "../../lib/viewActivity";
import { isWindows } from "../../lib/platform";
import { useSettingsWheelNavigation } from "../../hooks/useSettingsWheelNavigation";
import { Icon } from "../ui/icon";
import { FirewallGroup } from "./firewall/FirewallGroup";
import { AboutGroup } from "./AboutGroup";
import { NetworkGroup } from "./settings/NetworkGroup";
import { SecurityGroup } from "./settings/SecurityGroup";
import { McpBridgeGroup } from "./settings/mcpbridge/McpBridgeGroup";
import { NotifyGroup } from "./settings/NotifyGroup";
import { AdvancedGroup } from "./settings/AdvancedGroup";
import { TerminalGroup } from "./settings/TerminalGroup";
import { AppGroup } from "./settings/AppGroup";
import { InstallGroup } from "./settings/InstallGroup";
import { SettingsDataPage } from "./settings/SettingsDataPage";
import { ApplicationSettingsPreview } from "./settings/ApplicationSettingsPreview";
import "../../settings.css";

interface Props {
  status?: StaticStatus; onSaved: () => void;
  highlightAnchor?: { anchor: string; nonce: number } | null;
  unreadCount?: number; onReopenOnboarding?: () => void; onMarkSeen?: () => void;
  changelogOpenToken?: number; sections: SettingsSection[]; activeSection?: string;
  onActiveSectionChange: (id: string) => void; onNavigate?: (tab: string, anchor?: string) => void;
}

export function SettingsTab({ status, onSaved, highlightAnchor, unreadCount, onReopenOnboarding, onMarkSeen, changelogOpenToken, sections, activeSection, onActiveSectionChange, onNavigate }: Props) {
  const current = activeSection ?? sections[0]?.id;
  const [visited, setVisited] = useState<string[]>([current]);
  const root = useRef<HTMLDivElement>(null);
  const appliedAnchor = useRef<Props["highlightAnchor"]>(null);
  const active = useViewActive();
  useSettingsWheelNavigation(root, sections, current, onActiveSectionChange);
  useEffect(() => { setVisited(previous => previous.includes(current) ? previous : [...previous, current]); }, [current]);
  useEffect(() => {
    if (!active || !highlightAnchor || appliedAnchor.current === highlightAnchor) return;
    const owner = settingsSectionForAnchor(highlightAnchor.anchor);
    if (owner && owner !== current) { onActiveSectionChange(owner); return; }
    // Child subviews reveal their own target first (e.g. statistics/configuration).
    const frame = requestAnimationFrame(() => {
      // A consumed click/search target must not pull wheel navigation back to the old category.
      appliedAnchor.current = highlightAnchor;
      const panel = root.current?.querySelector<HTMLElement>(`[data-category="${CSS.escape(current)}"]`);
      const key = highlightAnchor.anchor;
      // Category panels retain their own scroll offset; only a concrete deep link scrolls.
      if (key === current) return;
      const target = panel?.querySelector<HTMLElement>(`#toggle-${CSS.escape(key)}, #${CSS.escape(key)}`);
      if (!target || !target.getClientRects().length) return;
      target.scrollIntoView({ block: "center", behavior: "auto" });
      if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [highlightAnchor, active, current, onActiveSectionChange]);

  const content = (id: string) => {
    switch (id) {
      case "set-app": return <div className="settings-page-layout"><div className="settings-reading"><AppGroup status={status} onSaved={onSaved} /><InstallGroup platform={status?.platform} onReopenOnboarding={onReopenOnboarding} /></div><ApplicationSettingsPreview /></div>;
      case "set-terminal": return <TerminalGroup status={status} onSaved={onSaved} />;
      case "set-network": return <div className="settings-reading"><NetworkGroup status={status} onSaved={onSaved} /><SecurityGroup status={status} onSaved={onSaved} onNavigate={onNavigate} section="network" />{isWindows(status?.platform) && <FirewallGroup onRefresh={onSaved} />}<AdvancedGroup status={status} onSaved={onSaved} section="network" /></div>;
      case "set-files": return <div className="settings-reading"><AdvancedGroup status={status} onSaved={onSaved} section="files" /><SecurityGroup status={status} onSaved={onSaved} onNavigate={onNavigate} section="files" /></div>;
      case "set-data": return <SettingsDataPage status={status} onSaved={onSaved} onNavigate={onNavigate} anchor={highlightAnchor} />;
      case "set-mcpbridge": return <div className="settings-reading"><McpBridgeGroup status={status} /></div>;
      case "set-notify": return <div className="settings-reading"><NotifyGroup status={status} onSaved={onSaved} /></div>;
      case "set-about": return <AboutGroup status={status} unreadCount={unreadCount} onMarkSeen={onMarkSeen} changelogOpenToken={changelogOpenToken} />;
      default: return null;
    }
  };
  return <div ref={root} className="settings-tab settings-category h-full min-h-0">
    {sections.filter(section => section.id === current || visited.includes(section.id)).map(section => <div key={section.id} data-category={section.id} hidden={section.id !== current} data-scroll-viewport className="settings-category-panel page-scroll h-full overflow-y-auto overflow-x-hidden">
      <header className="settings-page-heading"><div><h1>{section.label}</h1><p>{CATEGORY_DESCRIPTIONS[section.id]}</p></div><span><Icon name="monitor" size={14} />{["set-app", "set-terminal"].includes(section.id) ? "本机偏好" : "服务与配置"}</span></header>
      <ViewActivityContext.Provider value={active && section.id === current}>{content(section.id)}</ViewActivityContext.Provider>
    </div>)}
  </div>;
}
