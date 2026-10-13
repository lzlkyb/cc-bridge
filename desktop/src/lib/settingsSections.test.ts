import { describe, it, expect } from "vitest";
import { SETTINGS_SECTIONS, SETTINGS_CLUSTERS, groupSettingsSections } from "./settingsSections";

/**
 * 左栏导航引入簇标题后（设计稿：设置页-信息架构重排-设计稿.html），这些断言
 * 锁的是「簇边界/标题会静默错掉」的契约——簇划错了只是细线与标题悄悄跑偏，
 * 不报错、不崩，肉眼在 13 项里也很难看出来。
 */
describe("设置页导航数据", () => {
  it("id 不得重复", () => {
    // 重复 id 会让左栏 React key 重复；scrollspy 用的是 getElementById，还会命中错的卡片。
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("同 group 的项必须相邻（不允许 0,1,0 这种回跳）", () => {
    // groupSettingsSections 判定的是「相邻且同 group」。数据写成 0,1,0 会切出两个
    // 同 group 的簇、白多一条细线，而不会报任何错。
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

  it("每个用到的 group 都有簇元数据（漏登记的簇没有标题、渲染层不报错但静默缺标题）", () => {
    const used = new Set(SETTINGS_SECTIONS.map((s) => s.group));
    const declared = new Set(SETTINGS_CLUSTERS.map((c) => c.group));
    for (const g of used) expect(declared.has(g), `group ${g} 缺 SETTINGS_CLUSTERS 登记`).toBe(true);
  });

  it("簇标题全量锁定（信息架构重排的核心契约）", () => {
    expect(SETTINGS_CLUSTERS.map((c) => c.title ?? null)).toEqual([
      null, // 关于独立置顶，无标题
      "开始使用",
      "每天会用",
      "记录与回溯",
      "终端与应用",
      "高级与配置",
    ]);
  });

  it("「通知」与「Token 用量」不撞图标", () => {
    const notify = SETTINGS_SECTIONS.find((s) => s.id === "set-notify");
    const token = SETTINGS_SECTIONS.find((s) => s.id === "set-tokenusage");
    expect(notify?.icon).not.toBe(token?.icon);
  });

  it("「安装与快捷方式」在「关于」之后（首次接入第一站，重排核心）", () => {
    const order = SETTINGS_SECTIONS.map((s) => s.id);
    expect(order.indexOf("set-install")).toBe(1);
    expect(order[0]).toBe("set-about");
  });
});

describe("groupSettingsSections", () => {
  it("Windows 全量切成 6 簇（关于 + 5 个带标题簇），顺序与设计稿一致", () => {
    const groups = groupSettingsSections(SETTINGS_SECTIONS);
    expect(groups.map((g) => g.items.map((s) => s.label))).toEqual([
      ["关于"],
      ["安装与快捷方式", "网络", "防火墙"],
      ["安全", "外挂 MCP 桥"],
      ["备份与审计", "Token 用量", "通知"],
      ["终端", "应用"],
      ["高级", "配置"],
    ]);
    expect(groups.map((g) => g.title ?? null)).toEqual([
      null,
      "开始使用",
      "每天会用",
      "记录与回溯",
      "终端与应用",
      "高级与配置",
    ]);
  });

  it("非 Windows 过滤掉防火墙后仍是 6 簇、标题不变", () => {
    const groups = groupSettingsSections(SETTINGS_SECTIONS.filter((s) => !s.windowsOnly));
    expect(groups.length).toBe(6);
    expect(groups[1].items.map((s) => s.label)).toEqual(["安装与快捷方式", "网络"]);
    expect(groups[1].title).toBe("开始使用");
  });

  it("空输入返回空数组（不抛错）", () => {
    expect(groupSettingsSections([])).toEqual([]);
  });

  it("只有一簇时只返回一簇（渲染层据此不画细线）", () => {
    expect(groupSettingsSections(SETTINGS_SECTIONS.slice(0, 1)).length).toBe(1);
  });
});
