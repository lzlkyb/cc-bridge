import { useEffect, useState } from "react";
import type { StaticStatus } from "../../../lib/types";
import { SettingsChoice } from "../../ui/SettingsChoice";
import { BackupAuditGroup } from "./BackupAuditGroup";
import { TokenUsageGroup } from "./TokenUsageGroup";
import { ConfigGroup } from "./ConfigGroup";
import { useViewActive, ViewActivityContext } from "../../../lib/viewActivity";
import { settingsSectionForAnchor } from "../../../lib/settingsNavigation";

export function SettingsDataPage({ status, onSaved, onNavigate, anchor }: {
  status?: StaticStatus; onSaved: () => void; onNavigate?: (tab: string, anchor?: string) => void;
  anchor?: { anchor: string; nonce: number } | null;
}) {
  const [view, setView] = useState("records");
  const active = useViewActive();
  useEffect(() => {
    if (!anchor || anchor.anchor === "set-data" || settingsSectionForAnchor(anchor.anchor) !== "set-data") return;
    setView(anchor.anchor === "set-tokenusage" ? "usage" : anchor.anchor === "set-config" ? "config" : "records");
  }, [anchor]);
  // Subviews stay mounted so switching statistics never discards a policy draft.
  return <div className="settings-data-page">
    <SettingsChoice label="数据与记录视图" value={view} onChange={setView} options={[
      { value: "records", label: "备份与审计" }, { value: "usage", label: "Token 用量" }, { value: "config", label: "配置迁移" },
    ]} />
    <div hidden={view !== "records"}><BackupAuditGroup status={status} onSaved={onSaved} onNavigate={onNavigate} /></div>
    <div hidden={view !== "usage"}><ViewActivityContext.Provider value={active && view === "usage"}><TokenUsageGroup /></ViewActivityContext.Provider></div>
    <div hidden={view !== "config"}><ConfigGroup status={status} onSaved={onSaved} /></div>
  </div>;
}
