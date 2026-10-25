import { describe, expect, it } from "vitest";
import { highlightSegments, searchChunks } from "./ccHighlight";

describe("searchChunks", () => {
  it("空查询返回空数组", () => {
    expect(searchChunks("")).toEqual([]);
    expect(searchChunks("   ")).toEqual([]);
  });

  it("不足 3 字符原样一片", () => {
    expect(searchChunks("登")).toEqual(["登"]);
    expect(searchChunks("登录")).toEqual(["登录"]);
  });

  it("3 字符起按滑窗拆（互相重叠）", () => {
    expect(searchChunks("abc")).toEqual(["abc"]);
    expect(searchChunks("abcd")).toEqual(["abc", "bcd"]);
    // 与 Rust 侧 search_chunks 同一批例子。
    expect(searchChunks("修复登录")).toEqual(["修复登", "复登录"]);
  });

  it("按字符不按字节：中文不会被劈开", () => {
    // 「修复」两字 6 字节，按字节切会得到半个字。
    expect(searchChunks("修复")).toEqual(["修复"]);
    expect(searchChunks("修复登").every((c) => c.length === 3)).toBe(true);
  });
});

describe("highlightSegments", () => {
  it("空查询或空文本整段不高亮", () => {
    expect(highlightSegments("修复登录页", "")).toEqual([{ text: "修复登录页", hit: false }]);
    expect(highlightSegments("", "修复")).toEqual([{ text: "", hit: false }]);
  });

  it("无命中整段不高亮", () => {
    expect(highlightSegments("终端配色", "修复")).toEqual([{ text: "终端配色", hit: false }]);
  });

  it("连续命中合并成一整片（相邻 chunk 首尾重叠）", () => {
    // 「修复登录」→ 修复登 / 复登录，位置相差一字，必须并成一段。
    const segs = highlightSegments("修复登录页", "修复登录");
    expect(segs).toEqual([
      { text: "修复登录", hit: true },
      { text: "页", hit: false },
    ]);
  });

  it("分散的片段各自高亮，中间原文保留", () => {
    // 「修复登录页」→ 修复登 / 复登录（标题里）/ 登录页（文本别处）：
    // 只涂出现的窗口，没出现的字不涂。
    const segs = highlightSegments("修复登录 · 登录页备份", "修复登录页");
    expect(segs).toEqual([
      { text: "修复登录", hit: true },
      { text: " · ", hit: false },
      { text: "登录页", hit: true },
      { text: "备份", hit: false },
    ]);
  });

  it("短查询整串高亮", () => {
    expect(highlightSegments("修复了登录页", "登录")).toEqual([
      { text: "修复了", hit: false },
      { text: "登录", hit: true },
      { text: "页", hit: false },
    ]);
  });

  it("大小写不敏感（与 SQLite 的 ASCII LIKE 对齐）", () => {
    const segs = highlightSegments("Fix the Login Bug", "login");
    expect(segs).toEqual([
      { text: "Fix the ", hit: false },
      { text: "Login", hit: true },
      { text: " Bug", hit: false },
    ]);
  });

  it("同一片段多次出现全部高亮", () => {
    const segs = highlightSegments("aaa", "aa");
    expect(segs).toEqual([{ text: "aaa", hit: true }]);
  });

  it("切回的文本拼起来必须等于原文", () => {
    const text = "修复登录页面的那些事儿，登录录页备份";
    const segs = highlightSegments(text, "修复登录页");
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });
});
