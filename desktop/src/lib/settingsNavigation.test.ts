import { describe, it, expect } from "vitest";
import { settingsSectionForAnchor, searchSettings } from "./settingsNavigation";
import { SETTINGS_SECTIONS } from "./settingsSections";
import { SETTING_SEARCH_ITEMS } from "./settingsSearch";

describe("settings deep links", () => {
  it("routes every indexed setting to a category before locating its control", () => {
    for (const item of SETTING_SEARCH_ITEMS.filter(x => x.tab === "settings")) {
      expect(settingsSectionForAnchor(item.anchor!)).toBeTruthy();
    }
    expect(settingsSectionForAnchor("toggle-encoding")).toBe("set-advanced");
    expect(settingsSectionForAnchor("remote-tls")).toBe("set-security");
  });
  it("finds sub-settings and filters unsupported platform categories", () => {
    const available = SETTINGS_SECTIONS.filter(x => !x.windowsOnly).map(x => x.id);
    expect(searchSettings("GBK", available)[0].anchor).toBe("encoding");
    expect(searchSettings("证书", available)[0].sectionId).toBe("set-security");
    expect(searchSettings("netsh", available)).toHaveLength(0);
    expect(searchSettings("高级", available).length).toBeGreaterThan(0);
    expect(searchSettings("字体", available)[0].sectionId).toBe("set-terminal");
  });
});
