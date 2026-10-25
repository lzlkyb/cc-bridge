import { describe, expect, it, vi } from "vitest";
import {
  frecencyScore,
  preparePaletteItems,
  recentPaletteIds,
  recordPaletteUse,
  searchPalette,
  subsequenceHits,
} from "./paletteSearch";

/**
 * 检索内核的契约（设计稿《命令面板-拼音模糊与最近使用》）：
 * 三路命中与分数序、拼音注音的正确音节、frecency 的衰减与界内裁剪。
 * localStorage 在 node 环境用 stub（frecency 只依赖 getItem/setItem）。
 */

type Item = { id: string; label: string; keywords?: string };
const ITEMS: Item[] = [
  { id: "nav-settings", label: "前往：设置页", keywords: "settings 设置 偏好" },
  { id: "act-clearlog", label: "清空审计日志", keywords: "clear log 清理" },
  { id: "set-model", label: "设置：对话模型", keywords: "model 模型 llm" },
  { id: "act-server", label: "停止 MCP 服务" },
  { id: "nav-connect", label: "前往：连接页" },
];

describe("subsequenceHits", () => {
  it("保序贪心命中并返回下标；不命中返回 null", () => {
    expect(subsequenceHits("清空审计日志", "清日")).toEqual([0, 4]);
    expect(subsequenceHits("设置：对话模型", "mx")).toBeNull();
    expect(subsequenceHits("Stop MCP Service", "sms")).toEqual([0, 5, 9]);
  });
});

describe("searchPalette", () => {
  const prepared = preparePaletteItems(ITEMS);

  it("空查询：全量返回、零分、无命中标注", () => {
    const all = searchPalette(prepared, "  ");
    expect(all.map((m) => m.item.id)).toEqual(ITEMS.map((i) => i.id));
    expect(all.every((m) => m.score === 0 && m.labelHits.length === 0 && !m.pinyin)).toBe(true);
  });

  it("label 子串最优先，位置越靠前分越高（设置@0 压过 设置@3）", () => {
    const r = searchPalette(prepared, "设置");
    expect(r.map((m) => m.item.id)).toEqual(["set-model", "nav-settings"]);
  });

  it("拼音首字母命中「qk」→ 清空审计日志，注音标中 qing kong", () => {
    const r = searchPalette(prepared, "qk");
    const hit = r.find((m) => m.item.id === "act-clearlog");
    expect(hit).toBeTruthy();
    expect(hit!.labelHits).toEqual([]);
    expect(hit!.pinyin?.hitIdx).toEqual([0, 1]);
    expect(hit!.pinyin?.syllables[0]).toBe("qing");
  });

  it("拼音全拼连续命中「moxing」→ 设置：对话模型", () => {
    const r = searchPalette(prepared, "moxing");
    const hit = r.find((m) => m.item.id === "set-model");
    // syllables = [she, zhi, ：, dui, hua, mo, xing]
    expect(hit?.pinyin?.hitIdx).toEqual([5, 6]);
  });

  it("英文 keyword 命中仍在（旧能力不回退）", () => {
    const r = searchPalette(prepared, "model");
    expect(r.some((m) => m.item.id === "set-model")).toBe(true);
  });

  it("无命中返回空数组", () => {
    expect(searchPalette(prepared, "zzzz")).toEqual([]);
  });

  it("中文查询不走路音路（label 子串足够）", () => {
    const r = searchPalette(prepared, "日志");
    expect(r.map((m) => m.item.id)).toEqual(["act-clearlog"]);
  });
});

describe("frecency", () => {
  const store = new Map<string, string>();
  const storage: Storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };

  it("记录 → 最近使用按分数置顶，条目不存在时忽略", () => {
    vi.stubGlobal("localStorage", storage);
    store.clear();
    const now = Date.now();
    // act-server 用过 3 次（1 小时前），act-clearlog 用过 1 次（刚用）
    (globalThis as { __now?: number }).__now = now;
    recordPaletteUse("act-server");
    recordPaletteUse("act-server");
    recordPaletteUse("act-server");
    // 手写时间：直接改记录的 t 模拟「1 小时前用过 3 次」
    const raw = JSON.parse(store.get("ccbridge_palette_frecency")!);
    raw["act-server"].t = now - 3_600_000;
    store.set("ccbridge_palette_frecency", JSON.stringify(raw));
    recordPaletteUse("act-clearlog");

    const ids = recentPaletteIds(ITEMS, 5);
    expect(ids).toContain("act-clearlog");
    expect(ids).toContain("act-server");
    // 刚用 1 次 vs 一小时前用 3 次：1/(0+2)=0.5 > 3/(1+2)=1.0？不 —— 3 次的更高。
    expect(ids[0]).toBe("act-server");
    // 已删除 / 不存在的 id 不出现
    expect(recentPaletteIds([{ id: "only", label: "x" }])).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("分数随时间衰减、随次数增长", () => {
    const now = Date.now();
    const fresh = frecencyScore({ n: 1, t: now }, now);
    const stale = frecencyScore({ n: 1, t: now - 7 * 3_600_000 }, now);
    const twice = frecencyScore({ n: 2, t: now }, now);
    expect(fresh).toBeGreaterThan(stale);
    expect(twice).toBeGreaterThan(fresh);
  });
});
