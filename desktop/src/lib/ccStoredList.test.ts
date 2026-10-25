import { describe, expect, it } from "vitest";
import { agoText, archivedOnly, filterStored } from "./ccStoredList";
import type { CcStoredSummary } from "./ccEventTypes";

const row = (patch: Partial<CcStoredSummary> = {}): CcStoredSummary => ({
  rowId: 1,
  connectionId: "",
  sessionId: "s-1",
  cwd: "D:/proj",
  title: "改 read_files 上限",
  titleLocked: false,
  preview: "好，我改一下",
  model: null,
  permissionMode: null,
  messageCount: 3,
  updatedAt: 1_700_000_000,
  archivedAt: null,
  dropped: 0,
  ...patch,
});

describe("agoText", () => {
  const now = 1_700_000_000_000;

  it("一分钟以内是「刚刚」", () => {
    expect(agoText(now / 1000 - 10, now)).toBe("刚刚");
    expect(agoText(now / 1000 + 60, now)).toBe("刚刚"); // 未来时间（时钟偏差）也算刚刚
  });

  it("分钟 / 小时 / 天三档", () => {
    expect(agoText(now / 1000 - 5 * 60, now)).toBe("5 分钟前");
    expect(agoText(now / 1000 - 3 * 3600, now)).toBe("3 小时前");
    expect(agoText(now / 1000 - 2 * 86400, now)).toBe("2 天前");
  });

  it("超过一周给日期（「37 天前」要用户自己减）", () => {
    const t = new Date("2026-09-30T10:00:00").getTime();
    expect(agoText(t / 1000, new Date("2026-10-25T10:00:00").getTime())).toBe("9月30日");
    // 跨年带上年份
    expect(agoText(t / 1000, new Date("2027-01-05T10:00:00").getTime())).toBe("2026年9月30日");
  });

  it("毫秒戳也能认（后端给秒，但手写数据容易混）", () => {
    expect(agoText(now / 1000 - 120, now)).toBe("2 分钟前");
    expect(agoText(now - 120_000, now)).toBe("2 分钟前");
  });
});

describe("filterStored", () => {
  it("已经打开的（按 CC session id 对账）不再摆一遍", () => {
    const rows = [row({ rowId: 1, sessionId: "s-1" }), row({ rowId: 2, sessionId: "s-2" })];
    const out = filterStored(rows, { cliIds: new Set(["s-1"]) });
    expect(out.map((r) => r.rowId)).toEqual([2]);
  });

  /// 刚恢复完的那一瞬间还没有 `Init` 事件（sessionId 为空），只能靠行号对账。
  /// 缺了它，已打开的那条会在历史区短暂再出现，用户点它就会开出重复的一条。
  it("按行号对账：session id 还没到也能立刻摘掉已打开的那条", () => {
    const rows = [row({ rowId: 7, sessionId: null })];
    expect(filterStored(rows, { rowIds: new Set([7]) })).toHaveLength(0);
    expect(filterStored(rows, { rowIds: new Set([8]) })).toHaveLength(1);
  });

  it("没有 session id 的老行不会被误滤（对不上就不滤）", () => {
    const out = filterStored([row({ sessionId: null })], { cliIds: new Set(["s-1"]) });
    expect(out).toHaveLength(1);
  });

  it("既没标题又没轮数的空行不摆", () => {
    const out = filterStored([row({ title: null, messageCount: 0 })], {});
    expect(out).toHaveLength(0);
  });

  it("搜索词匹配标题 / 正文预览 / 目录", () => {
    const rows = [
      row({ rowId: 1, title: "改 read_files 上限" }),
      row({ rowId: 2, title: "别的事", preview: "顺手修个 read_files 的坑" }),
      row({ rowId: 3, title: "另一件", cwd: "D:/read_files-repo" }),
      row({ rowId: 4, title: "无关" }),
    ];
    expect(filterStored(rows, {}, "READ_FILES").map((r) => r.rowId)).toEqual([1, 2, 3]);
  });

  it("空搜索词 = 不过滤", () => {
    expect(filterStored([row(), row({ rowId: 2 })], {}, "   ")).toHaveLength(2);
  });

  it("已归档的不在正常历史里出现", () => {
    const rows = [row({ rowId: 1 }), row({ rowId: 2, archivedAt: 1_700_000_100 })];
    expect(filterStored(rows, {}).map((r) => r.rowId)).toEqual([1]);
  });
});

describe("archivedOnly", () => {
  it("只摆归档的，且不受「已打开」影响（归档视图是独立的第二次机会）", () => {
    const rows = [
      row({ rowId: 1 }),
      row({ rowId: 2, archivedAt: 1_700_000_100 }),
      row({ rowId: 3, archivedAt: 1_700_000_200 }),
    ];
    expect(archivedOnly(rows).map((r) => r.rowId)).toEqual([2, 3]);
    expect(archivedOnly([])).toEqual([]);
  });
});
