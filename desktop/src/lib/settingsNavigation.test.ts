import { describe, it, expect } from "vitest";
import { settingsSectionForAnchor, searchSettings, stepSettingsSection } from "./settingsNavigation";
import { SETTINGS_SECTIONS } from "./settingsSections";
import { SETTINGS_CATEGORIES } from "./settingsCategories";
import { SETTING_SEARCH_ITEMS } from "./settingsSearch";

describe("settings deep links", () => {
  it("routes every indexed setting to a category before locating its control", () => {
    for (const item of SETTING_SEARCH_ITEMS.filter(x => x.tab === "settings")) {
      expect(settingsSectionForAnchor(item.anchor!)).toBeTruthy();
    }
    expect(settingsSectionForAnchor("toggle-encoding")).toBe("set-files");
    expect(settingsSectionForAnchor("remote-tls")).toBe("set-network");
    expect(settingsSectionForAnchor("set-config")).toBe("set-data");
    expect(settingsSectionForAnchor("set-install")).toBe("set-app");
  });
  it("finds sub-settings and filters unsupported platform categories", () => {
    const available = SETTINGS_CATEGORIES.map(x => x.id);
    expect(searchSettings("GBK", available)[0].anchor).toBe("encoding");
    expect(searchSettings("证书", available)[0].sectionId).toBe("set-network");
    expect(searchSettings("netsh", available)).toHaveLength(0);
    expect(searchSettings("netsh", available, "windows")[0].anchor).toBe("set-firewall");
    expect(searchSettings("字号", available)[0].anchor).toBe("terminal-size");
    expect(searchSettings("内存", available)[0].sectionId).toBe("set-app");
    expect(searchSettings("字体", available)[0].sectionId).toBe("set-terminal");
  });
});

describe("stepSettingsSection (滚轮换区)", () => {
  const available = SETTINGS_SECTIONS.filter(x => !x.windowsOnly).map(x => x.id);
  const visible = SETTINGS_SECTIONS.filter(x => available.includes(x.id));

  it("steps to the next/previous section in navigation order", () => {
    expect(stepSettingsSection(visible, "set-about", 1)?.id).toBe("set-install");
    expect(stepSettingsSection(visible, "set-install", -1)?.id).toBe("set-about");
  });

  it("skips windows-only cards on non-Windows filtering", () => {
    // 防火墙（windowsOnly）不在 visible 里 ⇒ 网络(1) 的下一个是 安全(3)。
    expect(stepSettingsSection(visible, "set-network", 1)?.id).toBe("set-security");
  });

  it("returns null at both endpoints", () => {
    expect(stepSettingsSection(visible, visible[0]!.id, -1)).toBeNull();
    expect(stepSettingsSection(visible, visible[visible.length - 1]!.id, 1)).toBeNull();
  });

  it("returns null when activeId is not in the list (scrollspy transition frame)", () => {
    expect(stepSettingsSection(visible, "set-nonexistent", 1)).toBeNull();
  });
});
