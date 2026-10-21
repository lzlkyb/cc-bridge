import type { SettingsSection } from "./settingsSections";
import { SETTING_SEARCH_ITEMS } from "./settingsSearch";
import { SETTINGS_CATEGORIES, SETTINGS_ANCHOR_CATEGORIES } from "./settingsCategories";
import { isWindows } from "./platform";

export function settingsSectionForAnchor(anchor: string): string | undefined {
  const key = anchor.replace(/^toggle-/, "");
  return SETTINGS_CATEGORIES.find(s => s.id === key)?.id ?? SETTINGS_ANCHOR_CATEGORIES[key];
}

/** 搜索结果复用全局命令面板索引，不建立会漂移的第二份开关定义。 */
export function searchSettings(query: string, available: string[], platform?: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTING_SEARCH_ITEMS.filter(item => item.tab === "settings")
    .filter(item => item.id !== "set-firewall" || isWindows(platform))
    .map(item => ({ ...item, sectionId: settingsSectionForAnchor(item.anchor ?? "") }))
    .map(item => ({ ...item, group: `设置 · ${SETTINGS_CATEGORIES.find(s => s.id === item.sectionId)?.label ?? item.group}` }))
    .filter(item => item.sectionId && available.includes(item.sectionId) && `${item.label} ${item.keywords ?? ""} ${SETTINGS_CATEGORIES.find(s => s.id === item.sectionId)?.label ?? ""}`.toLowerCase().includes(q));
}

/**
 * 滚轮换区的步进目标（SideNavSettings 的滚轮 handler 用，纯函数便于单测）。
 *
 * 传入**已按平台过滤、导航顺序**的 sections（与目录渲染同源）；activeId 不在
 * 列表里（scrollspy 过渡帧）或已到端点时返回 null——handler 据此静默不动。
 * `dir` 1 = 下一个，-1 = 上一个。
 */
export function stepSettingsSection(
  sections: SettingsSection[],
  activeId: string,
  dir: 1 | -1,
): SettingsSection | null {
  const idx = sections.findIndex(s => s.id === activeId);
  if (idx < 0) return null;
  return sections[idx + dir] ?? null;
}
