import { SETTINGS_SECTIONS } from "./settingsSections";
import { SETTING_SEARCH_ITEMS } from "./settingsSearch";

const owners: Record<string, string> = {
  "remote-tls": "set-security", shell: "set-security", readonly: "set-security", whitelist: "set-security",
  backup: "set-backupaudit", audit: "set-backupaudit",
  "notify-command": "set-notify", "notify-task": "set-notify",
  ratelimit: "set-advanced", encoding: "set-advanced", "session-persist": "set-advanced",
  "release-webview": "set-advanced", "ssh-drag-select": "set-advanced",
};

export function settingsSectionForAnchor(anchor: string): string | undefined {
  const key = anchor.replace(/^toggle-/, "");
  return SETTINGS_SECTIONS.find(s => s.id === key)?.id ?? owners[key];
}

/** 搜索结果复用全局命令面板索引，不建立会漂移的第二份开关定义。 */
export function searchSettings(query: string, available: string[]) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTING_SEARCH_ITEMS.filter(item => item.tab === "settings")
    .map(item => ({ ...item, sectionId: settingsSectionForAnchor(item.anchor ?? "") }))
    .filter(item => item.sectionId && available.includes(item.sectionId) && `${item.label} ${item.keywords ?? ""} ${SETTINGS_SECTIONS.find(s => s.id === item.sectionId)?.label ?? ""}`.toLowerCase().includes(q));
}
