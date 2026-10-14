import { describe, it, expect } from "vitest";
import type { IBuffer } from "@xterm/xterm";
import { MAX_HITS, searchAll, searchBuffer } from "./terminalGlobalSearch";

/**
 * 假缓冲区：只需要 `length` + `getLine`，够 searchBuffer 用。
 * `translateToString(true)` 要按 xterm 的口径修剪行尾空白——不模拟的话
 * 「空行跳过」这类用例会失真（xterm 里满屏的行尾填充空格会被 trim 成空串）。
 */
function fakeBuffer(lines: string[]): IBuffer {
  return {
    length: lines.length,
    getLine: (n: number) =>
      lines[n] === undefined
        ? undefined
        : {
            translateToString: (trim?: boolean) =>
              trim ? lines[n].replace(/\s+$/, "") : lines[n],
          },
  } as unknown as IBuffer;
}

const NOOP = { caseSensitive: false, regex: false };

describe("searchBuffer（单缓冲区）", () => {
  const lines = ["$ npm run build", "vite v5 building for production", "ERROR: module not found", "done"];

  it("默认不区分大小写：查 error 能命中大写的 ERROR 行", () => {
    expect(searchBuffer("s1", fakeBuffer(lines), "error", NOOP).map((h) => h.line)).toEqual([2]);
  });

  it("区分大小写时同一条查询不命中", () => {
    expect(searchBuffer("s1", fakeBuffer(lines), "error", { ...NOOP, caseSensitive: true })).toEqual([]);
  });

  it("命中行返回的是**缓冲区绝对行号**与整行文本", () => {
    const hits = searchBuffer("s1", fakeBuffer(lines), "ERROR", NOOP);
    expect(hits).toEqual([
      { sessionId: "s1", line: 2, text: "ERROR: module not found" },
    ]);
  });

  it("正则模式生效", () => {
    const hits = searchBuffer("s1", fakeBuffer(lines), "^vite v\\d", { ...NOOP, regex: true });
    expect(hits.map((h) => h.line)).toEqual([1]);
  });

  it("正则没写完（非法）返回空，不抛错——用户还在敲", () => {
    expect(() => searchBuffer("s1", fakeBuffer(lines), "([", { ...NOOP, regex: true })).not.toThrow();
    expect(searchBuffer("s1", fakeBuffer(lines), "([", { ...NOOP, regex: true })).toEqual([]);
  });

  it("正则里的 g 会跳行这类坑不存在（内部不传 g 标志）", () => {
    const buf = fakeBuffer(["aaa", "aaa", "aaa"]);
    expect(searchBuffer("s1", buf, "a", { ...NOOP, regex: true }).length).toBe(3);
  });

  it("空查询返回空（不是「匹配所有行」）", () => {
    expect(searchBuffer("s1", fakeBuffer(lines), "", NOOP)).toEqual([]);
  });

  it("空白行跳过：行尾填充空格被 trim 后为空串的行不算命中", () => {
    const buf = fakeBuffer(["hit here", "        ", "", "hit again"]);
    // 查「三个连续空格」：只有那行纯空白能中，而它 trim 后是空串、已被跳过。
    expect(searchBuffer("s1", buf, "   ", NOOP)).toEqual([]);
    expect(searchBuffer("s1", buf, "hit", NOOP).map((h) => h.line)).toEqual([0, 3]);
  });

  it("limit 生效（只扫到够数就停）", () => {
    const buf = fakeBuffer(Array.from({ length: 50 }, (_, i) => `line ${i} hit`));
    expect(searchBuffer("s1", buf, "hit", NOOP, 3).length).toBe(3);
    // limit <= 0 直接不扫
    expect(searchBuffer("s1", buf, "hit", NOOP, 0)).toEqual([]);
  });

  it("getLine 返回 undefined（越界）时不崩", () => {
    const buf = { length: 3, getLine: () => undefined } as unknown as IBuffer;
    expect(searchBuffer("s1", buf, "x", NOOP)).toEqual([]);
  });
});

describe("searchAll（跨会话）", () => {
  const a = fakeBuffer(["alpha hit", "nothing"]);
  const b = fakeBuffer(["nothing", "beta hit", "gamma hit"]);

  it("按会话顺序汇总，条目标出各自 sessionId", () => {
    const hits = searchAll(
      [
        { sessionId: "s1", buffer: a },
        { sessionId: "s2", buffer: b },
      ],
      "hit",
      NOOP,
    );
    expect(hits.map((h) => `${h.sessionId}:${h.line}`)).toEqual(["s1:0", "s2:1", "s2:2"]);
  });

  it("总条数受 limit 约束，且额度用完后不再扫后续会话", () => {
    const hits = searchAll(
      [
        { sessionId: "s1", buffer: a },
        { sessionId: "s2", buffer: b },
      ],
      "hit",
      NOOP,
      1,
    );
    expect(hits).toEqual([{ sessionId: "s1", line: 0, text: "alpha hit" }]);
  });

  it("无源时返回空数组", () => {
    expect(searchAll([], "hit", NOOP)).toEqual([]);
  });

  it("上限常量是个正数（面板文案依赖它）", () => {
    expect(MAX_HITS).toBeGreaterThan(0);
  });
});
