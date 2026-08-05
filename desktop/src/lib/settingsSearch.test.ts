import { describe, it, expect } from "vitest";
import { SETTING_SEARCH_ITEMS } from "./settingsSearch";

/**
 * 这些不是“测数据长得对不对”，而是锁住几条真会静默坏掉的契约。
 */
describe("设置项搜索索引", () => {
  it("id 不得重复", () => {
    // 重复 id 会让 React key 重复，并且面板里的 busyId 会同时命中两行。
    const ids = SETTING_SEARCH_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每一条都必须有 tab，否则回车后什么都不会发生", () => {
    // CommandPalette.selectItem 的分支是 `if (item.tab) … else if (item.run) …`，
    // 这些条目没有 run；缺 tab 就是一个点了没反应的死条目。
    for (const item of SETTING_SEARCH_ITEMS) {
      expect(item.tab, `${item.id} 缺 tab`).toBeTruthy();
    }
  });

  it("设置页的条目必须带 anchor（否则只能跳到页顶）", () => {
    // 卡片从 8 张变 10 张后，跳到页顶等于还要自己滚一遍，搜索就失去了意义。
    // 安全页（tab=security）尚未重构、暂无卡级锚点，故不要求。
    for (const item of SETTING_SEARCH_ITEMS.filter((i) => i.tab === "settings")) {
      expect(item.anchor, `${item.id} 缺 anchor`).toBeTruthy();
    }
  });

  it("关键词要能搜到那些标题里没有的词", () => {
    // 这条锁的是 keywords 的**存在意义**：用户想到的词往往不是标题。
    // 匹配逻辑与 CommandPalette 的 filtered 一致（label + keywords，小写 includes）。
    const hit = (q: string) =>
      SETTING_SEARCH_ITEMS.filter(
        (i) =>
          i.label.toLowerCase().includes(q) ||
          (i.keywords ? i.keywords.toLowerCase().includes(q) : false),
      );
    // “rce”不在任何标题里，但必须能找到命令执行
    expect(hit("rce").some((i) => i.id === "set-shell")).toBe(true);
    // “gbk”同理 → 读取编码自适应
    expect(hit("gbk").some((i) => i.id === "set-encoding")).toBe(true);
    // “端口”→ 网络卡；“7823”也要能命中
    expect(hit("端口").some((i) => i.id === "set-network")).toBe(true);
    expect(hit("7823").some((i) => i.id === "set-network")).toBe(true);
  });
});
