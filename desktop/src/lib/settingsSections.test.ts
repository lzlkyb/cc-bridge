import { describe, it, expect } from "vitest";
import { SETTINGS_SECTIONS, groupSettingsSections } from "./settingsSections";

/**
 * 左栏导航引入 group 分簇后（设计稿：设置页左侧导航-视觉语言对齐-方案ABC-设计稿.html），
 * 这些断言锁的是「簇边界会静默错掉」的契约——簇划错了只是细线悄悄跑偏，不报错、不崩，
 * 肉眼在 12 项里也很难看出来。
 */
describe("设置页导航数据", () => {
  it("id 不得重复", () => {
    // 重复 id 会让左栏 React key 重复；scrollspy 用的是 getElementById，还会命中错的卡片。
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("同 group 的项必须相邻（不允许 0,1,0 这种回跳）", () => {
    // groupSettingsSections 判定的是「相邻且同 group」。数据写成 0,1,0 会切出两个
    // group=0 的簇、白多一条细线，而不会报任何错。
    const seen = new Set<number>();
    let prevGroup: number | null = null;
    for (const s of SETTINGS_SECTIONS) {
      if (s.group === prevGroup) continue;
      expect(seen.has(s.group), `group ${s.group} 不连续（出现了两次）`).toBe(false);
      seen.add(s.group);
      prevGroup = s.group;
    }
  });

  it("防火墙与网络同簇，非 Windows 过滤掉它才不会改变簇数", () => {
    // 防火墙是 windowsOnly。它若被单独分一簇，macOS 上那一簇会整体消失，
    // 细线数量随平台变化——这是设计稿明确要避免的。
    const firewall = SETTINGS_SECTIONS.find((s) => s.windowsOnly);
    const network = SETTINGS_SECTIONS.find((s) => s.id === "set-network");
    expect(firewall).toBeTruthy();
    expect(firewall?.group).toBe(network?.group);
  });
});

describe("groupSettingsSections", () => {
  it("Windows 全量切成 5 簇（渲染成 4 条簇间细线）", () => {
    const groups = groupSettingsSections(SETTINGS_SECTIONS);
    expect(groups.map((g) => g.map((s) => s.label))).toEqual([
      ["关于"],
      ["网络", "防火墙", "安全", "外挂 MCP 桥"],
      ["备份与审计", "通知"],
      ["高级", "终端"],
      ["应用", "安装与快捷方式", "配置"],
    ]);
  });

  it("非 Windows 过滤掉防火墙后仍是 5 簇", () => {
    const groups = groupSettingsSections(SETTINGS_SECTIONS.filter((s) => !s.windowsOnly));
    expect(groups.length).toBe(5);
    expect(groups[1].map((s) => s.label)).toEqual(["网络", "安全", "外挂 MCP 桥"]);
  });

  it("空输入返回空数组（不抛错）", () => {
    expect(groupSettingsSections([])).toEqual([]);
  });

  it("只有一簇时只返回一簇（渲染层据此不画细线）", () => {
    expect(groupSettingsSections(SETTINGS_SECTIONS.slice(0, 1)).length).toBe(1);
  });
});
